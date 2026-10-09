// GENERATED FROM docs/architecture/openapi/scheduling.yaml — DO NOT EDIT.
//
// Regenerate with `npm run api:types`. `npm run api:check` fails the build when this file and the
// contract disagree, which is the whole point: Scheduling's API shape is decided in the contract
// and this file is a projection of it, not a second opinion.

export type Ulid = string;

/** Tier 0 — the playout treats each differently; a `live` item has no media and may carry a sub-schedule. */
export type ItemType = 'media' | 'live' | 'title' | 'filler' | 'break';

/** HH:MM:SS:FF — the playout applies it (data-model §3.3). */
export type Timecode = string;

export interface CopyScheduleInput {
  /** The source range, by item start — with `to`, or neither (the whole reel). */
  from?: string;
  to?: string;
  targetScheduleId: Ulid;
  /** The target's version, read: the copy is a compare-and-set on it. */
  targetVersion: number;
  /** Where the range's start lands. */
  at: string;
  mode: 'merge' | 'overwrite';
}

export interface CopyResult {
  schedule: Schedule;
  items: ScheduleItem[];
  /** Items copied, sub-schedule items included. */
  copied: number;
  /** Target items an overwrite removed, sub-schedule items included. */
  removed: number;
}

/** The header of one channel's program table for one broadcast day (data-model §3.1). */
export interface Schedule {
  id: Ulid;
  channelId: string;
  /** The channel-local broadcast day; its boundary need not be midnight. */
  broadcastDate: string;
  /** IANA zone the broadcast day is expressed in. */
  timezone: string;
  state: 'draft' | 'validated' | 'sending' | 'sent' | 'failed';
  notes?: string;
  /** Bumped on every write to the header OR the reel; the audit revision. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSchedule {
  broadcastDate: string;
  timezone: string;
  notes?: string;
}

export interface UpdateSchedule {
  timezone?: string;
  notes?: string;
}

/** One row of the reel (data-model §3.2). `start` is MATERIALIZED — the editor computes it and the backend stores it (§3.6); `end` is computed from start + duration for range queries. `parentItemId` places the item inside a live item's sub-schedule, one level deep (§3.5). */
export interface ScheduleItem {
  id: Ulid;
  scheduleId: Ulid;
  parentItemId?: Ulid;
  /** Order within the reel, or within the parent's sub-reel. */
  seq: number;
  /** Materialized; locked when `fixed`. */
  start: string;
  durationSec: number;
  /** Computed by the service — start + duration. Read-only. */
  end: string;
  /** A time-locked anchor — its start does not reflow (§3.4). */
  fixed: boolean;
  itemType: ItemType;
  mediaId?: Ulid;
  renditionKind?: string;
  mediaIn?: Timecode;
  mediaOut?: Timecode;
  /** Defaults from the media; overridable for on-air display. */
  mediaTitle?: string;
  categoryId?: string;
  /** Defaults from the category; overridable. */
  categoryTitle?: string;
  episode?: number;
  /** Control-room notes. */
  description: string;
  /** A rebroadcast of a past item. */
  repeat: boolean;
  /** Marked important for the control room. */
  featured: boolean;
}

/** An item as the editor sends it. `id` optional (kept if given, minted if not); `end` never — it is computed. */
export interface ScheduleItemInput {
  id?: Ulid;
  parentItemId?: Ulid;
  seq: number;
  start: string;
  durationSec: number;
  fixed?: boolean;
  itemType: ItemType;
  mediaId?: Ulid;
  renditionKind?: string;
  mediaIn?: Timecode;
  mediaOut?: Timecode;
  mediaTitle?: string;
  categoryId?: string;
  categoryTitle?: string;
  episode?: number;
  description?: string;
  repeat?: boolean;
  featured?: boolean;
}

/** Any subset of the writable fields. */
export interface ScheduleItemPatch {
  parentItemId?: Ulid;
  seq?: number;
  start?: string;
  durationSec?: number;
  fixed?: boolean;
  itemType?: ItemType;
  mediaId?: Ulid;
  renditionKind?: string;
  mediaIn?: Timecode;
  mediaOut?: Timecode;
  mediaTitle?: string;
  categoryId?: string;
  categoryTitle?: string;
  episode?: number;
  description?: string;
  repeat?: boolean;
  featured?: boolean;
}

export type ScheduleWithItems = Schedule & { items: ScheduleItem[] };

/** Tier 0 — each kind is a validator with its own rule (schedule.validated). */
export type IssueKind =
  'gap' | 'overlap' | 'anchor' | 'approval' | 'expiry' | 'rights' | 'availability';

export interface ValidationIssue {
  kind: IssueKind;
  itemId?: Ulid;
  /** critical makes the schedule invalid; a gap is a warning (a filler may fill it at playout). */
  severity: 'info' | 'warning' | 'critical';
  message: string;
  /** gap/overlap/anchor: how long the dead air or the overrun is. */
  seconds?: number;
}

export interface ValidationReport {
  scheduleId: Ulid;
  /** The version validated. */
  version: number;
  /** The schedule's state after this run. */
  state: 'draft' | 'validated' | 'sending' | 'sent' | 'failed';
  /** No critical issue. */
  valid: boolean;
  issues: ValidationIssue[];
  /** Validators that did not run, and so found nothing: today availability (HSM, EP-14). */
  unchecked: IssueKind[];
  validatedAt: string;
}

/** What a window licenses and when. Exactly one of `assetId` and `categoryId`. An item is governed by its asset's windows if the asset has any, else by its category's, else it is not rights-managed; a governed item must lie wholly inside one window. */
export interface RightsWindowInput {
  assetId?: Ulid;
  categoryId?: string;
  validFrom: string;
  /** After validFrom. */
  validTo: string;
  /** Recorded, not evaluated: a channel carries no territory yet. */
  territory?: string;
  notes?: string;
}

export type RightsWindow = RightsWindowInput & {
  id: Ulid;
  channelId: string;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export interface SchedulePage {
  items: Schedule[];
  nextCursor?: Ulid;
}

/** RFC 9457 Problem Details, served as application/problem+json, with the platform's keys kept: `code` is the machine key (a closed enum), `message` the text. `type` is https://atlas.example/problems/<code>, `title` constant per code, `detail` equals `message`, `instance` is urn:atlas:correlation:<correlationId>. */
export interface Error {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  code:
    | 'VALIDATION'
    | 'UNAUTHORIZED'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'PAYLOAD_TOO_LARGE'
    | 'RATE_LIMITED'
    | 'UNAVAILABLE'
    | 'INTERNAL';
  message: string;
  details?: unknown;
  correlationId?: string;
}
