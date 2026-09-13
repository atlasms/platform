import type {
  ItemType,
  ScheduleItem,
  ScheduleItemInput,
} from '../core/generated/scheduling.types.ts';

/**
 * The reel, as the editor holds it (EP-20.5) — plain data and pure functions, like the editor
 * area's model, so every rule below is tested without rendering anything.
 *
 * THE EDITOR OWNS REEL CORRECTNESS. That is the deal with the scheduling service: its write path
 * is thin — it stores the starts it is given and refuses nothing about their arrangement
 * (data-model §3.4, FR-SCH-9) — so the arrangement is decided here. Three rules:
 *
 *   1. **Reflow.** A non-fixed item starts where the previous one ends. A `fixed` item is a
 *      time-locked anchor: its start is what the user typed and the items after it flow from it.
 *      So adding, moving, resizing or removing an item recomputes every start after it, up to the
 *      next anchor — the reel never has to be re-timed by hand.
 *   2. **Overlaps are refused at save.** Reflow cannot create one between non-fixed items, but an
 *      anchor can sit inside the item before it (the anchor is at 10:00, the previous item runs
 *      until 10:05). That is reported as an overlap, the save button stays disabled, and the fix is
 *      the user's — shorten, move, or unfix.
 *   3. **Gaps are flagged, never blocked.** An anchor after the previous item's end leaves dead
 *      air; that is legitimate (a filler goes there, or nothing does) and the row says so.
 *
 * Sub-schedules (a live item's children, §3.5) travel WITH their parent: move or remove the live
 * item and its children move or go with it, and their starts shift by whatever the parent's did.
 * Editing inside a sub-schedule is v1.
 */

/** One row of the editor. `key` is the row's identity while it has no server id yet. */
export interface ReelRow {
  readonly key: string;
  /** The server id once saved; absent for a row added since the last save. */
  readonly id?: string;
  readonly parentKey?: string;
  readonly start: string;
  readonly durationSec: number;
  readonly fixed: boolean;
  readonly itemType: ItemType;
  readonly mediaId?: string;
  readonly mediaTitle?: string;
  readonly description: string;
  readonly repeat: boolean;
  readonly featured: boolean;
  readonly renditionKind?: string;
  readonly mediaIn?: string;
  readonly mediaOut?: string;
  readonly categoryId?: string;
  readonly categoryTitle?: string;
  readonly episode?: number;
}

/** What is wrong with, or worth noticing about, a row — keyed by the row it is reported on. */
export interface ReelProblems {
  /** Rows that start before the previous top-level row ends. Save is refused while any exist. */
  readonly overlaps: ReadonlySet<string>;
  /** Rows that start after the previous top-level row ends, with the dead air in seconds. */
  readonly gaps: ReadonlyMap<string, number>;
}

export const endOf = (start: string, durationSec: number): string =>
  new Date(Date.parse(start) + Math.round(durationSec * 1000)).toISOString();

/** Rows from the service's items, in the order the service returns them (reel order). */
export function fromItems(items: readonly ScheduleItem[]): ReelRow[] {
  // A saved row's key IS its id, so a child's parentKey is its parentItemId.
  return items.map((i) => ({
    key: i.id,
    id: i.id,
    ...(i.parentItemId !== undefined ? { parentKey: i.parentItemId } : {}),
    start: i.start,
    durationSec: i.durationSec,
    fixed: i.fixed,
    itemType: i.itemType,
    ...(i.mediaId !== undefined ? { mediaId: i.mediaId } : {}),
    ...(i.mediaTitle !== undefined ? { mediaTitle: i.mediaTitle } : {}),
    description: i.description,
    repeat: i.repeat,
    featured: i.featured,
    ...(i.renditionKind !== undefined ? { renditionKind: i.renditionKind } : {}),
    ...(i.mediaIn !== undefined ? { mediaIn: i.mediaIn } : {}),
    ...(i.mediaOut !== undefined ? { mediaOut: i.mediaOut } : {}),
    ...(i.categoryId !== undefined ? { categoryId: i.categoryId } : {}),
    ...(i.categoryTitle !== undefined ? { categoryTitle: i.categoryTitle } : {}),
    ...(i.episode !== undefined ? { episode: i.episode } : {}),
  }));
}

/**
 * The reel as the service takes it: `seq` is the position, children carry their parent's id.
 *
 * A child of a parent that has no server id yet cannot be sent — the contract keys the relation
 * by id. That cannot arise today (children are not created here), and the throw is what keeps it
 * from arising silently when they are.
 */
