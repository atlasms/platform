// BMS's worker against a REAL Temporal server (ADR-0010): the generic workflow bundled from
// source, an instance started through the service, a durable timer, a wait satisfied by a signal,
// and the mirror following — the adapter the in-process runner stands in for everywhere else.
//
// CI provides a server (`temporal server start-dev`) and sets ATLAS_TEMPORAL_ADDRESS. Locally:
//
//   docker run -d --name temporal-dev -p 7233:7233 temporalio/admin-tools:1.32.1 \
//     temporal server start-dev --ip 0.0.0.0
//   ATLAS_TEMPORAL_ADDRESS=localhost:7233 npm test -w @atlas/bms

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteOutboxStore } from '@atlas/data';
import { buildEnvelope, subjectFor, ulid, type Envelope } from '@atlas/contracts';
import { compile } from '@atlas/policy';
import {
  BmsRuntime,
  BmsService,
  CompletionRouter,
  sqliteWorkflowStore,
  type Instance,
} from '../src/index.ts';
import { Client, Connection } from '@temporalio/client';
import { connectTemporal } from '../src/temporal/runner.ts';

const ADDRESS = process.env['ATLAS_TEMPORAL_ADDRESS'];

if (!ADDRESS) {
  if (process.env['CI']) {
    throw new Error(
      'ATLAS_TEMPORAL_ADDRESS is unset in CI: the Temporal adapter test would skip, leaving the ' +
        'runtime BMS actually deploys unexercised. Restore the Temporal step in .github/workflows/ci.yml.',
    );
  }
  test(
    'BMS on a real Temporal',
    { skip: 'set ATLAS_TEMPORAL_ADDRESS to run against a server' },
    () => {},
  );
} else {
  const address = ADDRESS;
  test('BMS on a real Temporal: a timer, a wait, a signal — the mirror follows to the end', async () => {
    const store = sqliteWorkflowStore();
    const runtime = new BmsRuntime({ store });
    // A namespace of its own per run, so a rerun never meets an old instance.
    const namespace = `bms-test-${ulid().toLowerCase()}`;
    const temporal = await connectTemporal({ address, namespace, runtime });
    const running = temporal.run();
    const service = new BmsService({ store, runner: temporal.runner });
    const caller = {
      userId: 'user-1',
      channelId: 'ch12',
      policy: compile({
        subjectId: 'user-1',
        permVersion: 1,
        rules: [{ id: 'r', permissions: ['workflow:admin', 'workflow:act'] }],
        roles: [],
        groups: [],
      }),
    };
    const until = async (
      id: string,
      what: string,
      ok: (i: Instance | undefined) => boolean,
    ): Promise<Instance> => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const i = await store.instance(id);
        if (ok(i)) return i!;
        if (Date.now() > deadline)
          throw new Error(`timed out waiting for ${what}: ${JSON.stringify(i)}`);
        await new Promise((r) => setTimeout(r, 200));
      }
    };
    try {
      assert.equal(await temporal.healthy(), true);
      const w = await service.create(caller, {
        name: 'Timer then approval',
        vars: [{ name: 'verdict', type: 'string' }],
        steps: [
          { id: 's_start', kind: 'start' },
          { id: 's_settle', kind: 'timer', config: { mode: 'duration', value: 'PT1S' } },
          {
            id: 's_wait',
            kind: 'wait-event',
            config: {
              event: 'asset.approved',
              correlate: '= true',
              output: { 'vars.verdict': '= incoming.verdict' },
            },
          },
          { id: 's_end', kind: 'end', config: { status: 'done' } },
        ],
        transitions: [
          { id: 't1', from: 's_start', to: 's_settle' },
          { id: 't2', from: 's_settle', to: 's_wait' },
          { id: 't3', from: 's_wait', to: 's_end' },
        ],
      });
      await service.publish(caller, w.id, 1);
      const { id } = await service.startInstance(caller, { workflowId: w.id });

      // Past the durable timer, into the wait.
      await until(id, 'the wait', (i) => i?.currentSteps.includes('s_wait') === true);
      await service.signalInstance(caller, id, 's_wait', { verdict: 'approved' });
      const done = await until(id, 'the end', (i) => i?.state === 'completed');
      assert.equal(done.endStepId, 's_end');
      assert.equal(done.vars?.['verdict'], 'approved', 'the signal reached the output mapping');
      const history = await store.history(id);
      assert.deepEqual(
        history.map((h) => h.seq),
        history.map((_, n) => n + 1),
      );
      assert.ok(history.some((h) => h.stepId === 's_settle' && h.event === 'completed'));
    } finally {
      await temporal.shutdown();
      await running;
    }
  });

  test('BMS on a real Temporal: a command, its refusal, the retry, its answer — and a late answer orphaned', async () => {
    const store = sqliteWorkflowStore();
    const runtime = new BmsRuntime({ store });
    const namespace = `bms-test-${ulid().toLowerCase()}`;
    const temporal = await connectTemporal({ address, namespace, runtime });
    const running = temporal.run();
    const service = new BmsService({ store, runner: temporal.runner });
    const router = new CompletionRouter({ store, runner: temporal.runner });
    const outbox = new SqliteOutboxStore(store.db);
    const caller = {
      userId: 'user-1',
      channelId: 'ch12',
      policy: compile({
        subjectId: 'user-1',
        permVersion: 1,
        rules: [{ id: 'r', permissions: ['workflow:admin', 'workflow:act'] }],
        roles: [],
        groups: [],
      }),
    };
    const eventually = async <T>(what: string, get: () => Promise<T | undefined>): Promise<T> => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const v = await get();
        if (v !== undefined) return v;
        if (Date.now() > deadline) {
          const instances = await store.instances('ch12', { limit: 5 });
          const history = instances[0] ? await store.history(instances[0].id) : [];
          throw new Error(
            `timed out waiting for ${what}: ${JSON.stringify(instances[0])} ${JSON.stringify(history)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    };
    const command = (n: number) =>
      eventually(`command #${n}`, async () => {
        const sent = (await outbox.listUnsent(1000))
          .map((r) => r.message.body as Envelope)
          .filter((e) => e.type === 'transcode.job.create');
        return sent[n - 1];
      });
    const answer = (cmd: Envelope, type: string, payload: Record<string, unknown>) => {
      const e = buildEnvelope({
        type,
        channelId: cmd.channelId,
        payload,
        actor: { kind: 'service', id: 'mts' },
        correlationId: cmd.correlationId!,
        causationId: cmd.messageId,
      });
      return { id: e.messageId, subject: subjectFor(cmd.channelId, type), body: e };
    };
    try {
      const assetId = ulid();
      const w = await service.create(caller, {
        name: 'Transcode',
        vars: [
          { name: 'assetId', type: 'string', initial: assetId },
          { name: 'renditions', type: 'array' },
        ],
        steps: [
          { id: 's_start', kind: 'start' },
          {
            id: 's_tx',
            kind: 'command',
            retry: { maxAttempts: 2, backoff: { type: 'fixed', initial: 'PT1S' } },
            config: {
              action: 'transcode',
              request: {
                event: 'transcode.job.create',
                input: {
                  assetId: '= vars.assetId',
                  presetIds: '= ["proxy"]',
                  'inputFile.kind': '= "original"',
                },
              },
              await: {
                event: 'transcode.completed',
                output: { 'vars.renditions': '= incoming.renditions' },
              },
            },
          },
          { id: 's_end', kind: 'end' },
        ],
        transitions: [
          { id: 't1', from: 's_start', to: 's_tx' },
          { id: 't2', from: 's_tx', to: 's_end' },
        ],
      });
      await service.publish(caller, w.id, 1);
      const { id } = await service.startInstance(caller, { workflowId: w.id });

      const first = await command(1);
      assert.equal(
        await router.route(
          answer(first, 'transcode.failed', {
            assetId,
            error: { code: 'COMMAND_REFUSED', message: 'unknown preset(s): proxy' },
          }),
        ),
        'delivered',
      );
      const second = await command(2);
      assert.notEqual(second.correlationId, first.correlationId);
      const rendition = {
        kind: 'proxy',
        path: 'p.mp4',
        checksum: { algorithm: 'sha256', value: 'ab' },
      };
      assert.equal(
        await router.route(
          answer(second, 'transcode.completed', { assetId, renditions: [rendition] }),
        ),
        'delivered',
      );
      const done = await eventually('the end', async () => {
        const i = await store.instance(id);
        return i?.state === 'completed' ? i : undefined;
      });
      assert.deepEqual(
        done.vars?.['renditions'],
        [rendition],
        'the answer reached the output mapping',
      );

      // The instance has ended: Temporal has nothing to signal, and the answer is orphaned, once.
      // (The mirror says `completed` from the workflow's last activity, a moment before Temporal
      // closes the workflow — wait for Temporal's own word.)
      const client = new Client({ connection: await Connection.connect({ address }), namespace });
      await client.workflow.getHandle(id).result();
      const third = answer(first, 'transcode.completed', { assetId, renditions: [rendition] });
      assert.equal(await router.route(third), 'duplicate', 'the first command was answered');
      const late = await runtime.requestStep({
        key: `${id}:late`,
        instanceId: id,
        req: {
          stepId: 's_tx',
          event: 'transcode.job.create',
          payload: { assetId, presetIds: ['proxy'], inputFile: { kind: 'original' } },
          correlationId: 'x',
          idempotencyKey: 'x',
        },
      });
      const orphan = answer(
        { ...first, correlationId: late.correlationId },
        'transcode.completed',
        { assetId, renditions: [rendition] },
      );
      assert.equal(await router.route(orphan), 'orphaned');
      assert.equal(await router.route(orphan), 'duplicate');
    } finally {
      await temporal.shutdown();
      await running;
    }
  });
}
