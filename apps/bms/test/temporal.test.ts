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
import { ulid } from '@atlas/contracts';
import { compile } from '@atlas/policy';
import { BmsRuntime, BmsService, sqliteWorkflowStore, type Instance } from '../src/index.ts';
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
}
