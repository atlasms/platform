// Transcode progress (EP-16.4): announced on `live.<channel>.transcode.progress` — never the
// outbox — as a valid envelope, throttled per job, dropped quietly when it cannot be sent; and the
// input's duration asked for first, since without it there is no percentage to announce (#349
// shipped without asking, and the bar sat at 0 until it jumped to 100).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteOutboxStore } from '@atlas/data';
import { ulid, validateMessage, type Envelope, type EventPayloads } from '@atlas/contracts';
import type { Message } from '@atlas/messaging';
import { compile } from '@atlas/policy';
import { fakeTranscoder, MtsService, sqliteJobStore } from '../src/index.ts';

const CH = 'ch12';
const caller = {
  userId: 'u',
  channelId: CH,
  policy: compile({
    subjectId: 'u',
    permVersion: 1,
    rules: [{ id: 'r', permissions: ['asset:read', 'asset:write'] }],
  }),
};

async function harness(
  options: { progressIntervalMs?: number; publishLive?: (m: Message) => Promise<void> } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'mts-progress-'));
  await mkdir(join(root, 'inputs'), { recursive: true });
  const input = async (name: string) => {
    const path = join(root, 'inputs', name);
    await writeFile(path, 'master');
    return path;
  };
  const store = sqliteJobStore();
  const sent: Message[] = [];
  const service = new MtsService({
    store,
    transcoder: fakeTranscoder(),
    workRoot: root,
    now: () => new Date('2026-09-25T10:00:00.000Z'),
    publishLive:
      options.publishLive ??
      (async (m) => {
        sent.push(m);
      }),
    ...(options.progressIntervalMs !== undefined
      ? { progressIntervalMs: options.progressIntervalMs }
      : {}),
  });
  const outbox = new SqliteOutboxStore(store.db);
  return { root, input, store, service, sent, outbox };
}

test('progress goes out on live.<channel>.transcode.progress as a valid envelope — and never through the outbox', async () => {
  const h = await harness({ progressIntervalMs: 0 });
  try {
    const job = await h.service.enqueue(caller, {
      assetId: ulid(),
      presetIds: ['proxy', 'thumbnail', 'broadcast'],
      inputPath: await h.input('clip.mp4'),
    });
    assert.equal(await h.service.runNext(), 'completed');

    assert.ok(h.sent.length > 0, 'progress was announced');
    for (const m of h.sent) {
      assert.equal(m.subject, `live.${CH}.transcode.progress`);
      assert.ok(validateMessage(m.body as Envelope).valid, 'a valid envelope with a valid payload');
      const env = m.body as Envelope<EventPayloads['transcode.progress']>;
      assert.equal(env.type, 'transcode.progress');
      assert.equal(env.payload.jobId, job.id);
      assert.equal(env.payload.speed, 2.5, 'the realtime factor rides along');
    }
    // Scaled across the job's presets, and only ever forward.
    const percents = h.sent.map((m) => (m.body as Envelope<{ percent: number }>).payload.percent);
    assert.deepEqual(percents, [33, 67, 100]);

    // The outbox carries the job's events and audit records — and no progress, ever.
    const types = (await h.outbox.listUnsent(1000)).map((r) => (r.message.body as Envelope).type);
    assert.ok(types.includes('transcode.completed'));
    assert.ok(!types.includes('transcode.progress'));
  } finally {
    await rm(h.root, { recursive: true, force: true });
  }
});

test('throttled per job: the first report always goes, the rest wait out the interval', async () => {
  const h = await harness({ progressIntervalMs: 1_000 });
  try {
    await h.service.enqueue(caller, {
      assetId: ulid(),
      presetIds: ['proxy', 'thumbnail', 'broadcast'],
      inputPath: await h.input('clip.mp4'),
    });
    // The clock does not move during the run, so 67 and 100 arrive inside the first report's
    // second and are held back; a job short enough to end within one still said something.
    await h.service.runNext();
    assert.deepEqual(
      h.sent.map((m) => (m.body as Envelope<{ percent: number }>).payload.percent),
      [33],
    );
  } finally {
    await rm(h.root, { recursive: true, force: true });
  }
});

test('an input whose duration cannot be read: no percentage, no announcement — and the job still completes', async () => {
  const h = await harness({ progressIntervalMs: 0 });
  try {
    const job = await h.service.enqueue(caller, {
      assetId: ulid(),
      presetIds: ['proxy'],
      inputPath: await h.input('noduration.mp4'),
    });
    assert.equal(await h.service.runNext(), 'completed');
    assert.equal(h.sent.length, 0);
    assert.equal((await h.store.job(job.id))?.state, 'completed');
  } finally {
    await rm(h.root, { recursive: true, force: true });
  }
});

test('a publish that fails is dropped — progress is never a reason for a job to fail', async () => {
  const h = await harness({
    progressIntervalMs: 0,
    publishLive: async () => {
      throw new Error('broker away');
    },
  });
  try {
    const job = await h.service.enqueue(caller, {
      assetId: ulid(),
      presetIds: ['proxy'],
      inputPath: await h.input('clip.mp4'),
    });
    assert.equal(await h.service.runNext(), 'completed');
    assert.equal((await h.store.job(job.id))?.state, 'completed');
  } finally {
    await rm(h.root, { recursive: true, force: true });
  }
});

test('the row carries the percentage too, for whoever polls instead of listening', async () => {
  const h = await harness({ progressIntervalMs: 0 });
  try {
    const job = await h.service.enqueue(caller, {
      assetId: ulid(),
      presetIds: ['proxy'],
      inputPath: await h.input('slow.mp4'),
    });
    const stop = new AbortController();
    const run = h.service.runNext(stop.signal);
    // The slow fake reports 10% and waits to be cancelled; the row should show it by then.
    for (let i = 0; i < 100 && ((await h.store.job(job.id))?.percent ?? 0) === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal((await h.store.job(job.id))?.percent, 10);
    stop.abort();
    assert.equal(await run, 'cancelled');
  } finally {
    await rm(h.root, { recursive: true, force: true });
  }
});
