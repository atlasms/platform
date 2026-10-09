// Copy a time-range of one reel onto another (EP-31; data-model §3.7, FR-SCH-13) — pure.
//
// "Copy 17:00–20:00 of day A to 06:00–09:00 of day B": the TOP-LEVEL items that START inside the
// source range are taken — with their sub-schedules, which travel with the live item they belong
// to — shifted by one offset (where the range's start lands), given new ids, and placed on the
// target. `merge` adds them to what is there; `overwrite` first removes the target's top-level
// items (and their sub-schedules) that START inside the destination range — the same rule as the
// selection, so what an overwrite removes is exactly what the same copy would have taken from the
// target. An item crossing an edge of either range is judged by its start, never cut: the reel is
// the editor's, and an overlap the copy leaves is `/validate`'s to name (§3.4).
//
// Everything else travels as it is: `fixed` anchors, the title/category overrides, in/out points,
// notes. The media is the same media — a placement, so it counts as an airing (§3.8).

import { ulid } from '@atlas/contracts';
import { ValidationError } from '@atlas/service-kit';
import { endOf, type ScheduleItem } from './schedule.ts';

export type CopyMode = 'merge' | 'overwrite';

export interface CopyRequest {
  /** The source range, by item START: `[from, to)`. Both or neither — neither is the whole reel. */
  from?: string;
  to?: string;
  targetScheduleId: string;
  /** The target's version, read — the copy is a compare-and-set on it. */
  targetVersion: number;
  /** Where the range's start lands (the first copied item's, when there is no range). */
  at: string;
  mode: CopyMode;
}

export interface CopyPlan {
  /** The target's reel after the copy, seq renumbered. */
  items: ScheduleItem[];
  copied: number;
  removed: number;
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const isInstant = (v: unknown): v is string =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v)) && /T.*(Z|[+-]\d{2}:\d{2})$/.test(v);

export function parseCopyRequest(body: unknown): CopyRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('body must be an object');
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(b)) {
    if (!['from', 'to', 'targetScheduleId', 'targetVersion', 'at', 'mode'].includes(key)) {
      errors.push(`unknown field ${key}`);
    }
  }
  if ((b['from'] === undefined) !== (b['to'] === undefined)) {
    errors.push('from and to come together — or neither, for the whole reel');
  }
  for (const key of ['from', 'to', 'at'] as const) {
    if (b[key] !== undefined && !isInstant(b[key])) {
      errors.push(`${key} must be an ISO-8601 instant with a zone`);
    }
  }
  if (b['at'] === undefined) errors.push('at is required: where the range lands');
  if (isInstant(b['from']) && isInstant(b['to']) && Date.parse(b['to']) <= Date.parse(b['from'])) {
    errors.push('to must be after from');
  }
  if (typeof b['targetScheduleId'] !== 'string' || !ULID.test(b['targetScheduleId'])) {
    errors.push('targetScheduleId must be a ULID');
  }
  const v = b['targetVersion'];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    errors.push("targetVersion is required — the target's version you read");
  }
  if (b['mode'] !== 'merge' && b['mode'] !== 'overwrite') {
    errors.push('mode must be merge or overwrite');
  }
  if (errors.length > 0) throw new ValidationError(errors.join('; '));
  return {
    ...(b['from'] !== undefined ? { from: b['from'] as string, to: b['to'] as string } : {}),
    targetScheduleId: b['targetScheduleId'] as string,
    targetVersion: v as number,
    at: b['at'] as string,
    mode: b['mode'] as CopyMode,
  };
}

const startsIn = (item: ScheduleItem, from: number, to: number): boolean => {
  const s = Date.parse(item.start);
  return s >= from && s < to;
};

/** The top-level items starting in `[from, to)` and every sub-schedule item under them. */
function take(items: readonly ScheduleItem[], from: number, to: number): ScheduleItem[] {
  const top = new Set(
    items.filter((i) => i.parentItemId === undefined && startsIn(i, from, to)).map((i) => i.id),
  );
  return items.filter(
    (i) => top.has(i.id) || (i.parentItemId !== undefined && top.has(i.parentItemId)),
  );
}

/** Plan a copy; the source and target may be the same reel (duplicate within a day). */
export function planCopy(
  source: readonly ScheduleItem[],
  target: readonly ScheduleItem[],
  targetScheduleId: string,
  request: Pick<CopyRequest, 'from' | 'to' | 'at' | 'mode'>,
): CopyPlan {
  const tops = source.filter((i) => i.parentItemId === undefined);
  const from =
    request.from !== undefined
      ? Date.parse(request.from)
      : Math.min(...tops.map((i) => Date.parse(i.start)));
  const to =
    request.to !== undefined
      ? Date.parse(request.to)
      : Math.max(...tops.map((i) => Date.parse(i.end))) + 1;
  const taken = tops.length === 0 ? [] : take(source, from, to);
  if (taken.length === 0)
    throw new ValidationError('nothing starts in that range: nothing to copy');

  const offset = Date.parse(request.at) - from;
  const ids = new Map(taken.map((i) => [i.id, ulid()]));
  const copies: ScheduleItem[] = taken.map((i) => {
    const start = new Date(Date.parse(i.start) + offset).toISOString();
    const parentItemId = i.parentItemId !== undefined ? ids.get(i.parentItemId) : undefined;
    const { parentItemId: _p, ...rest } = i;
    void _p;
    return {
      ...rest,
      ...(parentItemId !== undefined ? { parentItemId } : {}),
      id: ids.get(i.id)!,
      scheduleId: targetScheduleId,
      start,
      end: endOf(start, i.durationSec),
    };
  });

  // The destination range is the source range's length from `at`; an overwrite clears what starts in it.
  const span =
    (request.to !== undefined ? to : Math.max(...taken.map((i) => Date.parse(i.end)))) - from;
  const cleared =
    request.mode === 'overwrite'
      ? new Set(
          take(target, Date.parse(request.at), Date.parse(request.at) + Math.max(span, 1)).map(
            (i) => i.id,
          ),
        )
      : new Set<string>();
  const kept = target.filter((i) => !cleared.has(i.id));

  return { items: renumber([...kept, ...copies]), copied: copies.length, removed: cleared.size };
}

/**
 * `seq` again, from the merged reel: top level by start (what was there before what was copied, at
 * a tie), each sub-schedule by its own order. The reel's invariant is a unique `seq` per reel and
 * per sub-reel; the copy must hand the write path a reel it would accept from the editor.
 */
function renumber(items: readonly ScheduleItem[]): ScheduleItem[] {
  const order = new Map(items.map((i, n) => [i.id, n]));
  const byStart = (a: ScheduleItem, b: ScheduleItem): number =>
    Date.parse(a.start) - Date.parse(b.start) || order.get(a.id)! - order.get(b.id)!;
  const out: ScheduleItem[] = [];
  const top = items.filter((i) => i.parentItemId === undefined).sort(byStart);
  top.forEach((parent, seq) => {
    out.push({ ...parent, seq });
    items
      .filter((i) => i.parentItemId === parent.id)
      .sort((a, b) => a.seq - b.seq || byStart(a, b))
      .forEach((child, n) => out.push({ ...child, seq: n }));
  });
  return out;
}
