import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '@atlas/contracts/workflow-types';
import {
  addStep,
  connect,
  inOf,
  moveSteps,
  newDraft,
  nextFreePoint,
  outOf,
  removeSelection,
  renameStep,
  setDefaultEdge,
  setEdge,
  setStepConfig,
  stepOfConnector,
  toGraph,
} from './workflow-graph.ts';

// The canonical preset's shape (docs/architecture/workflows/presets), inlined: Studio's specs run
// in a browser-like environment with no file system.
const canonical = (): WorkflowDefinition => ({
  id: '01J9ZKQ2M8XABCDEFGHJKMNPQR',
  channelId: 'ch12',
  name: 'Ingest to air',
  version: 1,
  status: 'draft',
  steps: [
    { id: 's_start', kind: 'start', name: 'On ingest', position: { x: 0, y: 0 }, config: {} },
    {
      id: 's_review',
      kind: 'human-task',
      name: 'Review',
      position: { x: 180, y: 0 },
      config: { taskType: 'approve', assignee: { role: 'librarian' } },
    },
    {
      id: 's_gate',
      kind: 'branch',
      name: 'Approved?',
      position: { x: 360, y: 0 },
      config: { default: 't_reject' },
    },
    { id: 's_ok', kind: 'end', name: 'Schedulable', position: { x: 540, y: -60 }, config: {} },
    { id: 's_rej', kind: 'end', name: 'Rejected', position: { x: 540, y: 60 }, config: {} },
  ],
  transitions: [
    { id: 't1', from: 's_start', to: 's_review' },
    { id: 't2', from: 's_review', to: 's_gate' },
    { id: 't_ok', from: 's_gate', to: 's_ok', when: '= vars.verdict = "approved"' },
    { id: 't_reject', from: 's_gate', to: 's_rej', name: 'rejected', isDefault: true },
  ],
});

describe('toGraph', () => {
  it('projects steps onto nodes and transitions onto connector-to-connector edges', () => {
    const g = toGraph(canonical());
    expect(g.nodes.map((n) => n.id)).toEqual(['s_start', 's_review', 's_gate', 's_ok', 's_rej']);
    const start = g.nodes[0]!;
    expect(start.source).toBe(outOf('s_start'));
    expect(start.target).toBeUndefined(); // nothing enters a start
    const end = g.nodes.find((n) => n.id === 's_ok')!;
    expect(end.source).toBeUndefined(); // nothing leaves an end
    expect(end.position).toEqual({ x: 540, y: -60 });
    const ok = g.edges.find((e) => e.id === 't_ok')!;
    expect([ok.source, ok.target]).toEqual([outOf('s_gate'), inOf('s_ok')]);
    expect(ok.label).toBe('vars.verdict = "approved"'); // the condition, without its `=`
    expect(g.edges.find((e) => e.id === 't_reject')).toMatchObject({
      label: 'rejected',
      isDefault: true,
    });
  });

  it('paints the worst issue on the step or edge it names', () => {
    const g = toGraph(canonical(), [
      { severity: 'warning', code: 'W', message: 'w', stepId: 's_review' },
      { severity: 'error', code: 'E', message: 'e', stepId: 's_review' },
      { severity: 'warning', code: 'W', message: 'w', transitionId: 't_ok' },
    ]);
    expect(g.nodes.find((n) => n.id === 's_review')?.marker).toBe('error');
    expect(g.nodes.find((n) => n.id === 's_gate')?.marker).toBeUndefined();
    expect(g.edges.find((e) => e.id === 't_ok')?.marker).toBe('warning');
  });

  it('a step written without a position is still placed, apart from the others', () => {
    const d = canonical();
    const { position: _p, ...bare } = d.steps[1]!;
    const g = toGraph({ ...d, steps: [d.steps[0]!, bare] });
    expect(g.nodes[1]!.position).toEqual({ x: 180, y: 240 });
  });

  it('a connector id names its step exactly', () => {
    expect(stepOfConnector(outOf('s_a'))).toBe('s_a');
    expect(stepOfConnector(inOf('01JA0000000000000000000001'))).toBe('01JA0000000000000000000001');
  });
});

