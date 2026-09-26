// The ingest path: the upload (EP-15.1) — start, parts, resume, complete — and the job the bytes
// become; its validation against the channel's acceptance rules (EP-15.3); the queue and the
// quarantine review (EP-15.6); the rule sets themselves; and folder watchers (EP-15.2), whose
// pickups become jobs the same way a completed upload does.
//
// AUTHORIZATION. `ingest:write` for the upload, `ingest:read` for the queue, `ingest:approve` for
// the review, `ingest:admin` for the rules — in the caller's channel, enforced with `canEnforce`
// and the resource context. Every row here is channel-scoped; another channel's upload or job is
// "not found", not "forbidden" — a 403 would confirm it exists.
//
// WHAT IS ATOMIC, AND WHAT IS NOT. Bytes go to the staging area, rows go to the store, and a
// part is two writes that cannot share a transaction. The order makes that safe: the file first,
// the row second. A crash between the two leaves a part on disk that no row records — a resume
// sends it again and overwrites it, which costs one part. The other order would leave a row that
// promises bytes that are not there, and completion would assemble a hole. Completion is one
// store transaction: the job, `ingest.detected`, and the audit delta commit together, after the
// bytes are assembled and hashed — the checksum in the job is of what is on disk.
//
// VALIDATION FOLLOWS COMPLETION, in transactions of its own. The job is committed `detected`
// and answered; then it is taken to `validating` (guarded by `detected`, so of two validators
// one takes it), the probe reads the bytes OUTSIDE any transaction — seconds, for a broadcast
// master — and the verdict — the metadata, the new state, its reason, `ingest.rejected` when
// there is one, and the audit delta — commits as one, guarded by `validating`. A job left in
// either state by a crash is picked up by the recovery loop after a grace. What the probe says
// about the BYTES (not media, or not media it reads) is a verdict: quarantined, for a person.
// What goes wrong with the TOOL (no binary) is not: the job stays `validating`, the failure is
// logged and shown by readiness, and the loop tries again.

import { rm, readdir, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  buildEnvelope,
  delta,
  subjectFor,
  ulid,
  validatePayload,
  type Envelope,
  type EventPayloads,
  type TechnicalMetadata,
} from '@atlas/contracts';
import type { OutboxRecord } from '@atlas/messaging';
import { canEnforce, type EffectivePolicy } from '@atlas/policy';
import {
  Conflict,
  Forbidden,
  NotFound,
  PayloadTooLarge,
  ValidationError,
} from '@atlas/service-kit';
import {
  evaluate,
  newRuleSet,
  type AcceptanceRuleSet,
  type AcceptanceRuleSetInput,
  type Verdict,
} from './acceptance.ts';
import { ProbeRefusal, type Probe } from './probe.ts';
import type { Staging } from './staging.ts';
import { captureView, type Capture } from './capture.ts';
import {
  DEFAULT_FILE_MINUTES,
  DEFAULT_PAD_SECONDS,
  planFiles,
  recorderErrors,
  type Recorder,
  type RecorderInput,
} from './recorder.ts';
import type { JobQuery, RimStore, RimTx } from './store.ts';
import {
  DEFAULT_SETTLE_SECONDS,
  isCandidate,
  normalisedPath,
  watchDir,
  watcherErrors,
  type Pickup,
  type Watcher,
  type WatcherInput,
} from './watcher.ts';
import {
  expectedPartSize,
  missingParts,
  newUpload,
  UPLOAD_SOURCE,
  type IngestJob,
  type StartUploadInput,
  type Upload,
  type UploadStatus,
} from './upload.ts';

export interface Caller {
  userId: string;
  channelId: string;
  policy: EffectivePolicy;
  correlationId?: string;
}

export interface RimServiceOptions {
  store: RimStore;
  staging: Staging;
  /** Reads what the bytes are (EP-15.4): ffprobe in production, a fake in tests. */
  probe: Probe;
  /** Every part but the last is exactly this long. Bounded by what the gateway will carry. */
  partSizeBytes?: number;
  /** An open upload not completed within this is swept. */
  uploadTtlMs?: number;
  /** A job still `detected` or `validating` after this long lost its validation; `recover` runs it. */
  validateAfterMs?: number;
  now?: () => Date;
  /** Trace context captured into the event where it is created (EP-13.3). */
  traceHeaders?: () => Record<string, string> | undefined;
  /**
   * How work that follows a request runs — the validation after completion. `setImmediate` by
   * default; a test collects the tasks and runs them when it wants to observe the state between.
   */
  defer?: (task: () => Promise<void>) => void;
  /** Where a deferred task's failure goes: main.ts logs it. The recovery loop retries the job. */
  onBackgroundError?: (err: unknown, context: Record<string, unknown>) => void;
  /**
   * The folder watchers' root (EP-15.2): each channel's watchers live under `<watchRoot>/<channelId>/`.
   * Absent, watchers cannot be created — there would be nothing for them to watch.
   */
  watchRoot?: string;
  /** Who this process is, for watcher leases. The pod name in a cluster. */
  holder?: string;
  /** How long a watcher lease lasts; renewed every scan, so this bounds a dead holder's hold. */
  watchLeaseMs?: number;
  /** How far ahead recorders' captures are planned (EP-39). */
  planHorizonMs?: number;
}

/** What one planning pass did — main.ts logs it when anything happened. */
export interface PlanReport {
  recorders: number;
  planned: number;
  /** Planned captures no worker took before their span ended. */
  missed: number;
}

/** What one pass over the watchers did — main.ts logs it when anything happened. */
export interface WatchReport {
  scanned: number;
  pickedUp: number;
  duplicates: number;
  /** Watchers another process holds. */
  skipped: number;
  /** A watcher whose folder is missing or outside its channel's directory, with why. */
  problems: { watcherId: string; problem: string }[];
}

export interface IngestQueuePage {
  items: IngestJob[];
  nextCursor?: string;
}

export const DEFAULT_PART_BYTES = 8 * 1024 * 1024;
export const DEFAULT_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_VALIDATE_AFTER_MS = 60 * 1000;
export const DEFAULT_WATCH_LEASE_MS = 30 * 1000;
export const DEFAULT_PLAN_HORIZON_MS = 24 * 3600 * 1000;

