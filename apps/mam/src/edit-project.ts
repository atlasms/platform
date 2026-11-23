// The media editor's durable artifact (EP-26.2; media-editor.md §3, data-model §1.10): an
// EDIT DECISION LIST over one source asset's renditions — not new media. Pure here: the types, the
// validation of a timeline a client sends, and the small state machine; persistence is the store,
// the write (authz + audit + outbox) is the service.
//
// Non-destructive (normative): a clip references a source rendition by id with in/out points in
// SECONDS; the editor never rewrites source bytes. A render (EP-26.6) flattens the timeline into a
// NEW file. The timeline is the re-openable artifact; the rendered file is derived from it.

import {
  ClipFilterValues,
  isUlid,
  TransitionValues,
  ulid,
  type ClipFilter,
  type Transition,
} from '@atlas/contracts';

/** What the editor can open. Derived from the asset's `mediaType`; `live-event` is not editable. */
export type MediaKind = 'video' | 'audio' | 'photo';

/** draft → rendering → rendered / failed. `rendering` is entered by a render, left by MTS's outcome. */
export type EditProjectState = 'draft' | 'rendering' | 'rendered' | 'failed';

/** One clip on the timeline: a span of a source rendition, with optional transition-in and filters. */
export interface Clip {
  /** A file/rendition of the source asset this clip draws from. */
  renditionRef: string;
  /** In/out points into that rendition, in seconds (not frames — the proxy fps is the edit grid). */
  inSec: number;
  outSec: number;
  /** The transition in from the clip before (EP-26.5; Tier 0, media-editor.md §5.3); absent is a cut. */
  transitionIn?: Transition;
  /** How long that transition overlaps the clip before, in seconds; 0.5 when absent. */
  transitionSec?: number;
  /** Filters on this clip, applied in order (EP-26.5; Tier 0). */
  filters?: ClipFilter[];
}

/** The edit decision list. */
export interface Timeline {
  clips: Clip[];
}