describe('edit operations', () => {
  it('build a flow out of nothing — every operation returns a new definition, the input untouched', () => {
    const base = { ...canonical(), ...newDraft('New', 'Start') } as unknown as WorkflowDefinition;
    const before = JSON.stringify(base);
    const task = addStep(base, 'human-task', 'Review', nextFreePoint(base));
    expect(task.stepId).toBe('s_human_task_1');
    expect(task.def.steps.at(-1)).toMatchObject({
      kind: 'human-task',
      name: 'Review',
      position: { x: 180, y: 0 },
      config: { taskType: 'approve', assignee: { role: '' } },
    });
    const end = addStep(task.def, 'end', 'End', nextFreePoint(task.def));
    const a = connect(end.def, 's_start', task.stepId);
    if ('refused' in a) throw new Error(a.refused);
    const b = connect(a.def, task.stepId, end.stepId);
    if ('refused' in b) throw new Error(b.refused);
    expect(b.def.transitions.map((t) => [t.id, t.from, t.to])).toEqual([
      ['t1', 's_start', 's_human_task_1'],
      ['t2', 's_human_task_1', 's_end_1'],
    ]);
    expect(JSON.stringify(base)).toBe(before);
  });

  it('refuses at once what the canvas knows is wrong — and nothing else', () => {
    const d = canonical();
    expect(connect(d, 's_review', 's_review')).toEqual({ refused: 'self' });
    expect(connect(d, 's_review', 's_start')).toEqual({ refused: 'into-start' });
    expect(connect(d, 's_ok', 's_review')).toEqual({ refused: 'out-of-end' });
    expect(connect(d, 's_start', 's_review')).toEqual({ refused: 'duplicate' });
    expect(connect(d, 's_start', 'nope')).toEqual({ refused: 'unknown-step' });
    // A second edge out of a human task is the validator's to judge, not the canvas's.
    expect('def' in connect(d, 's_review', 's_ok')).toBe(true);
  });

  it('moving changes positions only — rounded, and the same object when nothing moved', () => {
    const d = canonical();
    const moved = moveSteps(d, [{ id: 's_review', position: { x: 200.4, y: 39.6 } }]);
    expect(moved.steps[1]!.position).toEqual({ x: 200, y: 40 });
    const strip = (x: WorkflowDefinition) =>
      JSON.stringify(x, (k, v) => (k === 'position' ? undefined : v));
    expect(strip(moved)).toBe(strip(d));
    expect(moveSteps(d, [{ id: 'gone', position: { x: 1, y: 1 } }])).toBe(d);
  });

  it('removing a step takes its edges; a branch whose default edge went keeps no dangling default', () => {
    const d = canonical();
    const noRej = removeSelection(d, ['s_rej'], []);
    expect(noRej.steps.map((s) => s.id)).not.toContain('s_rej');
    expect(noRej.transitions.map((t) => t.id)).toEqual(['t1', 't2', 't_ok']);
    expect(noRej.steps.find((s) => s.id === 's_gate')?.config).toEqual({});

    const noEdge = removeSelection(d, [], ['t_ok']);
    expect(noEdge.transitions.map((t) => t.id)).toEqual(['t1', 't2', 't_reject']);
    expect(noEdge.steps.find((s) => s.id === 's_gate')?.config).toEqual({ default: 't_reject' });
  });

  it('renames one step', () => {
    const d = renameStep(canonical(), 's_gate', 'Verdict?');
    expect(d.steps.find((s) => s.id === 's_gate')?.name).toBe('Verdict?');
  });

  it('a new draft is a start and nothing else, with ids no BPMN tool refuses', () => {
    const draft = newDraft('Mine', 'Start');
    expect(draft).toEqual({
      name: 'Mine',
      steps: [
        { id: 's_start', kind: 'start', name: 'Start', position: { x: 0, y: 0 }, config: {} },
      ],
      transitions: [],
    });
  });

  it('a step’s config is replaced whole; nothing else changes', () => {
    const d = canonical();
    const next = setStepConfig(d, 's_review', { taskType: 'review', assignee: { role: 'qa' } });
    expect(next.steps.find((s) => s.id === 's_review')?.config).toEqual({
      taskType: 'review',
      assignee: { role: 'qa' },
    });
    expect(d.steps.find((s) => s.id === 's_review')?.config).toMatchObject({ taskType: 'approve' });
  });

  it('an edge’s name or condition is set, and removed when blank', () => {
    const d = canonical();
    const named = setEdge(d, 't_ok', { name: 'approved', when: '= vars.ok' });
    expect(named.transitions.find((t) => t.id === 't_ok')).toMatchObject({
      name: 'approved',
      when: '= vars.ok',
    });
    const cleared = setEdge(named, 't_ok', { when: '  ' });
    expect(cleared.transitions.find((t) => t.id === 't_ok')).toEqual({
      id: 't_ok',
      from: 's_gate',
      to: 's_ok',
      name: 'approved',
    });
  });

  it('a branch has ONE default: making an edge it moves the flag and the branch’s config together', () => {
    const d = setDefaultEdge(canonical(), 't_ok', true);
    expect(d.transitions.filter((t) => t.isDefault).map((t) => t.id)).toEqual(['t_ok']);
    expect(d.steps.find((s) => s.id === 's_gate')?.config).toEqual({ default: 't_ok' });
    const none = setDefaultEdge(d, 't_ok', false);
    expect(none.transitions.some((t) => t.isDefault)).toBe(false);
    expect(none.steps.find((s) => s.id === 's_gate')?.config).toEqual({});
    // An edge that does not leave a branch has no default to be.
    expect(setDefaultEdge(canonical(), 't1', true)).toEqual(canonical());
  });
});
