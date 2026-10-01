// MTS with HSM (EP-14.7; ADR-0009): every rendition is pushed to HSM, signed over the checksum MTS
// computed, and its path becomes HSM's; the local output was scratch and is removed. A job may take
// its input from HSM — fetched to scratch at run time, removed after. HSM failing is a tool fault,
// retried; an `inputFile` job with no HSM configured is refused before it is queued.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEnvelope, ulid, type Envelope, type EventPayloads } from '@atlas/contracts';
import { InMemoryBroker, OutboxRelay } from '@atlas/messaging';
import { SqliteOutboxStore } from '@atlas/data';
import { compile } from '@atlas/policy';
import {
  fakeTranscoder,
  memoryFileStore,
  MtsService,
  sqliteJobStore,
  type FileStore,
  type ServiceCaller,
} from '../src/index.ts';

const CH = 'ch12';
const caller: ServiceCaller = {
  userId: 'u1',
  channelId: CH,
  policy: compile({
    subjectId: 'u1',
    permVersion: 1,
    rules: [{ id: 'r', permissions: ['asset:read', 'asset:write'] }],
    roles: [],
    groups: [],
  }),
};

async function harness(files?: FileStore) {
  const root = await mkdtemp(join(tmpdir(), 'mts-hsm-'));
  await mkdir(join(root, 'samples'), { recursive: true });
  await writeFile(join(root, 'samples', 'clip.mp4'), 'sample');
  const store = sqliteJobStore();
  const service = new MtsService({
    store,
    transcoder: fakeTranscoder(),
    workRoot: root,
    retryBaseMs: 0,
    ...(files !== undefined ? { files } : {}),
  });
  const broker = new InMemoryBroker();
  const relay = new OutboxRelay(new SqliteOutboxStore(store.db), broker);
  const drain = async (): Promise<Envelope[]> => {
    await relay.drain();
    return broker.published.map((m) => m.body as Envelope);
  };
  return { root, service, store, drain, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const walk = async (d: string): Promise<string[]> => {
  const out: string[] = [];
  for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory()) out.push(...(await walk(join(d, e.name))));
    else out.push(join(d, e.name));
  }
  return out;
};

test('every rendition goes to HSM: its path is HSM’s, its checksum MTS’s, and the work area keeps nothing', async () => {
  const hsm = memoryFileStore();
  const h = await harness(hsm);
  try {
    const assetId = ulid();
    await h.service.enqueue(caller, {
      assetId,
      presetIds: ['proxy', 'thumbnail'],
      inputPath: 'samples/clip.mp4',
    });
    assert.equal(await h.service.runNext(), 'completed');
    const completed = (await h.drain()).find((e) => e.type === 'transcode.completed')!
      .payload as unknown as EventPayloads['transcode.completed'];
    assert.deepEqual(
      completed.renditions.map((r) => [r.kind, r.path.startsWith(`${CH}/${assetId}/${r.kind}/`)]),
      [
        ['proxy', true],
        ['thumbnail', true],
      ],
    );
    for (const r of completed.renditions) {
      const held = hsm.files.get(`${assetId}/${r.kind}/`)!;
      assert.equal(createHash('sha256').update(held.bytes).digest('hex'), r.checksum.value);
      assert.equal(held.meta.profile, r.kind === 'proxy' ? 'proxy' : 'thumbnail');
    }
    assert.deepEqual(await walk(join(h.root, 'renditions')), [], 'scratch, removed once placed');
  } finally {
    await h.cleanup();
  }
});