const SERVICE_ACTOR = { kind: 'service', id: 'rim' } as const;
/** The recorder worker (EP-39): the actor of every file it hands over. */
const RECORDER_ACTOR = { kind: 'service', id: 'rim-recorder' } as const;

type Actor = { kind: 'user' | 'service'; id: string };
interface Origin {
  actor: Actor;
  correlationId?: string;
}

/** The job without the field that never leaves this process: what the audit delta compares. */
function audited(job: IngestJob): Record<string, unknown> {
  const { receivedPath: _path, ...rest } = job;
  void _path;
  return rest;
}

export class RimService {
  private readonly store: RimStore;
  private readonly staging: Staging;
  private readonly probe: Probe;
  private readonly partSizeBytes: number;
  private readonly uploadTtlMs: number;
  private readonly validateAfterMs: number;
  private readonly now: () => Date;
  private readonly traceHeaders: () => Record<string, string> | undefined;
  private readonly defer: (task: () => Promise<void>) => void;
  private readonly onBackgroundError: (err: unknown, context: Record<string, unknown>) => void;
  private readonly watchRoot: string | undefined;
  private readonly holder: string;
  private readonly watchLeaseMs: number;
  private readonly planHorizonMs: number;
  /**
   * What each watched file looked like when first seen, and since when — the settle clock. In
   * memory on purpose: it only matters to the process holding the lease, and a new holder simply
   * starts every clock again, which costs one settle interval, never a wrong pickup.
   */
  private readonly settling = new Map<
    string,
    { sizeBytes: number; mtimeMs: number; since: number }
  >();

  constructor(options: RimServiceOptions) {
    this.store = options.store;
    this.staging = options.staging;
    this.probe = options.probe;
    this.partSizeBytes = options.partSizeBytes ?? DEFAULT_PART_BYTES;
    this.uploadTtlMs = options.uploadTtlMs ?? DEFAULT_UPLOAD_TTL_MS;
    this.validateAfterMs = options.validateAfterMs ?? DEFAULT_VALIDATE_AFTER_MS;
    this.now = options.now ?? (() => new Date());
    this.traceHeaders = options.traceHeaders ?? (() => undefined);
    this.onBackgroundError = options.onBackgroundError ?? (() => undefined);
    this.watchRoot = options.watchRoot;
    this.holder = options.holder ?? `${hostname()}:${process.pid}`;
    this.watchLeaseMs = options.watchLeaseMs ?? DEFAULT_WATCH_LEASE_MS;
    this.planHorizonMs = options.planHorizonMs ?? DEFAULT_PLAN_HORIZON_MS;
    this.defer =
      options.defer ??
      ((task) => {
        setImmediate(() => {
          task().catch((err) => this.onBackgroundError(err, { task: 'deferred' }));
        });
      });
    if (!Number.isInteger(this.partSizeBytes) || this.partSizeBytes < 1) {
      throw new Error('partSizeBytes must be a positive integer');
    }
  }

  // --- the upload ------------------------------------------------------------------------------------

  async start(caller: Caller, input: StartUploadInput): Promise<UploadStatus> {
    this.authorize(caller, 'ingest:write');
    const upload = newUpload(input, caller, {
      partSizeBytes: this.partSizeBytes,
      ttlMs: this.uploadTtlMs,
      now: this.now().getTime(),
    });
    await this.store.transaction((tx) => tx.putUpload(upload));
    return { ...upload, received: [] };
  }

  /** The upload and the parts held — what a client resumes from. */
  async status(caller: Caller, id: string): Promise<UploadStatus> {
    this.authorize(caller, 'ingest:write');
    const upload = await this.uploadFor(caller, id);
    const received = (await this.store.parts(id)).map((p) => p.n);
    return { ...upload, received };
  }

  async putPart(caller: Caller, id: string, n: number, bytes: Uint8Array): Promise<void> {
    this.authorize(caller, 'ingest:write');
    const upload = await this.uploadFor(caller, id);
    await this.storePart(upload, n, bytes);
  }

  /** A part, checked against the size the server chose and stored: file first, row second. */
  private async storePart(upload: Upload, n: number, bytes: Uint8Array): Promise<void> {
    const id = upload.uploadId;
    if (upload.state !== 'open') throw new Conflict(`upload ${id} is already complete`);
    const expected = expectedPartSize(upload, n);
    if (bytes.byteLength > expected) {
      throw new PayloadTooLarge(`part ${n} must be ${expected} bytes, got ${bytes.byteLength}`);
    }
    if (bytes.byteLength !== expected) {
      throw new ValidationError(`part ${n} must be ${expected} bytes, got ${bytes.byteLength}`);
    }
    // The file first, the row second — see the header.
    const written = await this.staging.writePart(id, n, bytes);
    await this.store.transaction((tx) =>
      tx.putPart({ uploadId: id, n, sizeBytes: written.sizeBytes, sha256: written.sha256 }),
    );
  }

  /**
   * Assemble the parts, hash them, and create the job — one transaction for the job and its
   * events; validation follows, deferred. Idempotent: an upload already completed returns its
   * job again, because the client that asks twice is the one whose first answer was lost.
   */
  async complete(caller: Caller, id: string): Promise<IngestJob> {
    this.authorize(caller, 'ingest:write');
    const upload = await this.uploadFor(caller, id);
    return this.completeUpload(upload, this.originOf(caller));
  }

