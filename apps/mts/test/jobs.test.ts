// The command subscription and the worker loop (EP-16.1/16.2), over a real broker double: a
// `transcode.job.create` becomes a queued row and is acknowledged; a command MTS cannot honour is
// thrown to the broker — retried, then dead-lettered — never acked and lost; and the loop drains
// the queue, then stops when the pod does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEnvelope, ulid } from '@atlas/contracts';
import { InMemoryBroker } from '@atlas/messaging';
import { compile } from '@atlas/policy';
import {
  fakeTranscoder,
  JOB_CREATE_PATTERN,
  MtsService,
  runWorker,
  sqliteJobStore,
  startJobConsumer,
  type RunOutcome,
} from '../src/index.ts';

const CH = 'ch12';

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'mts-jobs-'));
  await mkdir(join(root, 'inputs'), { recursive: true });
  const input = join(root, 'inputs', 'clip.mxf');
  await writeFile(input, 'master');
  const store = sqliteJobStore();
  const service = new MtsService({ store, transcoder: fakeTranscoder(), workRoot: root });
  const bus = new InMemoryBroker();
  const publish = (payload: Record<string, unknown>) => {
    const envelope = buildEnvelope({
      type: 'transcode.job.create',
      channelId: CH,
      payload,
      actor: { kind: 'service', id: 'bms' },
    });
    return bus.publish({
      id: envelope.messageId,
      subject: `atlas.${CH}.transcode.job.create`,
      body: envelope,
    });
  };
  return {
    root,
    input,
    store,
    service,
    bus,
    publish,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('the subscription pattern is every channel’s command, and nothing else', () => {
  assert.equal(JOB_CREATE_PATTERN, 'atlas.*.transcode.job.create');
});

test('a command over the broker becomes a queued job; one MTS cannot honour is dead-lettered, not lost', async () => {
  const h = await harness();
  try {
    const queued: string[] = [];
    const refused: string[] = [];
    startJobConsumer({
      broker: h.bus,
      service: h.service,
      maxAttempts: 2,
      onQueued: (subject) => queued.push(subject),
      onError: (err) => refused.push((err as Error).message),
    });

    await h.publish({ assetId: ulid(), presetIds: ['proxy'], inputPath: h.input });
    assert.equal(queued.length, 1);
    assert.equal((await h.store.jobs({ channelId: CH }))[0]?.state, 'queued');

    // An unknown preset: thrown on every attempt, then parked where `scripts/dlq.mjs` shows it.
    await h.publish({ assetId: ulid(), presetIds: ['hologram'], inputPath: h.input });
    assert.equal(refused.length, 2, 'retried up to maxAttempts');
    assert.equal(h.bus.deadLetters.length, 1);
    assert.equal((await h.store.jobs({ channelId: CH })).length, 1, 'and nothing was written');
  } finally {
    await h.cleanup();
  }
});

test('the worker drains the queue one job at a time, and stops when the signal aborts', async () => {
  const h = await harness();
  try {
    const caller = {
      userId: 'u',
      channelId: CH,
      policy: compile({
        subjectId: 'u',
        permVersion: 1,
        rules: [{ id: 'r', permissions: ['asset:read', 'asset:write'] }],
      }),
    };
    const a = await h.service.enqueue(caller, {
      assetId: ulid(),
      presetIds: ['proxy'],
      inputPath: h.input,
    });
    const b = await h.service.enqueue(caller, {
      assetId: ulid(),
      presetIds: ['thumbnail'],
      inputPath: h.input,
    });

    const stop = new AbortController();
    const outcomes: RunOutcome[] = [];
    const done = runWorker({
      service: h.service,
      signal: stop.signal,
      idleMs: 5,
      onRun: (outcome) => {
        outcomes.push(outcome);
        // Two jobs, then idle: that is the queue drained.
        if (outcome === 'idle') stop.abort();
      },
    });
    await done;
    assert.deepEqual(outcomes, ['completed', 'completed', 'idle']);
    assert.equal((await h.store.job(a.id))?.state, 'completed');
    assert.equal((await h.store.job(b.id))?.state, 'completed');
  } finally {
    await h.cleanup();
  }
});
