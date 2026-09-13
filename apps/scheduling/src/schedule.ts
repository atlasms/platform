// The reel model (data-model.md §3), and the invariants that are THIS service's to enforce.
//
// The line is drawn by §3.4 and §3.6 and it matters more than any field here: the backend does NOT
// hard-block overlaps or gaps. The editor maintains the reel — reflow, anchors, the tight sequence —
// and this service persists the `start`s it computed. What the service does refuse is a reel that
// cannot be stored or read back as one: an item outside its schedule, a duplicate `seq` in one
// reel, a `live` item carrying media, a non-live item without any, a sub-schedule nested more than
// one level, a parent that is not a live item in the same reel. Those are not editorial judgement;
// they are the shape of the aggregate.

import { isUlid } from '@atlas/contracts';
import { ValidationError } from '@atlas/service-kit';

export type ScheduleState = 'draft' | 'validated' | 'sending' | 'sent' | 'failed';
export const ITEM_TYPES = ['media', 'live', 'title', 'filler', 'break'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** `HH:MM:SS:FF` — the playout applies it (§3.3). */
const TIMECODE = /^\d{2}:\d{2}:\d{2}:\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface Schedule {
  id: string;
  channelId: string;
  /** The channel-local broadcast day; its boundary need not be midnight (§3.1). */
  broadcastDate: string;
  timezone: string;
  state: ScheduleState;
  notes?: string;
  /** Bumped on every write to the header OR the reel; the audit revision. */
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleItem {
  id: string;
  scheduleId: string;
  /** Set for an item inside a live item's sub-schedule (§3.5). */
  parentItemId?: string;
  seq: number;
  /** Materialized (§3.6); the editor computed it. Locked when `fixed`. */
  start: string;
  durationSec: number;
  /** start + duration, computed here for range queries. */
  end: string;
  /** A time-locked anchor (§3.4). */
  fixed: boolean;
  itemType: ItemType;
  mediaId?: string;
  renditionKind?: string;
  mediaIn?: string;
  mediaOut?: string;
  mediaTitle?: string;
  categoryId?: string;
  categoryTitle?: string;
  episode?: number;
  /** Control-room notes. */
  description: string;
  repeat: boolean;
  featured: boolean;
}

/** An item as the editor sends it: `id` optional, `end` never. */
export type ScheduleItemInput = Omit<ScheduleItem, 'id' | 'scheduleId' | 'end'> & { id?: string };

export interface CreateScheduleInput {
  broadcastDate: string;
  timezone: string;
  notes?: string;
}

export interface UpdateScheduleInput {
  timezone?: string;
  notes?: string;
}

// --- parsing: the wire shape to the model, or a 422 that says which field --------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function optionalString(
  o: Record<string, unknown>,
  key: string,
  where: string,
): string | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new ValidationError(`${where}${key} must be a string`);
  return v;
}

function optionalBoolean(
  o: Record<string, unknown>,
  key: string,
  where: string,
): boolean | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new ValidationError(`${where}${key} must be a boolean`);
  return v;
}

export function parseCreateSchedule(body: unknown): CreateScheduleInput {
  if (!isRecord(body)) throw new ValidationError('body must be an object');
  const broadcastDate = optionalString(body, 'broadcastDate', '');
  const timezone = optionalString(body, 'timezone', '');
  if (broadcastDate === undefined || !DATE.test(broadcastDate)) {
    throw new ValidationError('broadcastDate is required, as YYYY-MM-DD');
  }
  if (timezone === undefined || timezone.length === 0)
    throw new ValidationError('timezone is required');
  const notes = optionalString(body, 'notes', '');
  return { broadcastDate, timezone, ...(notes !== undefined ? { notes } : {}) };
}

