// The shot list (EP-27.3; data-model §1.6, FR-MAM-3): an asset's notable segments — where in the
// media something happens, and what. Pure: parsing and validation here, persistence in the store,
// the write in the service.
//
// Timecodes are MILLISECOND offsets into the media's timeline, not SMPTE strings: a frame-accurate
// timecode needs the media's frame rate, which an asset does not always have yet (audio, an
// unprobed file), while an offset is exact whatever the rate — Studio renders it as HH:MM:SS.mmm,
// and as frames once it knows them.

import { isUlid, ulid } from '@atlas/contracts';

/** One notable segment. */
export interface ShotListItem {
  id: string;
  startMs: number;
  endMs: number;
  description: string;
}

/** A shot-list problem, at its path in the request — `items/2/endMs`. */
export interface ShotListProblem {
  path: string;
  message: string;
}

export const MAX_SHOTLIST_ITEMS = 500;
export const MAX_SHOT_DESCRIPTION = 2000;

/**
 * The items a `PUT` carries, checked whole — every problem at once, each at its path — and put in
 * order (start, then end, then id). An item keeps the `id` it was sent with, so a shot's identity
 * survives edits; one without is minted. `durationMs`, when MAM knows the media's length, bounds
 * every segment.
 */
export function parseShotList(
  raw: unknown,
  durationMs: number | undefined,
): { items: ShotListItem[]; problems: ShotListProblem[] } {
  const problems: ShotListProblem[] = [];
  if (!Array.isArray(raw))
    return { items: [], problems: [{ path: 'items', message: 'must be an array' }] };
  if (raw.length > MAX_SHOTLIST_ITEMS)
    problems.push({ path: 'items', message: `at most ${MAX_SHOTLIST_ITEMS} segments` });
  const items: ShotListItem[] = [];
  const ids = new Set<string>();
  raw.forEach((entry, i) => {
    const at = (field: string) => `items/${i}${field ? `/${field}` : ''}`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      problems.push({ path: at(''), message: 'must be an object' });
      return;
    }
    const e = entry as Record<string, unknown>;
    for (const key of Object.keys(e))
      if (!['id', 'startMs', 'endMs', 'description'].includes(key))
        problems.push({ path: at(key), message: 'is not a shot-list field' });
    const before = problems.length;
    let id: string;
    if (e['id'] === undefined) id = ulid();
    else if (typeof e['id'] !== 'string' || !isUlid(e['id'])) {
      problems.push({ path: at('id'), message: 'must be a ULID' });
      id = '';
    } else id = e['id'];
    if (id !== '' && ids.has(id)) problems.push({ path: at('id'), message: 'appears twice' });
    ids.add(id);
    const ms = (field: 'startMs' | 'endMs', min: number): number => {
      const v = e[field];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
        problems.push({
          path: at(field),
          message: `must be a whole number of milliseconds ≥ ${min}`,
        });
        return NaN;
      }
      return v;
    };
    const startMs = ms('startMs', 0);
    const endMs = ms('endMs', 1);
    if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs <= startMs)
      problems.push({ path: at('endMs'), message: 'must be after startMs' });
    if (durationMs !== undefined && !Number.isNaN(endMs) && endMs > durationMs)
      problems.push({
        path: at('endMs'),
        message: `is past the end of the media (${durationMs} ms)`,
      });
    const description = e['description'];
    if (typeof description !== 'string' || description.trim() === '')
      problems.push({ path: at('description'), message: 'is required' });
    else if (description.length > MAX_SHOT_DESCRIPTION)
      problems.push({
        path: at('description'),
        message: `at most ${MAX_SHOT_DESCRIPTION} characters`,
      });
    if (problems.length === before)
      items.push({ id, startMs, endMs, description: (description as string).trim() });
  });
  items.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id));
  return { items, problems };
}

/** The media's length in milliseconds, when MAM knows it — rounded UP so a segment ending on it fits. */
export function durationMsOf(durationSec: number | undefined): number | undefined {
  return durationSec === undefined ? undefined : Math.ceil(durationSec * 1000);
}

/** Two lists the same, item by item — a re-sent list is no change. */
export function sameShotList(a: readonly ShotListItem[], b: readonly ShotListItem[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (x, i) =>
        x.id === b[i]!.id &&
        x.startMs === b[i]!.startMs &&
        x.endMs === b[i]!.endMs &&
        x.description === b[i]!.description,
    )
  );
}