  /**
   * The completion both paths share. For a recorder's file (`upload.captureId`) the job is the
   * RECORDER's — `sourceKind: recorder`, `source` its id — and, in the same transaction, the
   * capture is linked to it (compare-and-set on the state it was read in) and
   * `recording.segment.completed` is emitted: a file handed over is announced exactly once.
   */
  private async completeUpload(upload: Upload, origin: Origin): Promise<IngestJob> {
    const id = upload.uploadId;
    if (upload.state === 'completed' && upload.jobId !== undefined) {
      const job = await this.store.job(upload.jobId);
      if (job) return job;
    }
    const received = (await this.store.parts(id)).map((p) => p.n);
    const missing = missingParts(upload.partCount, received);
    if (missing.length > 0) {
      throw new Conflict(`upload ${id} is missing ${missing.length} part(s)`, { missing });
    }

    const assembled = await this.staging.assemble(id, upload.partCount, upload.filename);
    if (assembled.sizeBytes !== upload.sizeBytes) {
      // Every part was checked on the way in, so this is a disk that lied — refuse rather than
      // register a file that is not what the client described.
      throw new Conflict(
        `assembled ${assembled.sizeBytes} bytes for upload ${id}, expected ${upload.sizeBytes}`,
      );
    }

    const capture =
      upload.captureId !== undefined ? await this.store.capture(upload.captureId) : undefined;
    if (upload.captureId !== undefined && !capture)
      throw new NotFound(`capture ${upload.captureId}`);
    const at = this.now().toISOString();
    const job: IngestJob = {
      id: ulid(),
      channelId: upload.channelId,
      source: capture ? capture.recorderId : UPLOAD_SOURCE,
      sourceKind: capture ? 'recorder' : 'upload',
      state: 'detected',
      filename: upload.filename,
      sizeBytes: assembled.sizeBytes,
      checksum: assembled.sha256,
      ...(upload.contentType !== undefined ? { contentType: upload.contentType } : {}),
      receivedPath: assembled.path,
      createdBy: upload.createdBy,
      createdAt: at,
      updatedAt: at,
      version: 1,
    };
    const done: Upload = { ...upload, state: 'completed', jobId: job.id };
    await this.store.transaction(async (tx) => {
      await tx.putJob(job);
      await tx.putUpload(done);
      if (capture) {
        if (!(await tx.putCapture({ ...capture, jobId: job.id }, capture.state))) {
          throw new Conflict(`capture ${capture.id} changed while its file was handed over`);
        }
        await tx.enqueue(
          this.record(origin, job.channelId, 'recording.segment.completed', {
            recorderId: capture.recorderId,
            captureId: capture.id,
            jobId: job.id,
            fileStart: capture.fileStart,
            fileEnd: capture.fileEnd,
            part: capture.part,
            partial: capture.state === 'partial',
            ...(capture.startedAt !== undefined ? { startedAt: capture.startedAt } : {}),
            ...(capture.endedAt !== undefined ? { endedAt: capture.endedAt } : {}),
            sizeBytes: job.sizeBytes,
            checksum: { algorithm: 'sha256', value: job.checksum },
          } satisfies EventPayloads['recording.segment.completed']),
        );
      }
      await tx.enqueue(
        this.record(origin, job.channelId, 'ingest.detected', {
          source: job.source,
          sourceKind: job.sourceKind,
          path: assembled.path,
          sizeBytes: job.sizeBytes,
        } satisfies EventPayloads['ingest.detected']),
      );
      // The path is where the bytes sit on this node's disk — an operator's detail, not the
      // trail's. Everything else about the job is.
      await tx.enqueue(this.audit(origin, job, undefined, job, 'ingest.detected'));
    });
    this.defer(() => this.validate(job.id).then(() => undefined));
    return job;
  }

  /** Abandon an upload: its parts go, its row goes. Nothing was announced, so nothing is retracted. */
  async abort(caller: Caller, id: string): Promise<void> {
    this.authorize(caller, 'ingest:write');
    const upload = await this.uploadFor(caller, id);
    if (upload.state !== 'open') throw new Conflict(`upload ${id} is already complete`);
    await this.store.transaction((tx) => tx.deleteUpload(id));
    await this.staging.discard(id);
  }

  /**
   * Discard open uploads past their expiry. Run on a timer by main.ts; returns how many went.
   * Rows first, then disk — an upload whose row is gone cannot be resumed, so its parts are
   * garbage whatever happens next; the other order could leave a resumable row with no bytes.
   */
  async sweep(limit = 100): Promise<number> {
    const expired = await this.store.expiredUploads(this.now().toISOString(), limit);
    for (const upload of expired) {
      await this.store.transaction((tx) => tx.deleteUpload(upload.uploadId));
      await this.staging.discard(upload.uploadId);
    }
    return expired.length;
  }

  // --- validation (EP-15.3, EP-15.4) --------------------------------------------------------------------

  /**
   * Take a `detected` job through `validating` — the probe, then the channel's acceptance
   * rules — and commit the verdict. Idempotent and safe to race: a job in any other state is
   * returned as it is; each write is guarded by the state it read, so of two validators one
   * takes the job and one applies the verdict. A job found already `validating` (a crash mid-
   * probe, picked up by `recover`) is probed again. System-initiated — the actor is this service.
   */
  async validate(jobId: string): Promise<IngestJob | undefined> {
    const found = await this.store.job(jobId);
    if (!found || (found.state !== 'detected' && found.state !== 'validating')) return found;
    const origin: Origin = { actor: SERVICE_ACTOR };
    let job = found;
    if (job.state === 'detected') {
      const taken: IngestJob = {
        ...job,
        state: 'validating',
        updatedAt: this.now().toISOString(),
        version: job.version + 1,
      };
      const took = await this.store.transaction(async (tx) => {
        if (!(await tx.putJob(taken, 'detected'))) return false;
        await tx.enqueue(this.audit(origin, taken, job, taken, 'ingest.validating'));
        return true;
      });
      if (!took) return this.store.job(jobId);
      job = taken;
    }

    // The probe, outside any transaction. What it says about the bytes is a verdict; what goes
    // wrong with the tool propagates — the job stays `validating` for the loop to retry.
    let metadata: TechnicalMetadata | undefined;
    let refusal: string | undefined;
    if (job.receivedPath === undefined) {
      refusal = 'there is no received file to read';
    } else {
      try {
        metadata = await this.probe.probe(job.receivedPath);
      } catch (err) {
        if (!(err instanceof ProbeRefusal)) throw err;
        refusal = err.message;
      }
    }
    const verdict: Verdict =
      refusal !== undefined
        ? { outcome: 'quarantined', reason: `could not be probed: ${refusal}` }
        : evaluate(await this.store.ruleSets(job.channelId), {
            source: job.source,
            sourceKind: job.sourceKind,
            filename: job.filename,
            sizeBytes: job.sizeBytes,
            ...(metadata !== undefined ? { technicalMetadata: metadata } : {}),
          });

    const next: IngestJob = {
      ...job,
      ...(metadata !== undefined ? { technicalMetadata: metadata } : {}),
      state: verdict.outcome,
      ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
      ...(verdict.ruleId !== undefined ? { ruleId: verdict.ruleId } : {}),
      ...(verdict.ruleSetId !== undefined ? { ruleSetId: verdict.ruleSetId } : {}),
      updatedAt: this.now().toISOString(),
      version: job.version + 1,
    };
    // A rejected job's bytes are garbage by decision. The row keeps the record; the path goes
    // with the file, below, after the commit.
    if (verdict.outcome === 'rejected') delete next.receivedPath;
    const applied = await this.store.transaction(async (tx) => {
      if (!(await tx.putJob(next, 'validating'))) return false;
      if (verdict.outcome !== 'accepted') {
        await tx.enqueue(
          this.record(origin, job.channelId, 'ingest.rejected', {
            ingestJobId: job.id,
            source: job.source,
            reason: verdict.reason ?? 'refused by an acceptance rule',
            ...(verdict.ruleId !== undefined ? { ruleId: verdict.ruleId } : {}),
            quarantined: verdict.outcome === 'quarantined',
          } satisfies EventPayloads['ingest.rejected']),
        );
      }
      const action = verdict.outcome === 'accepted' ? 'ingest.validated' : 'ingest.rejected';
      await tx.enqueue(this.audit(origin, next, job, next, action));
      return true;
    });
    if (!applied) return this.store.job(jobId);
    if (verdict.outcome === 'rejected' && job.receivedPath !== undefined) {
      await this.discardBytes(job.receivedPath, job.id);
    }
    return next;
  }

