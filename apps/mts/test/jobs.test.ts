// The command subscription and the worker loop (EP-16.1/16.2), over a real broker double: a
// `transcode.job.create` becomes a queued row and is acknowledged; a command MTS cannot honour is
// thrown to the broker — retried, then dead-lettered — never acked and lost; and the loop drains
// the queue, then stops when the pod does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEnvelope, ulid, type Envelope, type EventPayloads } from '@atlas/contracts';
import { SqliteOutboxStore } from '@atlas/data';
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
  const publish = (payload: Record<string, unknown>, correlationId?: string) => {
    const envelope = buildEnvelope({
      type: 'transcode.job.create',
      channelId: CH,
      payload,
      actor: { kind: 'service', id: 'bms' },
      ...(correlationId !== undefined ? { correlationId } : {}),
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

test('a command over the broker becomes a queued job; one MTS cannot honour is ANSWERED, not dead-lettered', async () => {
  const h = await harness();
  try {
    const queued: string[] = [];
    const refused: string[] = [];
    const errors: string[] = [];
    startJobConsumer({
      broker: h.bus,
      service: h.service,
      maxAttempts: 2,
      onQueued: (subject) => queued.push(subject),
      onRefused: (subject) => refused.push(subject),
      onError: (err) => errors.push((err as Error).message),
    });

    const correlationId = ulid();
    await h.publish({ assetId: ulid(), presetIds: ['proxy'], inputPath: h.input }, correlationId);
    assert.equal(queued.length, 1);
    const [job] = await h.store.jobs({ channelId: CH });
    assert.equal(job?.state, 'queued');
    assert.equal(job?.correlationId, correlationId, "the job keeps the command's correlation");

    // An unknown preset: the issuer is TOLD — transcode.failed under its correlation id — once,
    // with nothing queued and nothing dead-lettered. Retrying a refusal would change nothing.
    const assetId = ulid();
    const asked = ulid();
    await h.publish({ assetId, presetIds: ['hologram'], inputPath: h.input }, asked);
    assert.equal(refused.length, 1);
    assert.equal(errors.length, 0);
    assert.equal(h.bus.deadLetters.length, 0);
    assert.equal((await h.store.jobs({ channelId: CH })).length, 1, 'nothing was queued');
    const answer = (await new SqliteOutboxStore(h.store.db).listUnsent(1000))
      .map((r) => r.message.body as Envelope<EventPayloads['transcode.failed']>)
      .find((e) => e.type === 'transcode.failed');
    assert.equal(answer?.correlationId, asked);
    assert.equal(answer?.payload.assetId, assetId);
    assert.equal(answer?.payload.error.code, 'COMMAND_REFUSED');
    assert.match(answer?.payload.error.message ?? '', /hologram/);

    // Not a command at all — nobody to answer: thrown, retried, dead-lettered.
    await h.publish({ presetIds: ['proxy'] });
    assert.equal(errors.length, 2, 'retried up to maxAttempts');
    assert.equal(h.bus.deadLetters.length, 1);
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
