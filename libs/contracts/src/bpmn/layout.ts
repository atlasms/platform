// BPMN diagram interchange (DSL doc §11.3): where each step is drawn. Presentation only — the
// engine never reads `position`, so nothing here can change what a workflow does.
import type { Step, StepKind, WorkflowDefinition } from '../workflow/types.ts';

export interface Point {
  x: number;
  y: number;
}
export interface Bounds extends Point {
  width: number;
  height: number;
}

const EVENT = { width: 36, height: 36 };
const TASK = { width: 100, height: 80 };
const GATEWAY = { width: 50, height: 50 };

/** A shape's size, fixed per kind: events, tasks and gateways as BPMN modelers draw them. */
export const SHAPE: Record<StepKind, { width: number; height: number }> = {
  start: EVENT,
  end: EVENT,
  'wait-event': EVENT,
  timer: EVENT,
  command: TASK,
  'human-task': TASK,
  'sub-flow': TASK,
  branch: GATEWAY,
  parallel: GATEWAY,
};

/**
 * `position` is a shape's LEFT edge and a ROW: the shape is centred vertically on `y + 18` (half an
 * event's height), so steps placed on one `y` line up on their centres whatever their kind — the
 * golden fixture's layout. Import inverts it from the bounds it reads, whatever their size.
 */
const ROW = EVENT.height / 2;

export function boundsOf(kind: StepKind, position: Point): Bounds {
  const { width, height } = SHAPE[kind];
  return { x: position.x, y: position.y + ROW - height / 2, width, height };
}

export function positionOf(bounds: Bounds): Point {
  return { x: bounds.x, y: bounds.y + bounds.height / 2 - ROW };
}

/**
 * An edge leaves its source's right side and enters its target's left, straight when the two share
 * a centre line and with one elbow half-way across otherwise. The DSL keeps no bend points, so an
 * edge is always drawn from where its ends are.
 */
export function waypoints(from: Bounds, to: Bounds): Point[] {
  const sx = from.x + from.width;
  const sy = from.y + from.height / 2;
  const tx = to.x;
  const ty = to.y + to.height / 2;
  if (sy === ty)
    return [
      { x: sx, y: sy },
      { x: tx, y: ty },
    ];
  const mx = (sx + tx) / 2;
  return [
    { x: sx, y: sy },
    { x: mx, y: sy },
    { x: mx, y: ty },
    { x: tx, y: ty },
  ];
}

const COLUMN = 180;
const LANE = 120;

/**
 * Every step's position: its own, or — for a step that has none (a definition written by hand or
 * by an API client) — a column by its distance from the start and a lane by its order in that
 * column. Placed steps are not moved, so a partly placed definition can overlap; it is a layout to
 * start from, not one to keep.
 */
export function placeSteps(def: WorkflowDefinition): Map<string, Point> {
  const placed = new Map<string, Point>();
  for (const s of def.steps) if (s.position) placed.set(s.id, s.position);
  if (placed.size === def.steps.length) return placed;

  const next = new Map<string, string[]>();
  for (const t of def.transitions) next.set(t.from, [...(next.get(t.from) ?? []), t.to]);
  const depth = new Map<string, number>();
  const queue: Step[] = def.steps.filter((s) => s.kind === 'start');
  for (const s of queue) depth.set(s.id, 0);
  for (let i = 0; i < queue.length; i++) {
    const s = queue[i]!;
    for (const id of next.get(s.id) ?? []) {
      const target = def.steps.find((x) => x.id === id);
      if (!target || depth.has(id)) continue;
      depth.set(id, (depth.get(s.id) ?? 0) + 1);
      queue.push(target);
    }
  }
  const deepest = Math.max(0, ...depth.values());
  const lanes = new Map<number, number>();
  for (const s of def.steps) {
    if (placed.has(s.id)) continue;
    const column = depth.get(s.id) ?? deepest + 1;
    const lane = lanes.get(column) ?? 0;
    lanes.set(column, lane + 1);
    placed.set(s.id, { x: column * COLUMN, y: lane * LANE });
  }
  return placed;
}