/** The project. Owned by MAM's document store, audited like any asset edit (entity `edit-project`). */
export interface EditProject {
  id: string;
  channelId: string;
  sourceAssetId: string;
  mediaKind: MediaKind;
  state: EditProjectState;
  timeline: Timeline;
  /** MTS profile (Tier-1 registry) a render encodes with; set on the project or given at render. */
  outputProfile?: string;
  /** The MTS job that rendered it — set when MTS answers (media-editor.md §5.1). */
  renderJobId?: string;
  /**
   * The asset the last render BECOMES — minted when the render is requested, so its progress can
   * be followed at once (`transcode.progress.assetId`); the asset exists once `rendered`.
   */
  outputAssetId?: string;
  /** The asset the last render was asked to become the next version of (the version chain). */
  targetAssetId?: string;
  /** Who asked for the last render: the rendered asset's creator, and so its owner. */
  renderRequestedBy?: string;
  /** Why the last render failed (`failed`). Cleared by the next render. */
  failure?: { code: string; message: string };
  /** A rendered project whose asset could not be linked as `targetAssetId`'s next version: why. */
  versionRefused?: string;
  /** Compare-and-set guard — every save bumps it; the audit record is keyed on it. */
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** A problem at its path in the request — `timeline/clips/2/outSec`. */
export interface EditProjectProblem {
  path: string;
  message: string;
}

export const MAX_CLIPS = 500;
export const MAX_FILTERS_PER_CLIP = 16;
/** A transition's overlap when none is given, and its bounds (media-editor.md §5.3). */
export const DEFAULT_TRANSITION_SEC = 0.5;
export const MIN_TRANSITION_SEC = 0.04;
export const MAX_TRANSITION_SEC = 5;
/** What an AUDIO timeline takes: a wipe or a picture filter has nothing to act on. */
const AUDIO_TRANSITIONS: readonly string[] = ['dissolve', 'fade-black'];
const AUDIO_FILTERS: readonly string[] = ['mute'];

/** The editable kinds, by the asset's `mediaType` vocabulary key. `live-event` and the rest: no. */
export function editableMediaKind(mediaType: string): MediaKind | undefined {
  switch (mediaType) {
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    case 'photo':
    case 'image':
      return 'photo';
    default:
      return undefined;
  }
}

/** A fresh draft project over an asset — empty timeline, version 1. */
export function newEditProject(args: {
  channelId: string;
  sourceAssetId: string;
  mediaKind: MediaKind;
  createdBy: string;
  at: string;
}): EditProject {
  return {
    id: ulid(),
    channelId: args.channelId,
    sourceAssetId: args.sourceAssetId,
    mediaKind: args.mediaKind,
    state: 'draft',
    timeline: { clips: [] },
    version: 1,
    createdBy: args.createdBy,
    createdAt: args.at,
    updatedAt: args.at,
  };
}

/**
 * Validate a timeline a client sent, whole — every problem at once, each at its path. Clips keep
 * their order (a timeline IS ordered); in/out are seconds, `outSec` strictly after `inSec`.
 */
export function parseTimeline(raw: unknown): {
  timeline: Timeline;
  problems: EditProjectProblem[];
} {
  const problems: EditProjectProblem[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      timeline: { clips: [] },
      problems: [{ path: 'timeline', message: 'must be an object' }],
    };
  }
  const clipsRaw = (raw as Record<string, unknown>)['clips'];
  if (!Array.isArray(clipsRaw)) {
    return {
      timeline: { clips: [] },
      problems: [{ path: 'timeline/clips', message: 'must be an array' }],
    };
  }
  if (clipsRaw.length > MAX_CLIPS) {
    problems.push({ path: 'timeline/clips', message: `at most ${MAX_CLIPS} clips` });
  }
  const clips: Clip[] = [];
  clipsRaw.forEach((entry, i) => {
    const at = (field: string) => `timeline/clips/${i}${field ? `/${field}` : ''}`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      problems.push({ path: at(''), message: 'must be an object' });
      return;
    }
    const e = entry as Record<string, unknown>;
    for (const key of Object.keys(e)) {
      if (
        !['renditionRef', 'inSec', 'outSec', 'transitionIn', 'transitionSec', 'filters'].includes(
          key,
        )
      ) {
        problems.push({ path: at(key), message: 'is not a clip field' });
      }
    }
    const before = problems.length;
    const renditionRef = e['renditionRef'];
    if (typeof renditionRef !== 'string' || renditionRef.trim() === '') {
      problems.push({ path: at('renditionRef'), message: 'is required' });
    }
    const sec = (field: 'inSec' | 'outSec'): number => {
      const v = e[field];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        problems.push({ path: at(field), message: 'must be a number of seconds ≥ 0' });
        return NaN;
      }
      return v;
    };
    const inSec = sec('inSec');
    const outSec = sec('outSec');
    if (!Number.isNaN(inSec) && !Number.isNaN(outSec) && outSec <= inSec) {
      problems.push({ path: at('outSec'), message: 'must be after inSec' });
    }
    let transitionIn: Transition | undefined;
    if (e['transitionIn'] !== undefined) {
      if (!(TransitionValues as readonly unknown[]).includes(e['transitionIn'])) {
        problems.push({
          path: at('transitionIn'),
          message: `must be one of ${TransitionValues.join(', ')}`,
        });
      } else {
        transitionIn = e['transitionIn'] as Transition;
      }
    }
    let transitionSec: number | undefined;
    if (e['transitionSec'] !== undefined) {
      const v = e['transitionSec'];
      if (
        typeof v !== 'number' ||
        !Number.isFinite(v) ||
        v < MIN_TRANSITION_SEC ||
        v > MAX_TRANSITION_SEC
      ) {
        problems.push({
          path: at('transitionSec'),
          message: `must be ${MIN_TRANSITION_SEC}–${MAX_TRANSITION_SEC} seconds`,
        });
      } else if (e['transitionIn'] === undefined) {
        problems.push({
          path: at('transitionSec'),
          message: 'is only for a clip with a transition',
        });
      } else {
        transitionSec = v;
      }
    }
    let filters: ClipFilter[] | undefined;
    if (e['filters'] !== undefined) {
      const f = e['filters'];
      if (
        !Array.isArray(f) ||
        f.some((x) => !(ClipFilterValues as readonly unknown[]).includes(x))
      ) {
        problems.push({
          path: at('filters'),
          message: `must be a list of ${ClipFilterValues.join(', ')}`,
        });
      } else if (f.length > MAX_FILTERS_PER_CLIP) {
        problems.push({ path: at('filters'), message: `at most ${MAX_FILTERS_PER_CLIP} filters` });
      } else if (new Set(f).size !== f.length) {
        problems.push({ path: at('filters'), message: 'names a filter twice' });
      } else {
        filters = f as ClipFilter[];
      }
    }
    if (problems.length === before) {
      clips.push({
        renditionRef: (renditionRef as string).trim(),
        inSec,
        outSec,
        ...(transitionIn !== undefined ? { transitionIn } : {}),
        ...(transitionSec !== undefined ? { transitionSec } : {}),
        ...(filters !== undefined ? { filters } : {}),
      });
    }
  });
  return { timeline: { clips }, problems };
}

