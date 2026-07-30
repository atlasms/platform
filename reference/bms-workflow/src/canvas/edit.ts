// Pure editing operations the canvas calls on user actions. Each returns a NEW definition (the
// input is never mutated), so the Angular layer can hold the definition in a signal and swap it.
// After any op the canvas re-validates (validateDefinition) for live feedback.
import type { WorkflowDefinition, Step, StepKind, StepConfig, Transition } from '../types.ts';

const LABEL: Record<StepKind, string> = {
  start: 'Start', end: 'End', command: 'Service action', 'human-task': 'Human task',
  'wait-event': 'Wait for event', timer: 'Timer', branch: 'Branch', parallel: 'Parallel', 'sub-flow': 'Sub-flow',
};

const DEFAULT_CONFIG: Record<StepKind, StepConfig> = {
  start: {}, end: {},
  command: { action: '', request: { event: '' } } as StepConfig,
  'human-task': { taskType: 'approve', assignee: { role: '' } } as StepConfig,
  'wait-event': { event: '', correlate: '= true' } as StepConfig,
  timer: { mode: 'duration', value: 'PT0S' } as StepConfig,
  branch: {}, parallel: { mode: 'split' } as StepConfig,
  'sub-flow': { workflowId: '' } as StepConfig,
};

const clone = (def: WorkflowDefinition): WorkflowDefinition => structuredClone(def);
const freshId = (existing: string[], prefix: string): string => {
  let n = 1;
  while (existing.includes(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
};

export function addStep(def: WorkflowDefinition, kind: StepKind, x: number, y: number): { def: WorkflowDefinition; stepId: string } {
  const d = clone(def);
  const id = freshId(d.steps.map((s) => s.id), `s_${kind}_`);
  const step: Step = { id, kind, name: LABEL[kind], position: { x, y }, config: structuredClone(DEFAULT_CONFIG[kind]) };
  d.steps.push(step);
  return { def: d, stepId: id };
}

export function connect(def: WorkflowDefinition, from: string, to: string): { def: WorkflowDefinition; transitionId: string } {
  const d = clone(def);
  const id = freshId(d.transitions.map((t) => t.id), 't_');
  d.transitions.push({ id, from, to });
  return { def: d, transitionId: id };
}

export function moveStep(def: WorkflowDefinition, id: string, x: number, y: number): WorkflowDefinition {
  const d = clone(def);
  const s = d.steps.find((s) => s.id === id);
  if (s) s.position = { x, y }; // presentation-only; the engine ignores position
  return d;
}

export function setStepConfig(def: WorkflowDefinition, id: string, config: StepConfig): WorkflowDefinition {
  const d = clone(def);
  const s = d.steps.find((s) => s.id === id);
  if (s) s.config = config;
  return d;
}

export function setStepName(def: WorkflowDefinition, id: string, name: string): WorkflowDefinition {
  const d = clone(def);
  const s = d.steps.find((s) => s.id === id);
  if (s) s.name = name;
  return d;
}

export function setEdge(def: WorkflowDefinition, id: string, patch: Partial<Pick<Transition, 'when' | 'name' | 'isDefault'>>): WorkflowDefinition {
  const d = clone(def);
  const t = d.transitions.find((t) => t.id === id);
  if (t) Object.assign(t, patch);
  return d;
}

export function removeStep(def: WorkflowDefinition, id: string): WorkflowDefinition {
  const d = clone(def);
  d.steps = d.steps.filter((s) => s.id !== id);
  d.transitions = d.transitions.filter((t) => t.from !== id && t.to !== id); // drop connected edges
  return d;
}

export function removeEdge(def: WorkflowDefinition, id: string): WorkflowDefinition {
  const d = clone(def);
  d.transitions = d.transitions.filter((t) => t.id !== id);
  return d;
}

// A valid ULID must be supplied for real drafts; this placeholder is schema-valid for scaffolding.
export const emptyDefinition = (channelId: string, name: string, id = '01J9ZKQ2M8XABCDEFGHJKMNPQR'): WorkflowDefinition => ({
  id, channelId, name, version: 1, status: 'draft',
  steps: [{ id: 's_start', kind: 'start', name: 'Start', position: { x: 0, y: 0 }, config: {} }],
  transitions: [],
});
