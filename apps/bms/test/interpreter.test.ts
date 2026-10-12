// The interpreter's control flow, driven in memory — the reference implementation's seven cases,
// lifted, plus what the lift added (`steps.<id>.output`, an evaluated assignee, a date timer).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowDefinition } from '@atlas/contracts/workflow';
import { runWorkflow } from '../src/engine/interpreter.ts';
import { presetInput } from '../src/store-conformance.ts';
import { SimDriver } from './sim.ts';

const preset = (name: string): WorkflowDefinition => ({
  ...presetInput(name),
  id: '01J9ZKQ2M8XABCDEFGHJKMNPQV',
  channelId: 'ch12',
  version: 1,
  status: 'published',
});
const canonical = (): WorkflowDefinition => preset('canonical-ingest-to-air.workflow.json');
const start = { instanceId: 'i1', vars: { assetId: 'A1' }, incoming: { assetId: 'A1' } };

/** start → ...steps... → end. */
function linear(steps: WorkflowDefinition['steps']): WorkflowDefinition {
  const all = [
    { id: 's_start', kind: 'start' as const },
    ...steps,
    { id: 's_end', kind: 'end' as const },
  ];
  return {
    id: 'L',
    channelId: 'ch12',
    name: 'linear',
    version: 1,
    status: 'published',
    steps: all,
    transitions: all.slice(0, -1).map((s, i) => ({ id: `t${i}`, from: s.id, to: all[i + 1]!.id })),
  };
}

test('canonical happy path: transcode → ready → approve', async () => {
  const sim = new SimDriver({
    commands: {
      'transcode.job.create': () => ({
        action: 'complete',
        response: { renditions: ['proxy', 'broadcast'] },
      }),
    },
    tasks: { s_review: { outcome: 'approved' } },
  });
  const res = await runWorkflow(canonical(), start, sim);
  assert.equal(res.state, 'completed');
  assert.equal(res.endStepId, 's_end_ok');
  assert.deepEqual(res.vars['renditions'], ['proxy', 'broadcast'], 'command output mapped');
  assert.equal(res.vars['verdict'], 'approved', 'task output mapped');
  assert.deepEqual(sim.emitted[0]?.payload, { profile: 'broadcast', assetId: 'A1' });
});

test('canonical reject path takes the default branch edge', async () => {
  const sim = new SimDriver({
    commands: {
      'transcode.job.create': () => ({ action: 'complete', response: { renditions: [] } }),
    },
    tasks: { s_review: { outcome: 'rejected' } },
  });
  assert.equal((await runWorkflow(canonical(), start, sim)).endStepId, 's_end_rej');
});

test('a command retries with exponential backoff, then succeeds', async () => {
  const def = linear([
    {
      id: 's',
      kind: 'command',
      retry: { maxAttempts: 3, backoff: { type: 'exponential', initial: 'PT1S', factor: 2 } },
      config: { action: 'x', request: { event: 'do.x' }, await: { event: 'x.done' } },
    },
  ]);
  let n = 0;
  const sim = new SimDriver({
    commands: {
      'do.x': () => (++n < 3 ? { action: 'fail' } : { action: 'complete', response: {} }),
    },
  });
  const res = await runWorkflow(def, start, sim);
  assert.equal(res.state, 'completed');
  assert.equal(sim.emitted.length, 3);
  assert.equal(sim.clock, 1000 + 2000);
});

test('exhausted retries with onError=compensate run the compensations in reverse', async () => {
  const def: WorkflowDefinition = {
    id: 'X',
    channelId: 'ch12',
    name: 't',
    version: 1,
    status: 'published',
    steps: [
      { id: 's_start', kind: 'start' },
      {
        id: 's_a',
        kind: 'command',
        compensation: 's_comp',
        config: { action: 'a', request: { event: 'a.do' }, await: { event: 'a.done' } },
      },
      {
        id: 's_fail',
        kind: 'command',
        onError: 'compensate',
        config: { action: 'f', request: { event: 'f.do' }, await: { event: 'f.done' } },
      },
      { id: 's_end', kind: 'end' },
      { id: 's_comp', kind: 'command', config: { action: 'undo', request: { event: 'a.undo' } } },
    ],
    transitions: [
      { id: 't1', from: 's_start', to: 's_a' },
      { id: 't2', from: 's_a', to: 's_fail' },
      { id: 't3', from: 's_fail', to: 's_end' },
    ],
  };
  const sim = new SimDriver({
    commands: {
      'a.do': () => ({ action: 'complete', response: {} }),
      'f.do': () => ({ action: 'fail' }),
    },
  });
  const res = await runWorkflow(def, start, sim);
  assert.equal(res.state, 'failed');
  assert.ok(sim.emittedEvents().includes('a.undo'));
  assert.ok(sim.history.some((h) => h.stepId === 's_a' && h.event === 'compensated'));
});

