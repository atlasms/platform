// EP-29.4 / EP-29.5 — the filmstrip and hover-preview renditions, end to end through the service.
//
// The filmstrip is the one preset that produces TWO files: a sprite and the WebVTT that indexes it,
// stored as variants `sprite` and `cues` of the one kind `vtt-filmstrip`. The hover preview is an
// ordinary single-file preset. This drives a real job through `runNext` against the HSM double and
// asserts what `transcode.completed` carries and what HSM holds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid, type Envelope, type EventPayloads } from '@atlas/contracts';
import { InMemoryBroker, OutboxRelay } from '@atlas/messaging';
import { SqliteOutboxStore } from '@atlas/data';
import { compile } from '@atlas/policy';
import {
  fakeTranscoder,
  memoryFileStore,
  MtsService,
  sqliteJobStore,
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

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'mts-renditions-'));
  await mkdir(join(root, 'samples'), { recursive: true });
  await writeFile(join(root, 'samples', 'clip.mp4'), 'sample');
  const store = sqliteJobStore();
  const hsm = memoryFileStore();
  const service = new MtsService({
    store,
    transcoder: fakeTranscoder(),
    workRoot: root,
    retryBaseMs: 0,
    files: hsm,
  });
  const broker = new InMemoryBroker();
  const relay = new OutboxRelay(new SqliteOutboxStore(store.db), broker);
  const drain = async (): Promise<Envelope[]> => {
    await relay.drain();
    return broker.published.map((m) => m.body as Envelope);
  };
  return { root, service, hsm, drain, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const walk = async (d: string): Promise<string[]> => {
  const out: string[] = [];
  for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory()) out.push(...(await walk(join(d, e.name))));
    else out.push(join(d, e.name));
  }
  return out;
};

test('a filmstrip produces two renditions of one kind — sprite and cues — distinguished by variant', async () => {
  const h = await harness();
  try {
    const assetId = ulid();
    await h.service.enqueue(caller, {
      assetId,
      presetIds: ['filmstrip'],
      inputPath: 'samples/clip.mp4',
    });
    assert.equal(await h.service.runNext(), 'completed');

    const completed = (await h.drain()).find((e) => e.type === 'transcode.completed')!
      .payload as unknown as EventPayloads['transcode.completed'];

    assert.deepEqual(
      completed.renditions.map((r) => [r.kind, r.variant]),
      [
        ['vtt-filmstrip', 'sprite'],
        ['vtt-filmstrip', 'cues'],
      ],
    );

    // Both land in HSM under the one kind, told apart by variant; checksums are MTS's own.
    for (const r of completed.renditions) {
      const held = h.hsm.files.get(`${assetId}/vtt-filmstrip/${r.variant}`);
      assert.ok(held, `HSM holds the ${r.variant}`);
      assert.equal(createHash('sha256').update(held!.bytes).digest('hex'), r.checksum.value);
    }

    // The cues are a real WebVTT that references the sprite by its relative serving name.
    const cuesBytes = h.hsm.files.get(`${assetId}/vtt-filmstrip/cues`)!.bytes.toString('utf8');
    assert.ok(cuesBytes.startsWith('WEBVTT\n'), 'cues are a WebVTT file');
    assert.match(cuesBytes, /filmstrip\.jpg#xywh=0,0,160,90/);

    assert.deepEqual(await walk(join(h.root, 'renditions')), [], 'scratch, removed once placed');
  } finally {
    await h.cleanup();
  }
});

test('a hover preview is one ordinary rendition, no variant', async () => {
  const h = await harness();
  try {
    const assetId = ulid();
    await h.service.enqueue(caller, {
      assetId,
      presetIds: ['hover-preview'],
      inputPath: 'samples/clip.mp4',
    });
    assert.equal(await h.service.runNext(), 'completed');

    const completed = (await h.drain()).find((e) => e.type === 'transcode.completed')!
      .payload as unknown as EventPayloads['transcode.completed'];

    assert.equal(completed.renditions.length, 1);
    const [preview] = completed.renditions;
    assert.equal(preview!.kind, 'hover-preview');
    assert.equal(preview!.variant, undefined);
    assert.ok(h.hsm.files.get(`${assetId}/hover-preview/`), 'HSM holds the preview');
  } finally {
    await h.cleanup();
  }
});

test('a filmstrip whose input has no readable duration is refused, not retried', async () => {
  const h = await harness();
  try {
    // The fake probes no duration for an input named `noduration`.
    await writeFile(join(h.root, 'samples', 'noduration.mp4'), 'sample');
    const assetId = ulid();
    await h.service.enqueue(caller, {
      assetId,
      presetIds: ['filmstrip'],
      inputPath: 'samples/noduration.mp4',
    });
    // A refusal of the input dead-letters rather than looping the retry.
    assert.equal(await h.service.runNext(), 'dead-letter');
  } finally {
    await h.cleanup();
  }
});
