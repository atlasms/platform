// The workflow designer's model (EP-23.4; DSL doc §12): the DEFINITION is the source of truth, and
// the canvas is a projection of it. Lifted from reference/bms-workflow/src/canvas — pure functions,
// each returning a NEW definition, so the editor holds one signal and Foblex Flow only renders.
// Swapping the canvas library would re-map `toGraph`, never the definition.
import type {
  Step,
  StepConfig,
  StepKind,
  Transition,
  ValidationIssue,
  WorkflowDefinition,
} from '@atlas/contracts/workflow-types';
import type { DraftInput } from '../core/generated/bms.types.ts';

export type Marker = 'error' | 'warning';

export interface Point {
  x: number;
  y: number;
}

export interface GraphNode {
  id: string;
  kind: StepKind;
  label: string;
  position: Point;
  /** The connector an edge LEAVES from — absent on an end, which nothing leaves. */
  source?: string;
  /** The connector an edge ARRIVES at — absent on a start, which nothing enters. */
  target?: string;
  marker?: Marker;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  isDefault?: boolean;
  marker?: Marker;
}

export interface GraphView {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Connector ids: one out and one in per step, named by the step — so an edge maps back exactly. */
export const outOf = (stepId: string) => `out:${stepId}`;
export const inOf = (stepId: string) => `in:${stepId}`;
export const stepOfConnector = (connectorId: string): string =>
  connectorId.replace(/^(out|in):/, '');

/**
 * Every canvas node is one ROW tall (36 px), so a step's `position` — its left edge, centred on
 * `y + 18` (DSL doc §11.3, the BPMN layout) — is also the node's top-left here, and a diagram
 * laid out in either place looks the same in the other.
 */
export const NODE_HEIGHT = 36;

/** The canvas's picture of a definition, markers from a validation run laid over it. */
export function toGraph(
  def: WorkflowDefinition,
  issues: readonly ValidationIssue[] = [],
): GraphView {
  const worst = (id: string, key: 'stepId' | 'transitionId'): Marker | undefined => {
    const mine = issues.filter((i) => i[key] === id);
    return mine.some((i) => i.severity === 'error')
      ? 'error'
      : mine.length > 0
        ? 'warning'
        : undefined;
  };
  const nodes = def.steps.map((s, i): GraphNode => {
    const marker = worst(s.id, 'stepId');
    return {
      id: s.id,
      kind: s.kind,
      label: s.name ?? s.id,
      // A step written without a position (by an API client) is placed in a row, not on top of
      // the others; dragging it writes a real one.
      position: s.position ?? { x: i * 180, y: 240 },
      ...(s.kind !== 'end' ? { source: outOf(s.id) } : {}),
      ...(s.kind !== 'start' ? { target: inOf(s.id) } : {}),
      ...(marker ? { marker } : {}),
    };
  });
  const edges = def.transitions.map((t): GraphEdge => {
    const marker = worst(t.id, 'transitionId');
    const label = t.name ?? (t.when ? t.when.replace(/^=\s*/, '') : undefined);
    return {
      id: t.id,
      source: outOf(t.from),
      target: inOf(t.to),
      ...(label !== undefined ? { label } : {}),
      ...(t.isDefault ? { isDefault: true } : {}),
      ...(marker ? { marker } : {}),
    };
  });
  return { nodes, edges };
}

const DEFAULT_CONFIG: Record<StepKind, StepConfig> = {
  start: {},
  end: {},
  command: { action: '', request: { event: '' } },
  'human-task': { taskType: 'approve', assignee: { role: '' } },
  'wait-event': { event: '', correlate: '= true' },
  timer: { mode: 'duration', value: 'PT1H' },
  branch: {},
  parallel: { mode: 'split' },
  'sub-flow': { workflowId: '' },
};

/** `s_<kind>_<n>` / `t<n>`: readable, and never a ULID — a BPMN id must not start with a digit. */
function freshId(existing: readonly string[], prefix: string): string {
  let n = 1;
  while (existing.includes(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** A new step of a kind at a point, named by the caller (the palette's label, localized). */
export function addStep(
  def: WorkflowDefinition,
  kind: StepKind,
  name: string,
  at: Point,
): { def: WorkflowDefinition; stepId: string } {
  const id = freshId(
    def.steps.map((s) => s.id),
    `s_${kind.replace('-', '_')}_`,
  );
  const step: Step = {
    id,
    kind,
    name,
    position: { x: Math.round(at.x), y: Math.round(at.y) },
    config: structuredClone(DEFAULT_CONFIG[kind]),
  };
  return { def: { ...def, steps: [...def.steps, step] }, stepId: id };
}

/** Where a step added with no drop point goes: one column right of everything there is. */
export function nextFreePoint(def: WorkflowDefinition): Point {
  if (def.steps.length === 0) return { x: 0, y: 0 };
  const xs = def.steps.map((s) => s.position?.x ?? 0);
  return { x: Math.max(...xs) + 180, y: 0 };
}

export type ConnectRefusal = 'self' | 'duplicate' | 'into-start' | 'out-of-end' | 'unknown-step';

/**
 * An edge between two steps, or why not. What the canvas can know for certain it refuses here —
 * an edge into a start, out of an end, onto itself, or twice; everything else (a branch's
 * conditions, reachability) is the validator's, judged on the whole graph.
 */
export function connect(
  def: WorkflowDefinition,
  from: string,
  to: string,
): { def: WorkflowDefinition; transitionId: string } | { refused: ConnectRefusal } {
  const a = def.steps.find((s) => s.id === from);
  const b = def.steps.find((s) => s.id === to);
  if (!a || !b) return { refused: 'unknown-step' };
  if (from === to) return { refused: 'self' };
  if (b.kind === 'start') return { refused: 'into-start' };
  if (a.kind === 'end') return { refused: 'out-of-end' };
  if (def.transitions.some((t) => t.from === from && t.to === to)) return { refused: 'duplicate' };
  const id = freshId(
    def.transitions.map((t) => t.id),
    't',
  );
  const transition: Transition = { id, from, to };
  return { def: { ...def, transitions: [...def.transitions, transition] }, transitionId: id };
}

/** Positions written back — presentation only; nothing else about a step changes. */
export function moveSteps(
  def: WorkflowDefinition,
  moves: readonly { id: string; position: Point }[],
): WorkflowDefinition {
  const to = new Map(moves.map((m) => [m.id, m.position]));
  if (!def.steps.some((s) => to.has(s.id))) return def;
  return {
    ...def,
    steps: def.steps.map((s) => {
      const p = to.get(s.id);
      return p ? { ...s, position: { x: Math.round(p.x), y: Math.round(p.y) } } : s;
    }),
  };
}

export function renameStep(def: WorkflowDefinition, id: string, name: string): WorkflowDefinition {
  return {
    ...def,
    steps: def.steps.map((s) => (s.id === id ? { ...s, name } : s)),
  };
}

/**
 * The selection removed: its steps, its edges, and every edge that touched a removed step. A
 * branch whose default edge went keeps no dangling `default`; an error path or compensation that
 * named a removed step is left for the validator to report — it is the author's to re-point.
 */
export function removeSelection(
  def: WorkflowDefinition,
  stepIds: readonly string[],
  transitionIds: readonly string[],
): WorkflowDefinition {
  const steps = new Set(stepIds);
  const edges = new Set(transitionIds);
  const transitions = def.transitions.filter(
    (t) => !edges.has(t.id) && !steps.has(t.from) && !steps.has(t.to),
  );
  const kept = new Set(transitions.map((t) => t.id));
  return {
    ...def,
    steps: def.steps
      .filter((s) => !steps.has(s.id))
      .map((s) => {
        const fallback =
          s.kind === 'branch' ? (s.config as { default?: string } | undefined)?.default : undefined;
        if (fallback === undefined || kept.has(fallback)) return s;
        return { ...s, config: {} };
      }),
    transitions,
  };
}

/**
 * A new workflow's first draft: a start and nothing else. `DraftInput` is the contract's wire
 * shape, whose steps bms.yaml types as plain objects; the DSL's own types are the stricter truth.
 */
export function newDraft(name: string, startName: string): DraftInput {
  const start: Step = {
    id: 's_start',
    kind: 'start',
    name: startName,
    position: { x: 0, y: 0 },
    config: {},
  };
  return { name, steps: [start as unknown as Record<string, unknown>], transitions: [] };
}