/**
 * What a timeline's transitions and filters cannot be, given what kind of media it is
 * (media-editor.md §5.3): the first clip takes no transition (nothing is before it); a transition
 * overlaps the clip before for `transitionSec`, which must be shorter than both clips it joins; and
 * an AUDIO timeline takes only the transitions and filters that act on sound. Each problem at its
 * path. The same rule MTS applies to a render command.
 */
export function effectsProblems(timeline: Timeline, mediaKind: MediaKind): EditProjectProblem[] {
  const problems: EditProjectProblem[] = [];
  timeline.clips.forEach((clip, i) => {
    const at = (field: string) => `timeline/clips/${i}/${field}`;
    if (clip.transitionIn !== undefined) {
      if (i === 0) {
        problems.push({
          path: at('transitionIn'),
          message: 'the first clip has nothing to transition from',
        });
      } else {
        const overlap = clip.transitionSec ?? DEFAULT_TRANSITION_SEC;
        const before = timeline.clips[i - 1]!;
        if (overlap >= clip.outSec - clip.inSec || overlap >= before.outSec - before.inSec) {
          problems.push({
            path: at(clip.transitionSec !== undefined ? 'transitionSec' : 'transitionIn'),
            message: `a ${overlap} s transition must be shorter than both clips it joins`,
          });
        }
      }
      if (mediaKind === 'audio' && !AUDIO_TRANSITIONS.includes(clip.transitionIn)) {
        problems.push({
          path: at('transitionIn'),
          message: `${clip.transitionIn} has no meaning for audio`,
        });
      }
    }
    if (mediaKind === 'audio') {
      const visual = (clip.filters ?? []).filter((f) => !AUDIO_FILTERS.includes(f));
      if (visual.length > 0) {
        problems.push({
          path: at('filters'),
          message: `${visual.join(', ')} acts on pictures, and this is audio`,
        });
      }
    }
  });
  return problems;
}

/** Two timelines the same, clip by clip — a re-sent timeline is no change (no revision bump). */
export function sameTimeline(a: Timeline, b: Timeline): boolean {
  return (
    a.clips.length === b.clips.length &&
    a.clips.every((x, i) => {
      const y = b.clips[i]!;
      return (
        x.renditionRef === y.renditionRef &&
        x.inSec === y.inSec &&
        x.outSec === y.outSec &&
        x.transitionIn === y.transitionIn &&
        x.transitionSec === y.transitionSec &&
        (x.filters ?? []).length === (y.filters ?? []).length &&
        (x.filters ?? []).every((f, j) => f === (y.filters ?? [])[j])
      );
    })
  );
}

