import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workflowsDir } from '../src/paths.ts';
import { runWorkflow } from '../src/engine/interpreter.ts';
import { SimDriver, type SimConfig } from '../src/engine/sim.ts';
import type { WorkflowDefinition } from '../src/types.ts';

const preset = (name: string): WorkflowDefinition => JSON.parse(readFileSync(join(workflowsDir, 'presets', name), 'utf8'));
const canonical = () => preset('canonical-ingest-to-air.workflow.json');
const start = { instanceId: 'i1', vars: { assetId: 'A1' }, incoming: { assetId: 'A1' } };

test('canonical happy path: transcode -> ready -> approve -> schedulable', async () => {
  const sim = new SimDriver({
    commands: { 'transcode.job.create': () => ({ action: 'complete', response: { renditions: ['proxy', 'broadcast'] } }) },
    tasks: { s_review: { outcome: 'approved' } },
  });
  const res = await runWorkflow(canonical(), start, sim);
  assert.equal(res.state, 'completed');
  assert.equal(res.endStepId, 's_end_ok');
  assert.deepEqual(res.vars.renditions, ['proxy', 'broadcast']); // command output mapped
  assert.equal(res.vars.verdict, 'approved');                    // task output mapped
  assert.deepEqual(sim.emitted[0].payload, { profile: 'broadcast', assetId: 'A1' }); // input mapped via FEEL
  assert.ok(sim.completedSteps().includes('s_end_ok'));
});

test('canonical reject path takes the default branch edge', async () => {
  const sim = new SimDriver({
    commands: { 'transcode.job.create': () => ({ action: 'complete', response: { renditions: [] } }) },
    tasks: { s_review: { outcome: 'rejected' } },
  });
  const res = await runWorkflow(canonical(), start, sim);
  assert.equal(res.endStepId, 's_end_rej');
});

test('command retries with backoff then succeeds', async () => {
  const def = linear([
    { id: 's', kind: 'command', retry: { maxAttempts: 3, backoff: { type: 'exponential', initial: 'PT1S', factor: 2 } },
      config: { action: 'x', request: { event: 'do.x' }, await: { event: 'x.done' } } },
  ]);
  let n = 0;
  const sim = new SimDriver({ commands: { 'do.x': () => (++n < 3 ? { action: 'fail' } : { action: 'complete', response: {} }) } });
  const res = await runWorkflow(def, start, sim);
  assert.equal(res.state, 'completed');
  assert.equal(sim.emitted.length, 3);       // 2 failures + 1 success
  assert.equal(sim.clock, 1000 + 2000);      // exponential backoff sleeps: 1s, 2s
});

test('exhausted retries with onError=compensate runs compensation in reverse', async () => {
  const def: WorkflowDefinition = {
    id: 'X', channelId: 'ch12', name: 't', version: 1, status: 'draft',
    steps: [
      { id: 's_start', kind: 'start', config: {} },
      { id: 's_a', kind: 'command', compensation: 's_comp', config: { action: 'a', request: { event: 'a.do' }, await: { event: 'a.done' } } },
      { id: 's_fail', kind: 'command', onError: 'compensate', config: { action: 'f', request: { event: 'f.do' }, await: { event: 'f.done' } } },
      { id: 's_end', kind: 'end', config: {} },
      { id: 's_comp', kind: 'command', config: { action: 'undo', request: { event: 'a.undo' } } },
    ],
    transitions: [
      { id: 't1', from: 's_start', to: 's_a' }, { id: 't2', from: 's_a', to: 's_fail' }, { id: 't3', from: 's_fail', to: 's_end' },
    ],
  };
  const sim = new SimDriver({
    commands: { 'a.do': () => ({ action: 'complete', response: {} }), 'f.do': () => ({ action: 'fail' }) },
  });
  const res = await runWorkflow(def, start, sim);
  assert.equal(res.state, 'failed');
  assert.ok(sim.emittedEvents().includes('a.undo'));           // compensation handler ran
  assert.ok(sim.history.some((h) => h.stepId === 's_a' && h.event === 'compensated'));
});

test('await timeout fails the run', async () => {
  const def = linear([{ id: 's', kind: 'command', config: { action: 'x', request: { event: 'do.x' }, await: { event: 'x.done' } } }]);
  const sim = new SimDriver({ commands: { 'do.x': () => ({ action: 'timeout' }) } });
  const res = await runWorkflow(def, start, sim);
  assert.equal(res.state, 'failed');
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
  assert.equal(sim.childCalls[0]?.workflowId, '01J9ZKQ2M8XABCDEFGHJKMNPQV');
  assert.deepEqual(sim.childCalls[0]?.input, { assetId: 'A1' }); // sub-flow input mapped
  assert.equal(sim.clock, 3600 * 1000);                          // PT1H settle timer
});

test('human-task escalation fires when the task is slow', async () => {
  const def: WorkflowDefinition = {
    id: 'E', channelId: 'ch12', name: 'esc', version: 1, status: 'draft',
    steps: [
      { id: 's_start', kind: 'start', config: {} },
      { id: 's_task', kind: 'human-task', config: { taskType: 'approve', assignee: { role: 'editor' }, dueIn: 'PT4H', escalation: { after: 'PT2H', action: 'notify', to: { role: 'chief' } } } },
      { id: 's_end', kind: 'end', config: {} },
    ],
    transitions: [{ id: 't1', from: 's_start', to: 's_task' }, { id: 't2', from: 's_task', to: 's_end' }],
  };
  const sim = new SimDriver(); // no auto task -> stays pending until we complete it
  const p = runWorkflow(def, start, sim);
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); // let the escalation timer fire first
  sim.completeTask('s_task', { outcome: 'approved' });
  const res = await p;
  assert.equal(res.state, 'completed');
  assert.deepEqual(sim.escalations, [{ stepId: 's_task', action: 'notify' }]);
});

// Build a straight-line def: start -> ...steps... -> end.
function linear(steps: any[]): WorkflowDefinition {
  const all = [{ id: 's_start', kind: 'start', config: {} }, ...steps, { id: 's_end', kind: 'end', config: {} }];
  const transitions = all.slice(0, -1).map((s, i) => ({ id: `t${i}`, from: s.id, to: all[i + 1].id }));
  return { id: 'L', channelId: 'ch12', name: 'linear', version: 1, status: 'draft', steps: all as any, transitions };
}

const _cfg: SimConfig = {};