test('an await timeout fails the run', async () => {
  const def = linear([
    {
      id: 's',
      kind: 'command',
      config: { action: 'x', request: { event: 'do.x' }, await: { event: 'x.done' } },
    },
  ]);
  const sim = new SimDriver({ commands: { 'do.x': () => ({ action: 'timeout' }) } });
  assert.equal((await runWorkflow(def, start, sim)).state, 'failed');
});

test('parallel split/join + sub-flow + timer', async () => {
  const sim = new SimDriver({
    commands: {
      'publish.web.requested': () => ({ action: 'complete', response: {} }),
      'publish.social.requested': () => ({ action: 'complete', response: {} }),
    },
    children: { '01J9ZKQ2M8XABCDEFGHJKMNPQV': () => ({ archived: true }) },
  });
  const res = await runWorkflow(preset('post-approval-distribution.workflow.json'), start, sim);
  assert.equal(res.state, 'completed');
  assert.ok(sim.emittedEvents().includes('publish.web.requested'));
  assert.ok(sim.emittedEvents().includes('publish.social.requested'));
  assert.deepEqual(sim.childCalls[0], {
    workflowId: '01J9ZKQ2M8XABCDEFGHJKMNPQV',
    input: { assetId: 'A1' },
  });
  assert.equal(sim.clock, 3600 * 1000, 'the PT1H settle timer');
});

test('human-task escalation fires when the task is slow', async () => {
  const def = linear([
    {
      id: 's_task',
      kind: 'human-task',
      config: {
        taskType: 'approve',
        assignee: { role: 'editor' },
        dueIn: 'PT4H',
        escalation: { after: 'PT2H', action: 'notify', to: { role: 'chief' } },
      },
    },
  ]);
  const sim = new SimDriver();
  const run = runWorkflow(def, start, sim);
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
  sim.completeTask('s_task', { outcome: 'approved' });
  const res = await run;
  assert.equal(res.state, 'completed');
  assert.deepEqual(sim.escalations, [{ stepId: 's_task', action: 'notify' }]);
});

test('a later expression reads an earlier step through steps.<id>.output', async () => {
  const def = linear([
    { id: 's_wait', kind: 'wait-event', config: { event: 'x', correlate: '= true' } },
    {
      id: 's_task',
      kind: 'human-task',
      config: { taskType: 'review', assignee: { expression: '= steps.s_wait.output.reviewer' } },
    },
  ]);
  const sim = new SimDriver({
    events: { s_wait: { reviewer: 'user-7' } },
    tasks: { s_task: { outcome: 'ok' } },
  });
  const res = await runWorkflow(def, start, sim);
  assert.equal(res.state, 'completed');
  assert.deepEqual(
    sim.tasksCreated[0]?.assignee,
    { userId: 'user-7' },
    'the expression is evaluated',
  );
});

test('a date timer waits until its date, and never a negative time', async () => {
  const at = (iso: string) =>
    linear([{ id: 's_t', kind: 'timer', config: { mode: 'date', value: iso } }]);
  const sim = new SimDriver();
  sim.clock = Date.parse('2026-10-12T00:00:00Z');
  await runWorkflow(at('2026-10-12T00:00:10Z'), start, sim);
  assert.equal(sim.clock, Date.parse('2026-10-12T00:00:10Z'));
  const past = new SimDriver();
  past.clock = Date.parse('2026-10-13T00:00:00Z');
  await runWorkflow(at('2026-10-12T00:00:00Z'), start, past);
  assert.equal(past.clock, Date.parse('2026-10-13T00:00:00Z'));
});