export function toInputs(rows: readonly ReelRow[]): ScheduleItemInput[] {
  const idOf = new Map(rows.filter((r) => r.id).map((r) => [r.key, r.id as string]));
  const top = rows.filter((r) => !r.parentKey);
  const children = rows.filter((r) => r.parentKey);
  const input = (r: ReelRow, seq: number): ScheduleItemInput => {
    const parentItemId = r.parentKey ? idOf.get(r.parentKey) : undefined;
    if (r.parentKey && parentItemId === undefined) {
      throw new Error(`row ${r.key} belongs to an unsaved parent`);
    }
    return {
      ...(r.id !== undefined ? { id: r.id } : {}),
      ...(parentItemId !== undefined ? { parentItemId } : {}),
      seq,
      start: r.start,
      durationSec: r.durationSec,
      fixed: r.fixed,
      itemType: r.itemType,
      ...(r.mediaId !== undefined ? { mediaId: r.mediaId } : {}),
      ...(r.mediaTitle !== undefined ? { mediaTitle: r.mediaTitle } : {}),
      description: r.description,
      repeat: r.repeat,
      featured: r.featured,
      ...(r.renditionKind !== undefined ? { renditionKind: r.renditionKind } : {}),
      ...(r.mediaIn !== undefined ? { mediaIn: r.mediaIn } : {}),
      ...(r.mediaOut !== undefined ? { mediaOut: r.mediaOut } : {}),
      ...(r.categoryId !== undefined ? { categoryId: r.categoryId } : {}),
      ...(r.categoryTitle !== undefined ? { categoryTitle: r.categoryTitle } : {}),
      ...(r.episode !== undefined ? { episode: r.episode } : {}),
    };
  };
  const out: ScheduleItemInput[] = [];
  top.forEach((parent, i) => {
    out.push(input(parent, i));
    // A sub-reel numbers from 0 within its parent, in the order it is held.
    children.filter((c) => c.parentKey === parent.key).forEach((c, j) => out.push(input(c, j)));
  });
  return out;
}

/** Top-level rows, in reel order. */
export const topLevel = (rows: readonly ReelRow[]): ReelRow[] => rows.filter((r) => !r.parentKey);

/** The rows of one live item's sub-reel, in order. */
export const childrenOf = (rows: readonly ReelRow[], key: string): ReelRow[] =>
  rows.filter((r) => r.parentKey === key);

/**
 * Rule 1. Every non-fixed top-level row starts where the previous one ends; a fixed row keeps
 * its start. Children shift by the same amount their parent did. Pure: returns new rows only
 * where something changed, so an unchanged reel is `===` its rows.
 */
export function reflow(rows: readonly ReelRow[]): ReelRow[] {
  const shifted = new Map<string, number>(); // parent key -> ms its start moved
  let changed = false;
  let prevEnd: number | undefined;
  const top = rows.map((row) => {
    if (row.parentKey) return row;
    let next = row;
    if (!row.fixed && prevEnd !== undefined) {
      const start = new Date(prevEnd).toISOString();
      if (start !== row.start) {
        shifted.set(row.key, prevEnd - Date.parse(row.start));
        next = { ...row, start };
        changed = true;
      }
    }
    prevEnd = Date.parse(next.start) + Math.round(next.durationSec * 1000);
    return next;
  });
  if (!changed) return [...rows];
  return top.map((row) => {
    const delta = row.parentKey ? shifted.get(row.parentKey) : undefined;
    return delta ? { ...row, start: new Date(Date.parse(row.start) + delta).toISOString() } : row;
  });
}

/** Rules 2 and 3, over the top level. */
export function problems(rows: readonly ReelRow[]): ReelProblems {
  const overlaps = new Set<string>();
  const gaps = new Map<string, number>();
  let prevEnd: number | undefined;
  for (const row of topLevel(rows)) {
    const start = Date.parse(row.start);
    if (prevEnd !== undefined) {
      if (start < prevEnd) overlaps.add(row.key);
      else if (start > prevEnd) gaps.set(row.key, Math.round((start - prevEnd) / 1000));
    }
    prevEnd = start + Math.round(row.durationSec * 1000);
  }
  return { overlaps, gaps };
}

/** The reel's total running time, in seconds, from first start to last end at the top level. */
export function span(rows: readonly ReelRow[]): number {
  const top = topLevel(rows);
  const first = top[0];
  const last = top[top.length - 1];
  if (!first || !last) return 0;
  return Math.round(
    (Date.parse(endOf(last.start, last.durationSec)) - Date.parse(first.start)) / 1000,
  );
}

// --- the edits --------------------------------------------------------------------------------------

/** Append at the end of the top level; its start is wherever the reel ends unless it is fixed. */
export function append(rows: readonly ReelRow[], row: ReelRow): ReelRow[] {
  return reflow([...rows, row]);
}

/** Move a top-level row one place up or down; its children come with it. */
export function move(rows: readonly ReelRow[], key: string, direction: 'up' | 'down'): ReelRow[] {
  const top = topLevel(rows);
  const i = top.findIndex((r) => r.key === key);
  const j = direction === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= top.length) return [...rows];
  const order = [...top];
  [order[i], order[j]] = [order[j] as ReelRow, order[i] as ReelRow];
  return reflow(order.flatMap((parent) => [parent, ...childrenOf(rows, parent.key)]));
}

/** Remove a row — and, for a live item, its sub-reel. */
export function remove(rows: readonly ReelRow[], key: string): ReelRow[] {
  return reflow(rows.filter((r) => r.key !== key && r.parentKey !== key));
}

/** Change one row's fields; everything after it re-times. */
export function patch(rows: readonly ReelRow[], key: string, changes: Partial<ReelRow>): ReelRow[] {
  return reflow(rows.map((r) => (r.key === key ? { ...r, ...changes } : r)));
}

/** A row with a client key, ready to append. */
export function newRow(
  fields: Omit<ReelRow, 'key' | 'description' | 'repeat' | 'featured'> &
    Partial<Pick<ReelRow, 'description' | 'repeat' | 'featured'>>,
  key: string = `new-${Math.random().toString(36).slice(2, 10)}`,
): ReelRow {
  return { description: '', repeat: false, featured: false, ...fields, key };
}