  /**
   * Validate the jobs whose validation never finished — `detected` or `validating` for longer
   * than a probe takes. Run on a timer by main.ts alongside the sweeper; returns how many it
   * took. A tool failure on one job is reported and the rest still run.
   */
  async recover(limit = 100): Promise<number> {
    const before = new Date(this.now().getTime() - this.validateAfterMs).toISOString();
    const stale = [
      ...(await this.store.jobsInState('detected', before, limit)),
      ...(await this.store.jobsInState('validating', before, limit)),
    ];
    for (const job of stale) {
      try {
        await this.validate(job.id);
      } catch (err) {
        this.onBackgroundError(err, { task: 'recover', jobId: job.id });
      }
    }
    return stale.length;
  }

  // --- the queue and the review (EP-15.6) ------------------------------------------------------------

  async job(caller: Caller, id: string): Promise<IngestJob> {
    this.authorize(caller, 'ingest:read');
    return this.jobFor(caller, id);
  }

  async queue(caller: Caller, query: JobQuery): Promise<IngestQueuePage> {
    this.authorize(caller, 'ingest:read');
    const rows = await this.store.jobs(caller.channelId, query);
    const items = rows.slice(0, query.limit);
    const last = items[items.length - 1];
    return rows.length > query.limit && last !== undefined
      ? { items, nextCursor: last.id }
      : { items };
  }

  /** The operator override: a quarantined job becomes accepted. The rule that held it moves to the history. */
  async acceptJob(caller: Caller, id: string): Promise<IngestJob> {
    this.authorize(caller, 'ingest:approve');
    const job = await this.jobFor(caller, id);
    if (job.state !== 'quarantined') {
      throw new Conflict(`ingest job ${id} is ${job.state}, not quarantined`);
    }
    const { reason: _r, ruleId: _i, ruleSetId: _s, ...kept } = job;
    void _r;
    void _i;
    void _s;
    const next: IngestJob = {
      ...kept,
      state: 'accepted',
      updatedAt: this.now().toISOString(),
      version: job.version + 1,
    };
    const origin = this.originOf(caller);
    await this.transition(job, next, 'quarantined', (tx) =>
      tx.enqueue(this.audit(origin, next, job, next, 'ingest.accept')),
    );
    return next;
  }

  /** The operator discard: a quarantined job becomes rejected, with the operator's reason; its bytes go. */
  async rejectJob(caller: Caller, id: string, reason: string): Promise<IngestJob> {
    this.authorize(caller, 'ingest:approve');
    const text = reason.trim();
    if (text.length === 0 || text.length > 1000) {
      throw new ValidationError('reason must be 1..1000 characters');
    }
    const job = await this.jobFor(caller, id);
    if (job.state !== 'quarantined') {
      throw new Conflict(`ingest job ${id} is ${job.state}, not quarantined`);
    }
    const next: IngestJob = {
      ...job,
      state: 'rejected',
      reason: text,
      updatedAt: this.now().toISOString(),
      version: job.version + 1,
    };
    delete next.receivedPath;
    const origin = this.originOf(caller);
    await this.transition(job, next, 'quarantined', async (tx) => {
      await tx.enqueue(
        this.record(origin, job.channelId, 'ingest.rejected', {
          ingestJobId: job.id,
          source: job.source,
          reason: text,
          quarantined: false,
        } satisfies EventPayloads['ingest.rejected']),
      );
      await tx.enqueue(this.audit(origin, next, job, next, 'ingest.rejected'));
    });
    if (job.receivedPath !== undefined) await this.discardBytes(job.receivedPath, job.id);
    return next;
  }

  // --- the rule sets (EP-15.3) --------------------------------------------------------------------------

  async ruleSets(caller: Caller): Promise<AcceptanceRuleSet[]> {
    this.authorize(caller, 'ingest:admin');
    return this.store.ruleSets(caller.channelId);
  }

  async ruleSet(caller: Caller, id: string): Promise<AcceptanceRuleSet> {
    this.authorize(caller, 'ingest:admin');
    return this.ruleSetFor(caller, id);
  }

  async createRuleSet(caller: Caller, input: AcceptanceRuleSetInput): Promise<AcceptanceRuleSet> {
    this.authorize(caller, 'ingest:admin');
    const set = newRuleSet(input, caller, this.now().toISOString());
    const origin = this.originOf(caller);
    await this.store.transaction(async (tx) => {
      await tx.putRuleSet(set);
      await tx.enqueue(this.auditRules(origin, set, undefined, set, 'acceptance-rules.created'));
    });
    return set;
  }

  /** The whole set, as given — like a reel's items (scheduling): what the editor shows is what is saved. */
  async replaceRuleSet(
    caller: Caller,
    id: string,
    input: AcceptanceRuleSetInput,
  ): Promise<AcceptanceRuleSet> {
    this.authorize(caller, 'ingest:admin');
    const before = await this.ruleSetFor(caller, id);
    const set: AcceptanceRuleSet = {
      ...before,
      ...input,
      updatedAt: this.now().toISOString(),
      version: before.version + 1,
    };
    const origin = this.originOf(caller);
    await this.store.transaction(async (tx) => {
      await tx.putRuleSet(set);
      await tx.enqueue(this.auditRules(origin, set, before, set, 'acceptance-rules.replaced'));
    });
    return set;
  }

