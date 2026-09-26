// A capture (EP-39; ADR-0007): one file of a recording, as planned and as run.
//
// RIM plans captures ahead from a recorder's windows; a rim-recorder worker LEASES one and runs it.
// Columns, not a document: the lease is one conditional UPDATE, and its rule — never the two
// sides of a cut on one worker — is a query over the other captures' columns.

export const CAPTURE_STATES = [
  'planned',
  'running',
  'completed',
  'partial',
  'missed',
  'cancelled',
] as const;
export type CaptureState = (typeof CAPTURE_STATES)[number];

export interface Capture {
  id: string;
  recorderId: string;
  channelId: string;
  /** The part of the recording the file IS: a grid slot, clipped to the window. */
  fileStart: string;
  fileEnd: string;
  /** What the capture runs for: the file, padded on both sides. */
  captureFrom: string;
  captureTo: string;
  /** 0 or 1, alternating; the two slots are two workers. */
  slot: 0 | 1;
  /** A crash continues the same file as part 2, 3, … */
  part: number;
  state: CaptureState;
  /** The worker (a pod) holding it, or that last held it. */
  holder?: string;
  /** Until when the holder's lease runs; renewed while it records. */
  leaseUntil?: string;
  startedAt?: string;
  endedAt?: string;
  /** The ingest job the file became. */
  jobId?: string;
  /** Why it is partial or missed. */
  reason?: string;
}

/** The capture as the wire carries it: the lease's expiry is the workers' business. */
export function captureView(c: Capture): Omit<Capture, 'leaseUntil'> {
  const { leaseUntil: _lease, ...rest } = c;
  void _lease;
  return rest;
}

/** A `captures` row as either adapter reads it: sqlite gives ISO text, Postgres gives Dates. */
export type CaptureRow = {
  id: string;
  recorder_id: string;
  channel_id: string;
  file_start: string;
  file_end: string;
  capture_from: string;
  capture_to: string;
  slot: number;
  part: number;
  state: string;
  holder: string | null;
  lease_until: string | null;
  started_at: string | null;
  ended_at: string | null;
  job_id: string | null;
  reason: string | null;
};

const iso = (v: string | Date | null): string | undefined =>
  v === null ? undefined : typeof v === 'string' ? new Date(v).toISOString() : v.toISOString();

/** One capture row as the type: optional columns absent rather than null (exactOptionalPropertyTypes). */
export function captureOf(
  r: Omit<
    CaptureRow,
    | 'file_start'
    | 'file_end'
    | 'capture_from'
    | 'capture_to'
    | 'lease_until'
    | 'started_at'
    | 'ended_at'
  > & {
    file_start: string | Date;
    file_end: string | Date;
    capture_from: string | Date;
    capture_to: string | Date;
    lease_until: string | Date | null;
    started_at: string | Date | null;
    ended_at: string | Date | null;
  },
): Capture {
  const opt = {
    holder: r.holder ?? undefined,
    leaseUntil: iso(r.lease_until),
    startedAt: iso(r.started_at),
    endedAt: iso(r.ended_at),
    jobId: r.job_id ?? undefined,
    reason: r.reason ?? undefined,
  };
  return {
    id: r.id,
    recorderId: r.recorder_id,
    channelId: r.channel_id,
    fileStart: iso(r.file_start)!,
    fileEnd: iso(r.file_end)!,
    captureFrom: iso(r.capture_from)!,
    captureTo: iso(r.capture_to)!,
    slot: r.slot === 1 ? 1 : 0,
    part: Number(r.part),
    state: r.state as Capture['state'],
    ...Object.fromEntries(Object.entries(opt).filter(([, v]) => v !== undefined)),
  };
}
