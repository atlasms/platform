// The media editor's timeline as a form (EP-26.3; media-editor.md §3, §5.1). Pure — what is parsed,
// what is sent, what is offered. A clip is a span of one file of the source asset: in and out typed
// as timecodes (HH:MM:SS.mmm, MM:SS, or seconds), kept by MAM in SECONDS (the proxy's frames are the
// edit grid, ADR-0011 — 26.4's scrubbing snaps to them; typing is to the millisecond).
//
// EP-26.5: each clip may also take a transition in from the clip before (overlapping it for a
// number of seconds) and filters, both from the Tier-0 sets in `@atlas/contracts` — the very values
// MAM validates and MTS renders (media-editor.md §5.3). The form offers only what the media can
// take: an audio timeline gets the transitions and filters that act on sound.

import { ClipFilterValues, TransitionValues } from '@atlas/contracts/events';
import type { EditProject, FileRef } from '../core/generated/mam.types.ts';
import { formatTimecode, parseTimecode } from './shotlist.model.ts';

type Clip = EditProject['timeline']['clips'][number];

/** A clip as edited: the timecodes as typed, so a half-typed value is not lost to a re-render. */
export interface ClipRow {
  /** Stable for the list's `track` across reorders. */
  key: string;
  renditionRef: string;
  in: string;
  out: string;
  /** The transition in from the clip before; absent is a cut (EP-26.5). */
  transitionIn?: Transition;
  /** Its overlap in seconds, as typed; empty is MAM's default (0.5 s). */
  transitionSec: string;
  /** Filters on this clip, in the order they apply. */
  filters: Filter[];
}

type Transition = NonNullable<Clip['transitionIn']>;
type Filter = NonNullable<Clip['filters']>[number];

/** The overlap a transition takes when none is typed — MAM's and MTS's default (media-editor.md §5.3). */
export const DEFAULT_TRANSITION_SEC = 0.5;
const AUDIO_TRANSITIONS: readonly string[] = ['dissolve', 'fade-black'];
const AUDIO_FILTERS: readonly string[] = ['mute'];

/** The transitions this kind of media can take, in the Tier-0 set's order. */
export function transitionsFor(mediaKind: EditProject['mediaKind']): Transition[] {
  return TransitionValues.filter(
    (t) => mediaKind !== 'audio' || AUDIO_TRANSITIONS.includes(t),
  ) as Transition[];
}

/** The filters this kind of media can take, in the Tier-0 set's order. */
export function filtersFor(mediaKind: EditProject['mediaKind']): Filter[] {
  return ClipFilterValues.filter(
    (f) => mediaKind !== 'audio' || AUDIO_FILTERS.includes(f),
  ) as Filter[];
}

/** A filter added at the end, or removed — the order of the others kept. */
export function toggled(filters: readonly Filter[], filter: Filter): Filter[] {
  return filters.includes(filter) ? filters.filter((f) => f !== filter) : [...filters, filter];
}

/** The files a render can cut from, in the order offered (media-editor.md §5.1). */
const CUTTABLE = ['original', 'broadcast', 'proxy'] as const;

/**
 * What a clip may name, from the source's files: `original`, `broadcast`, `proxy`, and a proxy's
 * variants (`proxy/edit`, the editing proxy). A still or a filmstrip is not media to cut from.
 */