  async deleteRuleSet(caller: Caller, id: string): Promise<void> {
    this.authorize(caller, 'ingest:admin');
    const before = await this.ruleSetFor(caller, id);
    const origin = this.originOf(caller);
    await this.store.transaction(async (tx) => {
      await tx.deleteRuleSet(id);
      // The revision after the last one the set had: a deletion is a mutation like any other,
      // and the history's key is (entity, revision) — a repeat is refused (EP-10.6).
      await tx.enqueue(
        this.auditRules(
          origin,
          { ...before, version: before.version + 1 },
          before,
          undefined,
          'acceptance-rules.deleted',
        ),
      );
    });
  }

  // --- the recorder's hand-off (EP-39; ADR-0008) ------------------------------------------------------
  //
  // Reached only through the SIGNED internal routes. Authority comes from the capture the request
  // names — its channel, the recorder as source — never from the request; the actor is the service.

  /** An upload for a finished capture's file: the same parts, sized by the server, as any upload. */
  async startCaptureUpload(captureId: string, input: StartUploadInput): Promise<UploadStatus> {
    const capture = await this.store.capture(captureId);
    if (!capture) throw new NotFound(`capture ${captureId}`);
    if (capture.state !== 'completed' && capture.state !== 'partial') {
      throw new Conflict(
        `capture ${captureId} is ${capture.state}; only a finished capture is handed over`,
      );
    }
    if (capture.jobId !== undefined) {
      throw new Conflict(`capture ${captureId} was handed over already, as job ${capture.jobId}`);
    }
    const upload: Upload = {
      ...newUpload(
        input,
        { userId: RECORDER_ACTOR.id, channelId: capture.channelId },
        {
          partSizeBytes: this.partSizeBytes,
          ttlMs: this.uploadTtlMs,
          now: this.now().getTime(),
        },
      ),
      captureId,
    };
    await this.store.transaction((tx) => tx.putUpload(upload));
    return { ...upload, received: [] };
  }

  async putCapturePart(uploadId: string, n: number, bytes: Uint8Array): Promise<void> {
    await this.storePart(await this.captureUpload(uploadId), n, bytes);
  }

  /** What the worker resumes from: the parts RIM holds. */
  async captureUploadStatus(uploadId: string): Promise<UploadStatus> {
    const upload = await this.captureUpload(uploadId);
    return { ...upload, received: (await this.store.parts(uploadId)).map((p) => p.n) };
  }

  async completeCaptureUpload(uploadId: string): Promise<IngestJob> {
    return this.completeUpload(await this.captureUpload(uploadId), { actor: RECORDER_ACTOR });
  }

  /** An upload the internal routes may touch: a recorder's, and only a recorder's. */
  private async captureUpload(uploadId: string): Promise<Upload> {
    const upload = await this.store.upload(uploadId);
    if (!upload || upload.captureId === undefined) throw new NotFound(`upload ${uploadId}`);
    return upload;
  }

  // --- folder watchers (EP-15.2) ---------------------------------------------------------------------

  async watchers(caller: Caller): Promise<Watcher[]> {
    this.authorize(caller, 'ingest:admin');
    return this.store.watchers(caller.channelId);
  }

  async watcher(caller: Caller, id: string): Promise<Watcher> {
    this.authorize(caller, 'ingest:admin');
    return this.watcherFor(caller, id);
  }

  /**
   * A new watcher, refused before anything is written when it could never run: no watch root, a
   * path out of the channel's directory (symlinks included), or a folder another enabled watcher
   * of the channel already has — two watchers on one folder would each take every file.
   */
  async createWatcher(caller: Caller, input: WatcherInput): Promise<Watcher> {
    this.authorize(caller, 'ingest:admin');
    const at = this.now().toISOString();
    const watcher = this.watcherRecord(input, caller.channelId, {
      id: ulid(),
      createdBy: caller.userId,
      createdAt: at,
      updatedAt: at,
      version: 1,
    });
    await this.checkWatcher(watcher);
    const origin = this.originOf(caller);
    await this.store.transaction(async (tx) => {
      await tx.putWatcher(watcher);
      await tx.enqueue(this.auditWatcher(origin, watcher, undefined, watcher, 'watcher.created'));
    });
    return watcher;
  }

  /** The whole watcher, as given. `enabled: false` stops it; there is no delete — jobs name it. */
  async replaceWatcher(caller: Caller, id: string, input: WatcherInput): Promise<Watcher> {
    this.authorize(caller, 'ingest:admin');
    const before = await this.watcherFor(caller, id);
    const watcher = this.watcherRecord(input, caller.channelId, {
      id,
      createdBy: before.createdBy,
      createdAt: before.createdAt,
      updatedAt: this.now().toISOString(),
      version: before.version + 1,
    });
    await this.checkWatcher(watcher);
    const origin = this.originOf(caller);
    await this.store.transaction(async (tx) => {
      await tx.putWatcher(watcher);
      await tx.enqueue(this.auditWatcher(origin, watcher, before, watcher, 'watcher.replaced'));
    });
    return watcher;
  }