test('an input from HSM: fetched to scratch at run time, transcoded, and the scratch copy removed', async () => {
  const hsm = memoryFileStore();
  const h = await harness(hsm);
  try {
    const assetId = ulid();
    const original = join(h.root, 'original.mxf');
    await writeFile(original, 'the master, in HSM');
    await hsm.place(
      { channelId: CH, assetId, kind: 'original', jobId: ulid(), profile: 'ingest' },
      original,
      createHash('sha256').update('the master, in HSM').digest('hex'),
    );
    const job = await h.service.enqueue(caller, {
      assetId,
      presetIds: ['proxy'],
      inputFile: { kind: 'original' },
    });
    assert.ok(job.inputPath.includes(join('inputs', job.id)), 'scratch, named by the job');
    assert.equal(await h.service.runNext(), 'completed');
    assert.ok(hsm.files.has(`${assetId}/proxy/`));
    assert.deepEqual(await walk(join(h.root, 'inputs')), []);
  } finally {
    await h.cleanup();
  }
});

test('HSM away is a tool fault — retried, not a refusal; an inputFile with no HSM, or two inputs, is a 422', async () => {
  const failing: FileStore = {
    place: () => Promise.reject(new Error('connect ECONNREFUSED hsm:3000')),
    fetch: () => Promise.reject(new Error('connect ECONNREFUSED hsm:3000')),
  };
  const h = await harness(failing);
  try {
    const job = await h.service.enqueue(caller, {
      assetId: ulid(),
      presetIds: ['proxy'],
      inputPath: 'samples/clip.mp4',
    });
    assert.equal(await h.service.runNext(), 'failed');
    const after = await h.service.get(caller, job.id);
    assert.equal(after.state, 'failed');
    assert.match(after.reason ?? '', /ECONNREFUSED/);
  } finally {
    await h.cleanup();
  }

  const bare = await harness();
  try {
    await assert.rejects(
      bare.service.enqueue(caller, {
        assetId: ulid(),
        presetIds: ['proxy'],
        inputFile: { kind: 'original' },
      }),
      /needs HSM/,
    );
    await assert.rejects(
      bare.service.enqueue(caller, {
        assetId: ulid(),
        presetIds: ['proxy'],
        inputPath: 'samples/clip.mp4',
        inputFile: { kind: 'original' },
      }),
      /exactly one of inputPath and inputFile/,
    );
  } finally {
    await bare.cleanup();
  }
});

test('ingest.accepted queues a new asset’s first renditions from its HSM original — by media type, once', async () => {
  const hsm = memoryFileStore();
  const h = await harness(hsm);
  try {
    const accepted = (mediaType: string) => {
      const envelope = buildEnvelope({
        type: 'ingest.accepted',
        channelId: CH,
        payload: { assetId: ulid(), checksum: { algorithm: 'sha256', value: 'x' }, mediaType },
        actor: { kind: 'service', id: 'rim' },
      });
      return { id: envelope.messageId, subject: `atlas.${CH}.ingest.accepted`, body: envelope };
    };
    const video = accepted('video');
    assert.equal(await h.service.consumeIngestAccepted(video), 'applied');
    assert.equal(await h.service.consumeIngestAccepted(video), 'duplicate');
    assert.equal(await h.service.consumeIngestAccepted(accepted('audio')), 'applied');
    assert.equal(await h.service.consumeIngestAccepted(accepted('other')), 'skipped');
    const jobs = (await h.store.jobs({ channelId: CH, limit: 10 })).map((j) => [
      j.presetIds.join('+'),
      j.inputFile?.kind,
      j.causationId !== undefined,
    ]);
    assert.deepEqual(jobs.sort(), [
      ['audio-proxy', 'original', true],
      ['proxy+thumbnail', 'original', true],
    ]);
  } finally {
    await h.cleanup();
  }
  const bare = await harness();
  try {
    const envelope = buildEnvelope({
      type: 'ingest.accepted',
      channelId: CH,
      payload: {
        assetId: ulid(),
        checksum: { algorithm: 'sha256', value: 'x' },
        mediaType: 'video',
      },
      actor: { kind: 'service', id: 'rim' },
    });
    assert.equal(
      await bare.service.consumeIngestAccepted({
        id: envelope.messageId,
        subject: `atlas.${CH}.ingest.accepted`,
        body: envelope,
      }),
      'skipped',
      'no HSM, no input to read',
    );
  } finally {
    await bare.cleanup();
  }
});