export function refsOf(files: readonly FileRef[]): string[] {
  const refs = files
    .filter((f) => (CUTTABLE as readonly string[]).includes(f.kind))
    .map((f) => (f.variant ? `${f.kind}/${f.variant}` : f.kind));
  const rank = (ref: string) => CUTTABLE.indexOf(ref.split('/')[0] as (typeof CUTTABLE)[number]);
  return [...new Set(refs)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * The built-in output profiles a render of this kind can become (media-editor.md §5.1): media, not
 * a still — `broadcast` and `proxy` for video, `audio-proxy` for audio. A channel's own profiles
 * need `config:read` to list, which an editor may not hold; one already set on the project is
 * offered too, so opening a project never silently changes its profile.
 */
export function profilesFor(mediaKind: EditProject['mediaKind'], current?: string): string[] {
  const builtIn =
    mediaKind === 'audio' ? ['audio-proxy'] : mediaKind === 'video' ? ['broadcast', 'proxy'] : [];
  return current && !builtIn.includes(current) ? [...builtIn, current] : builtIn;
}

export function rowsOf(project: EditProject, key: (i: number) => string): ClipRow[] {
  return project.timeline.clips.map((c, i) => ({
    key: key(i),
    renditionRef: c.renditionRef,
    in: formatTimecode(Math.round(c.inSec * 1000)),
    out: formatTimecode(Math.round(c.outSec * 1000)),
    ...(c.transitionIn !== undefined ? { transitionIn: c.transitionIn } : {}),
    transitionSec: c.transitionSec !== undefined ? String(c.transitionSec) : '',
    filters: [...(c.filters ?? [])],
  }));
}

/** A clip for the end of the timeline: from the same file, starting where the last one ended. */
export function newRow(rows: readonly ClipRow[], refs: readonly string[], key: string): ClipRow {
  const last = rows[rows.length - 1];
  const from = last ? (parseTimecode(last.out) ?? 0) : 0;
  return {
    key,
    renditionRef: last?.renditionRef ?? refs[0] ?? 'original',
    in: formatTimecode(from),
    out: '',
    transitionSec: '',
    filters: [],
  };
}

/** Move row `i` by `by` (−1 up, +1 down); out of range is no move. */
export function moved<T>(rows: readonly T[], i: number, by: -1 | 1): T[] {
  const j = i + by;
  if (j < 0 || j >= rows.length) return [...rows];
  const out = [...rows];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/**
 * The timeline a save sends, or the rows' own problems first, keyed as MAM keys them
 * (`timeline/clips/1/outSec`) — a timecode that is not one, or an out before its in, is the form's
 * to say before MAM is asked; MAM judges the rest and its 422 lands on the same keys.
 */
export function timelineOf(
  rows: readonly ClipRow[],
): { timeline: { clips: Clip[] } } | { problems: Record<string, string> } {
  const problems: Record<string, string> = {};
  const clips: Clip[] = [];
  rows.forEach((r, i) => {
    const inMs = parseTimecode(r.in);
    const outMs = parseTimecode(r.out);
    if (inMs === undefined) problems[`timeline/clips/${i}/inSec`] = 'timecode';
    if (outMs === undefined) problems[`timeline/clips/${i}/outSec`] = 'timecode';
    // An overlap is seconds, typed: empty is the default; anything else must be a number.
    let transitionSec: number | undefined;
    if (r.transitionIn !== undefined && r.transitionSec.trim() !== '') {
      transitionSec = Number(r.transitionSec);
      if (!Number.isFinite(transitionSec))
        problems[`timeline/clips/${i}/transitionSec`] = 'seconds';
    }
    if (inMs !== undefined && outMs !== undefined) {
      if (outMs <= inMs) problems[`timeline/clips/${i}/outSec`] = 'order';
      clips.push({
        renditionRef: r.renditionRef,
        inSec: inMs / 1000,
        outSec: outMs / 1000,
        ...(r.transitionIn !== undefined ? { transitionIn: r.transitionIn } : {}),
        ...(transitionSec !== undefined && Number.isFinite(transitionSec) ? { transitionSec } : {}),
        ...(r.filters.length > 0 ? { filters: [...r.filters] } : {}),
      });
    }
  });
  return Object.keys(problems).length > 0 ? { problems } : { timeline: { clips } };
}

/**
 * The timeline's length in milliseconds, from what parses — the running total the form shows. A
 * transition overlaps two clips, so it shortens the timeline by its overlap, as the render will.
 */
export function lengthMs(rows: readonly ClipRow[]): number {
  return rows.reduce((sum, r, i) => {
    const a = parseTimecode(r.in);
    const b = parseTimecode(r.out);
    if (a === undefined || b === undefined || b <= a) return sum;
    const typed = Number(r.transitionSec);
    const overlap =
      i > 0 && r.transitionIn !== undefined
        ? (r.transitionSec.trim() !== '' && Number.isFinite(typed)
            ? typed
            : DEFAULT_TRANSITION_SEC) * 1000
        : 0;
    return sum + (b - a) - overlap;
  }, 0);
}

/** Whether the rows (or the profile) differ from what MAM holds — the tab's dirty dot. */
export function changed(
  rows: readonly ClipRow[],
  profile: string | undefined,
  project: EditProject,
): boolean {
  if ((profile ?? '') !== (project.outputProfile ?? '')) return true;
  const body = timelineOf(rows);
  if (!('timeline' in body)) return true;
  const a = body.timeline.clips;
  const b = project.timeline.clips;
  return (
    a.length !== b.length ||
    a.some(
      (c, i) =>
        c.renditionRef !== b[i]!.renditionRef ||
        Math.abs(c.inSec - b[i]!.inSec) > 0.0005 ||
        Math.abs(c.outSec - b[i]!.outSec) > 0.0005 ||
        c.transitionIn !== b[i]!.transitionIn ||
        c.transitionSec !== b[i]!.transitionSec ||
        (c.filters ?? []).join(',') !== (b[i]!.filters ?? []).join(','),
    )
  );
}

/** MAM's 422 `details.problems` as a map from path to message — what each row shows under itself. */
export { problemsOf } from './shotlist.model.ts';
