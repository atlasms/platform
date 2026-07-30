// Library-agnostic view-model for the designer canvas. The WorkflowDefinition is the source of
// truth; this is a *projection* of it for rendering. A thin Foblex Flow adapter maps GraphView to
// Foblex's node/edge model (design §12) — keeping the definition independent of the canvas library.
import type { WorkflowDefinition, ValidationIssue } from '../types.ts';

export type Marker = 'error' | 'warning';

export interface GraphNode {
  id: string;
  kind: string;
  label: string;
  x: number;
  y: number;
  marker?: Marker;   // from validation
  status?: string;   // from a live-instance overlay (StepHistory)
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  condition?: string; // FEEL 'when'
  isDefault?: boolean;
  marker?: Marker;
}
export interface GraphView {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Project a definition onto the canvas view-model. */
export function toGraph(def: WorkflowDefinition): GraphView {
  const nodes: GraphNode[] = def.steps.map((s) => ({
    id: s.id, kind: s.kind, label: s.name ?? s.id,
    x: s.position?.x ?? 0, y: s.position?.y ?? 0,
  }));
  const edges: GraphEdge[] = def.transitions.map((t) => ({
    id: t.id, source: t.from, target: t.to,
    label: t.name, condition: t.when, isDefault: t.isDefault,
  }));
  return { nodes, edges };
}

/** Overlay validation issues as node/edge markers (error wins over warning). */
export function applyIssues(view: GraphView, issues: ValidationIssue[]): GraphView {
  const rank = (m?: Marker) => (m === 'error' ? 2 : m === 'warning' ? 1 : 0);
  const set = <T extends { id: string; marker?: Marker }>(items: T[], id: string | undefined, sev: Marker) => {
    const it = items.find((x) => x.id === id);
    if (it && rank(sev) > rank(it.marker)) it.marker = sev;
  };
  for (const i of issues) {
    if (i.stepId) set(view.nodes, i.stepId, i.severity);
    if (i.transitionId) set(view.edges, i.transitionId, i.severity);
  }
  return view;
}

/** Overlay live-instance progress (from step_history) as node status. */
export function applyStatus(view: GraphView, status: Record<string, string>): GraphView {
  for (const n of view.nodes) if (status[n.id]) n.status = status[n.id];
  return view;
}