  /**
   * One pass over every enabled watcher — run on a timer by main.ts.
   *
   * Per watcher: take (or renew) its lease, or leave it to whoever holds it; then every candidate
   * file in its folder goes through three gates. ALREADY TAKEN — the ledger has this name at this
   * size and mtime — is not read again (with `delete`, it is a file a crash left behind after its
   * job committed, and it is removed now). NOT SETTLED — its size or mtime moved since it was
   * last seen, or has not held still for `settleSeconds` — is left for a later pass. Otherwise it
   * is copied into staging and hashed, and if it did not change while being copied, the pickup,
   * the job, `ingest.detected` and the audit commit together; the ledger's key (watcher, name,
   * checksum) makes the same bytes a duplicate however they arrive. Only then is the source
   * removed (`delete`), and validation follows as it does for an upload.
   */
  async scanWatchers(): Promise<WatchReport> {
    const report: WatchReport = {
      scanned: 0,
      pickedUp: 0,
      duplicates: 0,
      skipped: 0,
      problems: [],
    };
    if (this.watchRoot === undefined) return report;
    for (const watcher of await this.store.enabledWatchers()) {
      const nowMs = this.now().getTime();
      const leased = await this.store.transaction((tx) =>
        tx.leaseWatcher(
          watcher.id,
          watcher.channelId,
          this.holder,
          new Date(nowMs).toISOString(),
          new Date(nowMs + this.watchLeaseMs).toISOString(),
        ),
      );
      if (!leased) {
        report.skipped += 1;
        continue;
      }
      report.scanned += 1;
      const where = await watchDir(this.watchRoot, watcher.channelId, watcher.path);
      if ('missing' in where) {
        report.problems.push({
          watcherId: watcher.id,
          problem: `folder ${where.missing} does not exist`,
        });
        continue;
      }
      if ('escapes' in where) {
        report.problems.push({
          watcherId: watcher.id,
          problem: `folder resolves to ${where.escapes}, outside the channel's watch directory`,
        });
        continue;
      }
      await this.scanFolder(watcher, where.dir, report);
    }
    return report;
  }