export function parseUpdateSchedule(body: unknown): UpdateScheduleInput {
  if (!isRecord(body)) throw new ValidationError('body must be an object');
  for (const key of Object.keys(body)) {
    if (key !== 'timezone' && key !== 'notes')
      throw new ValidationError(`${key} is not writable here`);
  }
  const timezone = optionalString(body, 'timezone', '');
  const notes = optionalString(body, 'notes', '');
  if (timezone !== undefined && timezone.length === 0)
    throw new ValidationError('timezone cannot be empty');
  return {
    ...(timezone !== undefined ? { timezone } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

/** One item from the wire. `where` prefixes messages so a bad row in a reel of 200 names itself. */
export function parseItemInput(body: unknown, where = ''): ScheduleItemInput {
  if (!isRecord(body)) throw new ValidationError(`${where}item must be an object`);

  const id = optionalString(body, 'id', where);
  if (id !== undefined && !isUlid(id)) throw new ValidationError(`${where}id must be a ULID`);
  const parentItemId = optionalString(body, 'parentItemId', where);
  if (parentItemId !== undefined && !isUlid(parentItemId)) {
    throw new ValidationError(`${where}parentItemId must be a ULID`);
  }

  const seq = body['seq'];
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) {
    throw new ValidationError(`${where}seq is required, a non-negative integer`);
  }
  const start = optionalString(body, 'start', where);
  if (start === undefined || Number.isNaN(Date.parse(start))) {
    throw new ValidationError(`${where}start is required, an ISO date-time`);
  }
  const durationSec = body['durationSec'];
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec < 0) {
    throw new ValidationError(`${where}durationSec is required, a non-negative number`);
  }
  const itemType = body['itemType'];
  if (typeof itemType !== 'string' || !(ITEM_TYPES as readonly string[]).includes(itemType)) {
    throw new ValidationError(`${where}itemType must be one of ${ITEM_TYPES.join(', ')}`);
  }

  const mediaId = optionalString(body, 'mediaId', where);
  if (mediaId !== undefined && !isUlid(mediaId))
    throw new ValidationError(`${where}mediaId must be a ULID`);
  const mediaIn = optionalString(body, 'mediaIn', where);
  const mediaOut = optionalString(body, 'mediaOut', where);
  for (const [k, v] of [
    ['mediaIn', mediaIn],
    ['mediaOut', mediaOut],
  ] as const) {
    if (v !== undefined && !TIMECODE.test(v))
      throw new ValidationError(`${where}${k} must be HH:MM:SS:FF`);
  }
  const episode = body['episode'];
  if (
    episode !== undefined &&
    (typeof episode !== 'number' || !Number.isInteger(episode) || episode < 0)
  ) {
    throw new ValidationError(`${where}episode must be a non-negative integer`);
  }

  // The aggregate's own rules (§3.5): a live item is streamed, so it carries no media; every other
  // kind plays something, so it must name it.
  if (itemType === 'live' && mediaId !== undefined) {
    throw new ValidationError(
      `${where}a live item has no mediaId — it is streamed from the studio`,
    );
  }
  if (itemType === 'media' && mediaId === undefined) {
    throw new ValidationError(`${where}a media item needs a mediaId`);
  }

  const renditionKind = optionalString(body, 'renditionKind', where);
  const mediaTitle = optionalString(body, 'mediaTitle', where);
  const categoryId = optionalString(body, 'categoryId', where);
  const categoryTitle = optionalString(body, 'categoryTitle', where);
  const description = optionalString(body, 'description', where) ?? '';

  return {
    ...(id !== undefined ? { id } : {}),
    ...(parentItemId !== undefined ? { parentItemId } : {}),
    seq,
    start: new Date(start).toISOString(),
    durationSec,
    fixed: optionalBoolean(body, 'fixed', where) ?? false,
    itemType: itemType as ItemType,
    ...(mediaId !== undefined ? { mediaId } : {}),
    ...(renditionKind !== undefined ? { renditionKind } : {}),
    ...(mediaIn !== undefined ? { mediaIn } : {}),
    ...(mediaOut !== undefined ? { mediaOut } : {}),
    ...(mediaTitle !== undefined ? { mediaTitle } : {}),
    ...(categoryId !== undefined ? { categoryId } : {}),
    ...(categoryTitle !== undefined ? { categoryTitle } : {}),
    ...(episode !== undefined ? { episode: episode as number } : {}),
    description,
    repeat: optionalBoolean(body, 'repeat', where) ?? false,
    featured: optionalBoolean(body, 'featured', where) ?? false,
  };
}

/** `end` is computed, never sent. */
export function endOf(start: string, durationSec: number): string {
  return new Date(Date.parse(start) + Math.round(durationSec * 1000)).toISOString();
}

/**
 * The reel-level invariants (§3.5), over a whole reel as it will be stored.
 *
 * Deliberately NOT here: overlap and gap. Those are the editor's, on demand via /validate.
 */
export function checkReel(items: readonly ScheduleItem[]): void {
  const byId = new Map(items.map((i) => [i.id, i]));
  const seqs = new Map<string, Set<number>>(); // per (parent or top) → seqs seen
  for (const item of items) {
    checkItem(item);
    const reel = item.parentItemId ?? '';
    const seen = seqs.get(reel) ?? new Set<number>();
    if (seen.has(item.seq)) {
      throw new ValidationError(
        `seq ${item.seq} appears twice in ${reel ? `the sub-schedule of ${reel}` : 'the reel'}`,
      );
    }
    seen.add(item.seq);
    seqs.set(reel, seen);

    if (item.parentItemId !== undefined) {
      const parent = byId.get(item.parentItemId);
      if (!parent)
        throw new ValidationError(
          `item ${item.id}: parent ${item.parentItemId} is not in this reel`,
        );
      if (parent.itemType !== 'live') {
        throw new ValidationError(`item ${item.id}: only a live item may have a sub-schedule`);
      }
      // Exactly one level (§3.5): the parent is itself top-level.
      if (parent.parentItemId !== undefined) {
        throw new ValidationError(
          `item ${item.id}: a sub-schedule cannot be nested inside another`,
        );
      }
    }
  }
}

/** The per-item half of the aggregate's rules (§3.3, §3.5) — enforced here as well as at the wire. */
export function checkItem(item: Pick<ScheduleItem, 'id' | 'itemType' | 'mediaId'>): void {
  if (item.itemType === 'live' && item.mediaId !== undefined) {
    throw new ValidationError(
      `item ${item.id}: a live item has no mediaId — it is streamed from the studio`,
    );
  }
  if (item.itemType === 'media' && item.mediaId === undefined) {
    throw new ValidationError(`item ${item.id}: a media item needs a mediaId`);
  }
}

/** Reel order for reads: top-level by seq, each live item's children right after it, by seq. */
export function inReelOrder(items: readonly ScheduleItem[]): ScheduleItem[] {
  const top = items.filter((i) => i.parentItemId === undefined).sort((a, b) => a.seq - b.seq);
  const children = new Map<string, ScheduleItem[]>();
  for (const i of items) {
    if (i.parentItemId === undefined) continue;
    const list = children.get(i.parentItemId) ?? [];
    list.push(i);
    children.set(i.parentItemId, list);
  }
  const out: ScheduleItem[] = [];
  for (const t of top) {
    out.push(t);
    for (const c of (children.get(t.id) ?? []).sort((a, b) => a.seq - b.seq)) out.push(c);
  }
  return out;
}
