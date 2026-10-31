// The asset editor's shot list (EP-27.3) as a form: timecodes typed as HH:MM:SS.mmm (or MM:SS,
// or seconds), kept by MAM as millisecond offsets into the media's timeline (mam.yaml ShotList).
// Pure — what is parsed, what is sent, what is shown where.

import type { ShotListItem, ShotListItemInput } from '../core/generated/mam.types.ts';

/** A row as edited: the timecodes as typed, so a half-typed value is not lost to a re-render. */
export interface ShotRow {
  /** The shot's id once MAM has one; a new row has none until it is saved. */
  id?: string;
  /** Stable for the list's `track`, whether or not the shot has an id yet. */
  key: string;
  start: string;
  end: string;
  description: string;
}

/** `1:02:03.450` → 3 723 450 ms; also `2:03`, `2:03.5`, `75`, `75.25`. `undefined` if it is not one. */
export function parseTimecode(text: string): number | undefined {
  const parts = text.trim().split(':');
  if (parts.length > 3 || parts.some((p) => p === '')) return undefined;
  const last = /^(\d+)(?:\.(\d{1,3}))?$/.exec(parts.pop()!);
  if (!last || !parts.every((p) => /^\d+$/.test(p))) return undefined;
  const seconds = Number(last[1]);
  const ms = last[2] !== undefined ? Number(last[2].padEnd(3, '0')) : 0;
  // `MM:SS` or `HH:MM:SS`: the fields after the first are bounded like a clock's.
  const [hours, minutes] = parts.length === 2 ? parts.map(Number) : [0, Number(parts[0] ?? 0)];
  if (parts.length > 0 && seconds > 59) return undefined;
  if (parts.length === 2 && minutes! > 59) return undefined;
  return ((hours! * 60 + minutes!) * 60 + seconds) * 1000 + ms;
}

/** 3 723 450 ms → `01:02:03.450` — what a timecode field shows. */
export function formatTimecode(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const frac = ms % 1000;
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(h)}:${two(m)}:${two(s)}.${String(frac).padStart(3, '0')}`;
}

export function rowsOf(items: readonly ShotListItem[]): ShotRow[] {
  return items.map((i) => ({
    id: i.id,
    key: i.id,
    start: formatTimecode(i.startMs),
    end: formatTimecode(i.endMs),
    description: i.description,
  }));
}

/** A row for the end of the list: starting where the last one ends. */
export function newRow(rows: readonly ShotRow[], key: string): ShotRow {
  const last = rows[rows.length - 1];
  const from = last ? (parseTimecode(last.end) ?? 0) : 0;
  return { key, start: formatTimecode(from), end: '', description: '' };
}

/**
 * The PUT body, or the rows' own problems first — a timecode that is not one is the form's to say,
 * before MAM is asked; MAM judges the rest (order, the media's end) and its 422 names the item.
 */
export function bodyOf(
  rows: readonly ShotRow[],
): { items: ShotListItemInput[] } | { problems: Record<string, string> } {
  const problems: Record<string, string> = {};
  const items: ShotListItemInput[] = [];
  rows.forEach((r, i) => {
    const startMs = parseTimecode(r.start);
    const endMs = parseTimecode(r.end);
    if (startMs === undefined) problems[`items/${i}/startMs`] = 'timecode';
    if (endMs === undefined) problems[`items/${i}/endMs`] = 'timecode';
    if (startMs !== undefined && endMs !== undefined)
      items.push({
        ...(r.id !== undefined ? { id: r.id } : {}),
        startMs,
        endMs,
        description: r.description,
      });
  });
  return Object.keys(problems).length > 0 ? { problems } : { items };
}

/** MAM's 422 `details.problems` as a map from path to message — what each row shows under itself. */
export function problemsOf(details: unknown): Record<string, string> {
  const problems = (details as { problems?: unknown } | undefined)?.problems;
  if (!Array.isArray(problems)) return {};
  const out: Record<string, string> = {};
  for (const p of problems)
    if (typeof p?.path === 'string' && typeof p?.message === 'string') out[p.path] = p.message;
  return out;
}

/** Whether the rows differ from what MAM holds — the editor's dirty state. */
export function changed(rows: readonly ShotRow[], items: readonly ShotListItem[]): boolean {
  const body = bodyOf(rows);
  if (!('items' in body)) return true;
  if (body.items.length !== items.length) return true;
  return body.items.some(
    (b, i) =>
      b.id !== items[i]!.id ||
      b.startMs !== items[i]!.startMs ||
      b.endMs !== items[i]!.endMs ||
      b.description !== items[i]!.description,
  );
}
