import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workflowsDir } from '../src/paths.ts';
import { validateDefinition } from '../src/index.ts';
import {
  toGraph, applyIssues, applyStatus,
  addStep, connect, moveStep, setEdge, setStepConfig, removeStep, removeEdge, emptyDefinition,
  formFor,
} from '../src/canvas/index.ts';
import type { WorkflowDefinition } from '../src/types.ts';

const canonical = (): WorkflowDefinition =>
  JSON.parse(readFileSync(join(workflowsDir, 'presets', 'canonical-ingest-to-air.workflow.json'), 'utf8'));

test('projects a definition onto the graph view-model', () => {
  const g = toGraph(canonical());
  assert.equal(g.nodes.length, 7);
  assert.equal(g.edges.length, 6);
  assert.equal(g.nodes.find((n) => n.id === 's_review')!.kind, 'human-task');
  assert.equal(g.edges.find((e) => e.id === 't_ok')!.condition, '= vars.verdict = "approved"');
  assert.equal(g.edges.find((e) => e.id === 't_reject')!.isDefault, true);
});

test('build a valid flow entirely through edit operations', () => {
  let def = emptyDefinition('ch12', 'Built in the canvas'); // has s_start
  const task = addStep(def, 'human-task', 180, 0); def = task.def;
  const gate = addStep(def, 'branch', 360, 0); def = gate.def;
  const endY = addStep(def, 'end', 540, -60); def = endY.def;
  const endN = addStep(def, 'end', 540, 60); def = endN.def;
  def = connect(def, 's_start', task.stepId).def;
  def = connect(def, task.stepId, gate.stepId).def;
  def = connect(def, gate.stepId, endY.stepId).def;
  const toN = connect(def, gate.stepId, endN.stepId); def = toN.def;
  def = setEdge(def, toN.transitionId, { isDefault: true });

  const res = validateDefinition(def);
  assert.deepEqual(res.issues.filter((i) => i.severity === 'error'), [], JSON.stringify(res.issues));
  assert.equal(res.valid, true);
});

test('moveStep changes only presentation (position), never execution', () => {
  const def = canonical();
  const moved = moveStep(def, 's_review', 999, 111);
  assert.deepEqual(moved.steps.find((s) => s.id === 's_review')!.position, { x: 999, y: 111 });
  // everything except position is identical
  const strip = (d: WorkflowDefinition) => JSON.stringify(d, (k, v) => (k === 'position' ? undefined : v));
  assert.equal(strip(moved), strip(def));
});

test('removeStep also drops its connected edges', () => {
  const def = canonical();
  const after = removeStep(def, 's_review');
  assert.equal(after.steps.find((s) => s.id === 's_review'), undefined);
  assert.equal(after.transitions.some((t) => t.from === 's_review' || t.to === 's_review'), false);
});

test('removeEdge drops just the edge', () => {
  const def = canonical();
  const after = removeEdge(def, 't_ok');
  assert.equal(after.transitions.find((t) => t.id === 't_ok'), undefined);
  assert.equal(after.steps.length, def.steps.length);
});

test('setStepConfig replaces config immutably', () => {
  const def = canonical();
  const after = setStepConfig(def, 's_review', { taskType: 'review', assignee: { role: 'qa' } } as any);
  assert.equal((after.steps.find((s) => s.id === 's_review')!.config as any).taskType, 'review');
  assert.equal((def.steps.find((s) => s.id === 's_review')!.config as any).taskType, 'approve'); // input untouched
});

test('property forms are derived from the schema $defs', () => {
  const cmd = formFor('command');
  assert.ok(cmd.find((f) => f.name === 'action' && f.required));
  assert.ok(cmd.find((f) => f.name === 'request' && f.required));

  const timer = formFor('timer');
  assert.deepEqual(timer.find((f) => f.name === 'mode')!.enum, ['duration', 'date', 'cron']);
  assert.ok(timer.find((f) => f.name === 'value' && f.required));

  const ht = formFor('human-task');
  assert.deepEqual(ht.find((f) => f.name === 'taskType')!.enum, ['approve', 'review', 'edit', 'generic']);
  assert.ok(ht.find((f) => f.name === 'assignee' && f.required));
});

test('validation issues + live status overlay onto graph markers', () => {
  const g = toGraph(canonical());
  applyIssues(g, [
    { severity: 'warning', code: 'X', message: '', stepId: 's_review' },
    { severity: 'error', code: 'Y', message: '', stepId: 's_review' },   // error wins
    { severity: 'error', code: 'Z', message: '', transitionId: 't_ok' },
  ]);
  assert.equal(g.nodes.find((n) => n.id === 's_review')!.marker, 'error');
  assert.equal(g.edges.find((e) => e.id === 't_ok')!.marker, 'error');

  applyStatus(g, { s_transcode: 'completed', s_review: 'active' });
  assert.equal(g.nodes.find((n) => n.id === 's_transcode')!.status, 'completed');
});