/** A PATCH body: the timeline (required), and optionally the output profile to render with. */
export function parseEditProjectPatch(raw: unknown): {
  timeline: Timeline;
  outputProfile?: string;
  problems: EditProjectProblem[];
} {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { timeline: { clips: [] }, problems: [{ path: '', message: 'body must be an object' }] };
  }
  const r = raw as Record<string, unknown>;
  const { timeline, problems } = parseTimeline(r['timeline']);
  let outputProfile: string | undefined;
  if (r['outputProfile'] !== undefined) {
    if (typeof r['outputProfile'] !== 'string' || r['outputProfile'].trim() === '') {
      problems.push({ path: 'outputProfile', message: 'must be a non-empty string' });
    } else {
      outputProfile = r['outputProfile'].trim();
    }
  }
  return { timeline, ...(outputProfile !== undefined ? { outputProfile } : {}), problems };
}

/** A render request body: an optional output profile and an optional target asset to version. */
export function parseRenderInput(raw: unknown): {
  outputProfile?: string;
  targetAssetId?: string;
  problems: EditProjectProblem[];
} {
  if (raw === undefined || raw === null) return { problems: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { problems: [{ path: '', message: 'body must be an object' }] };
  }
  const r = raw as Record<string, unknown>;
  const problems: EditProjectProblem[] = [];
  let outputProfile: string | undefined;
  if (r['outputProfile'] !== undefined) {
    if (typeof r['outputProfile'] !== 'string' || r['outputProfile'].trim() === '') {
      problems.push({ path: 'outputProfile', message: 'must be a non-empty string' });
    } else {
      outputProfile = r['outputProfile'].trim();
    }
  }
  let targetAssetId: string | undefined;
  if (r['targetAssetId'] !== undefined) {
    if (typeof r['targetAssetId'] !== 'string' || !isUlid(r['targetAssetId'])) {
      problems.push({ path: 'targetAssetId', message: 'must be a ULID' });
    } else {
      targetAssetId = r['targetAssetId'];
    }
  }
  return {
    ...(outputProfile !== undefined ? { outputProfile } : {}),
    ...(targetAssetId !== undefined ? { targetAssetId } : {}),
    problems,
  };
}

/** The files of the source a clip may be cut from (media-editor.md §5.1) — MTS holds the same rule. */
export const RENDER_SOURCE_KINDS = ['original', 'broadcast', 'proxy'] as const;

/** A clip's `renditionRef` as a FileRef key: `kind` or `kind/variant`, a media kind only. */
export function parseRenditionRef(ref: string): { kind: string; variant?: string } | undefined {
  const match = /^([a-z][a-z0-9-]*)(?:\/([A-Za-z0-9][A-Za-z0-9._-]*))?$/.exec(ref.trim());
  if (!match) return undefined;
  const kind = match[1]!;
  if (!(RENDER_SOURCE_KINDS as readonly string[]).includes(kind)) return undefined;
  return match[2] !== undefined ? { kind, variant: match[2] } : { kind };
}

/**
 * Why this project cannot be rendered now, or undefined (media-editor.md §5.1). A v1 render is a
 * video or audio timeline cut from ONE file of the source, with no transitions or filters (EP-26.5
 * renders those) — refused here, at the request, rather than by MTS a moment later.
 */
export function renderProblem(project: EditProject): string | undefined {
  if (project.state === 'rendering') return 'a render is already in progress';
  if (project.mediaKind === 'photo') return 'a photo is not rendered in v1 — video and audio only';
  if (project.timeline.clips.length === 0) return 'the timeline is empty';
  const refs = new Set(project.timeline.clips.map((c) => c.renditionRef));
  if (refs.size > 1) {
    return `every clip of a v1 render must draw from the same file — the timeline uses ${[...refs].join(', ')}`;
  }
  const [ref] = refs;
  if (parseRenditionRef(ref!) === undefined) {
    return `renditionRef ${ref} is not a file a render can cut from (${RENDER_SOURCE_KINDS.join(', ')}, optionally kind/variant)`;
  }
  const effects = effectsProblems(project.timeline, project.mediaKind);
  if (effects.length > 0) return `${effects[0]!.path} — ${effects[0]!.message}`;
  return undefined;
}

/** Guard for a path parameter that must be a ULID. */
export function isEditProjectId(id: string): boolean {
  return isUlid(id);
}