  private async scanFolder(watcher: Watcher, dir: string, report: WatchReport): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    const present = new Set<string>();
    for (const entry of entries) {
      // A regular file, directly in the folder. Not a symlink: its target could be anywhere.
      if (!entry.isFile() || !isCandidate(entry.name, watcher.extensions)) continue;
      present.add(entry.name);
      const outcome = await this.considerFile(watcher, dir, entry.name);
      if (outcome === 'picked-up') report.pickedUp += 1;
      if (outcome === 'duplicate') report.duplicates += 1;
    }
    // A file that went away takes its settle clock with it.
    const prefix = `${watcher.id}\u0000`;
    for (const key of this.settling.keys()) {
      if (key.startsWith(prefix) && !present.has(key.slice(prefix.length)))
        this.settling.delete(key);
    }
  }

  private async considerFile(
    watcher: Watcher,
    dir: string,
    name: string,
  ): Promise<'picked-up' | 'duplicate' | 'waiting'> {
    const source = join(dir, name);
    const seen = await statFile(source);
    if (!seen) return 'waiting';

    const taken = await this.store.pickup(watcher.id, name);
    if (taken && taken.sizeBytes === seen.size && taken.mtimeMs === seen.mtimeMs) {
      if (watcher.afterPickup === 'delete') await rm(source, { force: true });
      return 'waiting';
    }

    const key = `${watcher.id}\u0000${name}`;
    const nowMs = this.now().getTime();
    const clock = this.settling.get(key);
    if (!clock || clock.sizeBytes !== seen.size || clock.mtimeMs !== seen.mtimeMs) {
      this.settling.set(key, { sizeBytes: seen.size, mtimeMs: seen.mtimeMs, since: nowMs });
      return 'waiting';
    }
    if (nowMs - clock.since < watcher.settleSeconds * 1000) return 'waiting';

    const jobId = ulid();
    const staged = await this.staging.adopt(jobId, source, name);
    const after = await statFile(source);
    if (!after || after.size !== seen.size || after.mtimeMs !== seen.mtimeMs) {
      // It changed while it was being copied: not settled after all. Start its clock again.
      await this.staging.discardReceived(staged.path);
      this.settling.delete(key);
      return 'waiting';
    }

    const at = this.now().toISOString();
    const job: IngestJob = {
      id: jobId,
      channelId: watcher.channelId,
      source: watcher.id,
      sourceKind: 'watch',
      state: 'detected',
      filename: name,
      sizeBytes: staged.sizeBytes,
      checksum: staged.sha256,
      receivedPath: staged.path,
      createdBy: 'rim',
      createdAt: at,
      updatedAt: at,
      version: 1,
    };
    const pickup: Pickup = {
      watcherId: watcher.id,
      channelId: watcher.channelId,
      name,
      sha256: staged.sha256,
      sizeBytes: seen.size,
      mtimeMs: seen.mtimeMs,
      jobId,
      at,
    };
    const origin: Origin = { actor: SERVICE_ACTOR };
    const created = await this.store.transaction(async (tx) => {
      if (!(await tx.putPickup(pickup))) return false;
      await tx.putJob(job);
      await tx.enqueue(
        this.record(origin, job.channelId, 'ingest.detected', {
          source: job.source,
          sourceKind: job.sourceKind,
          path: staged.path,
          sizeBytes: job.sizeBytes,
        } satisfies EventPayloads['ingest.detected']),
      );
      await tx.enqueue(this.audit(origin, job, undefined, job, 'ingest.detected'));
      return true;
    });
    this.settling.delete(key);
    if (!created) {
      // These bytes, under this name, were taken before (its mtime was touched, or the ledger
      // row was written by a scan that crashed before removing the source). Nothing new.
      await this.staging.discardReceived(staged.path);
      if (watcher.afterPickup === 'delete') await rm(source, { force: true });
      return 'duplicate';
    }
    if (watcher.afterPickup === 'delete') await rm(source, { force: true });
    this.defer(() => this.validate(job.id).then(() => undefined));
    return 'picked-up';
  }

  private watcherRecord(
    input: WatcherInput,
    channelId: string,
    meta: Pick<Watcher, 'id' | 'createdBy' | 'createdAt' | 'updatedAt' | 'version'>,
  ): Watcher {
    const errors = watcherErrors(input);
    if (errors.length > 0) throw new ValidationError(errors.join('; '));
    // Field by field, not a spread: the body is the caller's, and a stray key must not be kept.
    return {
      id: meta.id,
      channelId,
      name: input.name.trim(),
      path: normalisedPath(input.path),
      settleSeconds: input.settleSeconds ?? DEFAULT_SETTLE_SECONDS,
      ...(input.extensions !== undefined && input.extensions.length > 0
        ? { extensions: [...input.extensions] }
        : {}),
      afterPickup: input.afterPickup ?? 'delete',
      enabled: input.enabled ?? true,
      createdBy: meta.createdBy,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      version: meta.version,
    };
  }

  private async checkWatcher(watcher: Watcher): Promise<void> {
    if (this.watchRoot === undefined) {
      throw new ValidationError(
        'this RIM has no watch root (ATLAS_RIM_WATCH_ROOT); nothing can be watched',
      );
    }
    const where = await watchDir(this.watchRoot, watcher.channelId, watcher.path);
    if ('escapes' in where) {
      throw new ValidationError("path resolves outside the channel's watch directory");
    }
    if (!watcher.enabled) return;
    const clash = (await this.store.watchers(watcher.channelId)).find(
      (w) => w.id !== watcher.id && w.enabled && w.path === watcher.path,
    );
    if (clash) {
      throw new Conflict(`watcher ${clash.id} already watches ${watcher.path}; disable it first`);
    }
  }

  private async watcherFor(caller: Caller, id: string): Promise<Watcher> {
    const watcher = await this.store.watcher(id);
    if (!watcher || watcher.channelId !== caller.channelId) throw new NotFound(`watcher ${id}`);
    return watcher;
  }

  private auditWatcher(
    origin: Origin,
    at: Watcher,
    before: Watcher | undefined,
    after: Watcher,
    action: string,
  ): OutboxRecord {
    return this.record(origin, at.channelId, 'audit.recorded', {
      entityType: 'watcher',
      entityId: at.id,
      revision: at.version,
      action,
      origin: { service: 'rim' },
      delta: delta(
        before as unknown as Record<string, unknown> | undefined,
        after as unknown as Record<string, unknown>,
      ),
    } satisfies EventPayloads['audit.recorded']);
  }

  // --- recorders (EP-39; ADR-0007) --------------------------------------------------------------------

  async recorders(caller: Caller): Promise<Recorder[]> {
    this.authorize(caller, 'ingest:admin');
    return this.store.recorders(caller.channelId);
  }

  async recorder(caller: Caller, id: string): Promise<Recorder> {
    this.authorize(caller, 'ingest:admin');
    return this.recorderFor(caller, id);
  }

  /** A new recorder, audited, and its next captures planned at once — not a minute later. */
  async createRecorder(caller: Caller, input: RecorderInput): Promise<Recorder> {
    this.authorize(caller, 'ingest:admin');
    const at = this.now().toISOString();
    const recorder = this.recorderRecord(input, caller.channelId, {
      id: ulid(),
      createdBy: caller.userId,
      createdAt: at,
      updatedAt: at,
      version: 1,
    });
    const origin = this.originOf(caller);
    await this.store.transaction(async (tx) => {
      await tx.putRecorder(recorder);
      await tx.enqueue(
        this.auditRecorder(origin, recorder, undefined, recorder, 'recorder.created'),
      );
    });
    if (recorder.enabled) await this.planRecorder(recorder);
    return recorder;
  }

  /**
   * The whole recorder, as given. Its captures that have not STARTED are planned again from the
   * new windows — a running capture finishes as it was planned, so a change never cuts a file.
   * `enabled: false` plans nothing: what has not started is removed.
   */
  async replaceRecorder(caller: Caller, id: string, input: RecorderInput): Promise<Recorder> {
    this.authorize(caller, 'ingest:admin');
    const before = await this.recorderFor(caller, id);
    const recorder = this.recorderRecord(input, caller.channelId, {
      id,
      createdBy: before.createdBy,
      createdAt: before.createdAt,
      updatedAt: this.now().toISOString(),
      version: before.version + 1,
    });
    const origin = this.originOf(caller);
    const now = this.now().toISOString();
    await this.store.transaction(async (tx) => {
      await tx.putRecorder(recorder);
      await tx.deletePlanned(id, now);
      await tx.enqueue(this.auditRecorder(origin, recorder, before, recorder, 'recorder.replaced'));
    });
    if (recorder.enabled) await this.planRecorder(recorder);
    return recorder;
  }

  /** A recorder's captures from `from` (default: six hours ago), oldest first. */
  async recorderCaptures(
    caller: Caller,
    id: string,
    query: { from?: string; limit?: number } = {},
  ): Promise<Omit<Capture, 'leaseUntil'>[]> {
    this.authorize(caller, 'ingest:admin');
    await this.recorderFor(caller, id);
    const from = query.from ?? new Date(this.now().getTime() - 6 * 3600_000).toISOString();
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    return (await this.store.captures(id, new Date(from).toISOString(), limit)).map(captureView);
  }

  /**
   * One planning pass — run on a timer by main.ts. Every enabled recorder's captures are planned
   * up to the horizon, continuing from the last one planned (and from its slot, so no two
   * consecutive captures share one); and a planned capture whose span has ENDED with no worker
   * having taken it is `missed` — a hole in the recording, said out loud rather than left planned.
   */
  async planRecorders(): Promise<PlanReport> {
    const report: PlanReport = { recorders: 0, planned: 0, missed: 0 };
    for (const recorder of await this.store.enabledRecorders()) {
      report.recorders += 1;
      report.planned += await this.planRecorder(recorder);
    }
    const now = this.now().toISOString();
    for (const c of await this.store.capturesEndedIn('planned', now, 500)) {
      const missed: Capture = { ...c, state: 'missed', reason: 'no recorder worker took it' };
      if (await this.store.transaction((tx) => tx.putCapture(missed, 'planned')))
        report.missed += 1;
    }
    return report;
  }

  /**
   * Plan one recorder up to the horizon. A file already under way when planning starts (a
   * recorder enabled at 10:20 with hourly files) is planned too: its capture starts late, and the
   * part of the hour after that is recorded rather than the whole hour lost.
   */
  private async planRecorder(recorder: Recorder): Promise<number> {
    const now = this.now().getTime();
    const last = await this.store.lastCapture(recorder.id);
    const lastEnd = last ? Date.parse(last.fileEnd) : -Infinity;
    const from = Math.max(lastEnd, now - recorder.fileMinutes * 60_000);
    const files = planFiles(
      recorder,
      from,
      now + this.planHorizonMs,
      last ? { slot: last.slot } : undefined,
    ).filter((f) => Date.parse(f.fileEnd) > now);
    if (files.length === 0) return 0;
    let planned = 0;
    await this.store.transaction(async (tx) => {
      for (const f of files) {
        const inserted = await tx.insertCapture({
          id: ulid(),
          recorderId: recorder.id,
          channelId: recorder.channelId,
          ...f,
          part: 1,
          state: 'planned',
        });
        if (inserted) planned += 1;
      }
    });
    return planned;
  }

  private recorderRecord(
    input: RecorderInput,
    channelId: string,
    meta: Pick<Recorder, 'id' | 'createdBy' | 'createdAt' | 'updatedAt' | 'version'>,
  ): Recorder {
    const errors = recorderErrors(input);
    if (errors.length > 0) throw new ValidationError(errors.join('; '));
    // Field by field: the body is the caller's, and a stray key must not be kept.
    return {
      id: meta.id,
      channelId,
      name: input.name.trim(),
      input: {
        url: input.input.url,
        ...(input.input.passphraseSecret !== undefined
          ? { passphraseSecret: input.input.passphraseSecret }
          : {}),
      },
      timezone: input.timezone,
      windows: input.windows.map((w) => ({ days: [...w.days], from: w.from, to: w.to })),
      fileMinutes: input.fileMinutes ?? DEFAULT_FILE_MINUTES,
      padSeconds: input.padSeconds ?? DEFAULT_PAD_SECONDS,
      enabled: input.enabled ?? true,
      createdBy: meta.createdBy,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      version: meta.version,
    };
  }

  private async recorderFor(caller: Caller, id: string): Promise<Recorder> {
    const recorder = await this.store.recorder(id);
    if (!recorder || recorder.channelId !== caller.channelId) throw new NotFound(`recorder ${id}`);
    return recorder;
  }

  private auditRecorder(
    origin: Origin,
    at: Recorder,
    before: Recorder | undefined,
    after: Recorder,
    action: string,
  ): OutboxRecord {
    return this.record(origin, at.channelId, 'audit.recorded', {
      entityType: 'recorder',
      entityId: at.id,
      revision: at.version,
      action,
      origin: { service: 'rim' },
      delta: delta(
        before as unknown as Record<string, unknown> | undefined,
        after as unknown as Record<string, unknown>,
      ),
    } satisfies EventPayloads['audit.recorded']);
  }

  // --- internals -------------------------------------------------------------------------------------

  private authorize(caller: Caller, permission: string): void {
    const decision = canEnforce(caller.policy, permission, {
      type: 'ingest',
      channelId: caller.channelId,
    });
    if (!decision.allowed) throw new Forbidden(decision.reason ?? `missing ${permission}`);
  }

  private async uploadFor(caller: Caller, id: string): Promise<Upload> {
    const upload = await this.store.upload(id);
    // Another channel's upload, and a recorder's (the internal hand-off's alone, ADR-0008), are
    // not found — status, parts, completion and abort alike.
    if (!upload || upload.channelId !== caller.channelId || upload.captureId !== undefined) {
      throw new NotFound(`upload ${id}`);
    }
    return upload;
  }

  private async jobFor(caller: Caller, id: string): Promise<IngestJob> {
    const job = await this.store.job(id);
    if (!job || job.channelId !== caller.channelId) throw new NotFound(`ingest job ${id}`);
    return job;
  }

  private async ruleSetFor(caller: Caller, id: string): Promise<AcceptanceRuleSet> {
    const set = await this.store.ruleSet(id);
    if (!set || set.channelId !== caller.channelId) throw new NotFound(`acceptance rule set ${id}`);
    return set;
  }

  /** A state transition: the guarded write, then what accompanies it — or a 409 if the job moved. */
  private async transition(
    from: IngestJob,
    to: IngestJob,
    ifState: IngestJob['state'],
    accompany: (tx: RimTx) => Promise<void>,
  ): Promise<void> {
    const applied = await this.store.transaction(async (tx) => {
      if (!(await tx.putJob(to, ifState))) return false;
      await accompany(tx);
      return true;
    });
    if (!applied) throw new Conflict(`ingest job ${from.id} is no longer ${ifState}`);
  }

  /** Best effort, after the commit: a file that survives is a leak an operator can see, not a lie in a row. */
  private async discardBytes(path: string, jobId: string): Promise<void> {
    try {
      await this.staging.discardReceived(path);
    } catch (err) {
      this.onBackgroundError(err, { task: 'discard received bytes', jobId });
    }
  }

  private originOf(caller: Caller): Origin {
    return {
      actor: { kind: 'user', id: caller.userId },
      ...(caller.correlationId !== undefined ? { correlationId: caller.correlationId } : {}),
    };
  }

  private audit(
    origin: Origin,
    at: IngestJob,
    before: IngestJob | undefined,
    after: IngestJob,
    action: string,
  ): OutboxRecord {
    return this.record(origin, at.channelId, 'audit.recorded', {
      entityType: 'ingest',
      entityId: at.id,
      revision: at.version,
      action,
      origin: { service: 'rim' },
      delta: delta(before === undefined ? undefined : audited(before), audited(after)),
    } satisfies EventPayloads['audit.recorded']);
  }

  private auditRules(
    origin: Origin,
    at: AcceptanceRuleSet,
    before: AcceptanceRuleSet | undefined,
    after: AcceptanceRuleSet | undefined,
    action: string,
  ): OutboxRecord {
    return this.record(origin, at.channelId, 'audit.recorded', {
      entityType: 'acceptance-rule-set',
      entityId: at.id,
      revision: at.version,
      action,
      origin: { service: 'rim' },
      delta: delta(
        before as unknown as Record<string, unknown> | undefined,
        (after ?? {}) as unknown as Record<string, unknown>,
      ),
    } satisfies EventPayloads['audit.recorded']);
  }

  private record(origin: Origin, channelId: string, type: string, payload: object): OutboxRecord {
    const check = validatePayload(type, payload);
    if (!check.valid) {
      throw new ValidationError(
        `${type} payload does not match its schema: ${check.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
      );
    }
    const envelope: Envelope = buildEnvelope({
      type,
      channelId,
      payload: payload as Record<string, unknown>,
      actor: origin.actor,
      ...(origin.correlationId !== undefined ? { correlationId: origin.correlationId } : {}),
    });
    const headers = this.traceHeaders();
    return {
      id: envelope.messageId,
      message: {
        id: envelope.messageId,
        subject: subjectFor(channelId, type),
        body: envelope,
        ...(headers !== undefined ? { headers } : {}),
      },
    };
  }
}

/** A regular file's size and mtime, or undefined when it has gone (another process took it). */
async function statFile(path: string): Promise<{ size: number; mtimeMs: number } | undefined> {
  try {
    const s = await stat(path);
    return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}
