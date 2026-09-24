// MTS's service layer (EP-16.1/16.2/16.5): enqueue a job, run one, say what happened.
//
// The shape of the thing: a command or a request creates a QUEUED row and commits, with its audit
// record, and returns. A worker later leases that row, runs FFmpeg once per preset, checksums
// each output, and commits the outcome with the events it announces. Nothing about the encoding
// happens inside a transaction — a database transaction held open for the length of a transcode
// is a connection pool exhausted by four jobs.
//
// What is and is not retried is the load-bearing distinction, and it comes from the transcoder
// port: a `TranscodeRefusal` is about the BYTES (no number of retries makes an unreadable file
// readable, so the job is dead-lettered with the reason), anything else is about the tool or the
// machine (retried until the attempts are spent). Getting this backwards either dead-letters work
// that would have succeeded or loops forever on a file that never will.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import {
  buildEnvelope,
  delta,
  envelopeShapeErrors,
  subjectFor,
  ulid,
  validatePayload,
  type Envelope,
  type EventPayloads,
} from '@atlas/contracts';
import type { Message, OutboxRecord } from '@atlas/messaging';
import { canEnforce, type EffectivePolicy } from '@atlas/policy';
import { Forbidden, NotFound, ValidationError } from '@atlas/service-kit';
import { canTransition, renditionsFor, type RenditionResult, type TranscodeJob } from './job.ts';
import { presetById, unknownPresets, type Preset } from './preset.ts';
import type { JobStore } from './store.ts';
import { TranscodeRefusal, type Transcoder } from './transcoder.ts';

export interface MtsOptions {
  store: JobStore;
  transcoder: Transcoder;
  /**
   * Where inputs are read from and outputs are written under.
   *
   * Until HSM (EP-14) resolves paths, a job's `inputPath` must live inside this root and outputs
   * are written beside it under `renditions/<jobId>/`. The containment check is not decoration: a
   * job arrives over the broker, and `../../etc/passwd` is a path like any other until something
   * refuses it.
   */
  workRoot: string;
  /** How many times an attempt may fail before the job is dead-lettered. Default 3. */
  maxAttempts?: number;
  /**
   * The first retry's delay; each later one doubles it, capped at ten minutes. Default 30 s.
   * Tests pass 0.
   */
  retryBaseMs?: number;
  /** This process, for `transcode.started` and for operators reading logs. */
  workerId?: string;
  now?: () => Date;
  traceHeaders?: () => Record<string, string> | undefined;
}

export interface EnqueueInput {
  assetId: string;
  presetIds: string[];
  inputPath: string;
  priority?: number;
}

export interface Caller {
  userId: string;
  channelId: string;
  /**
   * The caller's compiled policy. Required for every HTTP path; absent only on the platform's
   * own writes (a broker command, the worker), which do not go through `authorize` at all.
   */
  policy?: EffectivePolicy;
  actorKind?: 'user' | 'service';
  correlationId?: string;
}

/**
 * The field group renditions belong to. MAM puts the file set in `files` — the Librarian's half,
 * not the Editor's (authorization-model.md §3.1) — so producing renditions is a write to it, and
 * reading a job's renditions a read of it. The same grant MAM's `GET /assets/{id}/files` asks for.
 */
const FILES_GROUP = 'files';

/** What a run of the worker did, for the loop that calls it and for the tests. */
export type RunOutcome = 'idle' | 'completed' | 'failed' | 'dead-letter' | 'cancelled';

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_RETRY_BASE_MS = 30_000;
const MAX_RETRY_DELAY_MS = 10 * 60_000;

export class MtsService {
  private readonly options: MtsOptions;
  private readonly now: () => Date;
  private readonly traceHeaders: () => Record<string, string> | undefined;

  constructor(options: MtsOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.traceHeaders = options.traceHeaders ?? (() => undefined);
  }

  // --- enqueue ---------------------------------------------------------------

  /**
   * Create a queued job.
   *
   * Refused before anything is written when the request cannot be carried out: an unknown preset
   * is a command nobody can honour, and an input outside the work root is one nobody should. Both
   * are 422s rather than jobs that fail a minute later, because a queue full of work that was
   * never going to run is the thing a queue is worst at showing you.
   */
  async enqueue(caller: Caller, input: EnqueueInput): Promise<TranscodeJob> {
    this.authorize(caller, 'asset:write');
    const unknown = unknownPresets(input.presetIds);
    if (input.presetIds.length === 0) throw new ValidationError('presetIds must not be empty');
    if (unknown.length > 0) throw new ValidationError(`unknown preset(s): ${unknown.join(', ')}`);
    const inputPath = this.resolveInput(input.inputPath);
    await this.requireInput(inputPath, input.inputPath);

    const at = this.now().toISOString();
    const job: TranscodeJob = {
      id: ulid(),
      channelId: caller.channelId,
      assetId: input.assetId,
      presetIds: [...input.presetIds],
      inputPath,
      state: 'queued',
      attempts: 0,
      priority: input.priority ?? 0,
      createdBy: caller.userId,
      createdAt: at,
      updatedAt: at,
      version: 1,
    };

    await this.options.store.transaction(async (tx) => {
      await tx.putJob(job);
      await tx.enqueue(this.audit(caller, job, undefined, job, 'transcode.queued'));
    });
    return job;
  }

  /**
   * `transcode.job.create` (mts.md §5): the same enqueue, from the broker.
   *
   * The command names no channel of its own — the envelope does, as every event does — and no
   * user: the actor is the service that asked. The seen-mark commits with the job, so a
   * redelivery creates nothing and reports `duplicate`.
   */
  async consumeJobCreate(msg: Message): Promise<'applied' | 'duplicate'> {
    const envelope = this.envelopeOf<EventPayloads['transcode.job.create']>(
      msg,
      'transcode.job.create',
    );
    const { assetId, presetIds, inputPath, priority } = envelope.payload;
    if (inputPath === undefined) {
      throw new ValidationError(`message ${msg.id}: inputPath is required until HSM resolves one`);
    }
    const unknown = unknownPresets(presetIds);
    if (unknown.length > 0) throw new ValidationError(`unknown preset(s): ${unknown.join(', ')}`);
    const resolved = this.resolveInput(inputPath);

    const at = this.now().toISOString();
    const job: TranscodeJob = {
      id: ulid(),
      channelId: envelope.channelId,
      assetId,
      presetIds: [...presetIds],
      inputPath: resolved,
      state: 'queued',
      attempts: 0,
      priority: priority ?? 0,
      createdBy: envelope.actor?.id ?? 'service',
      createdAt: at,
      updatedAt: at,
      version: 1,
    };
    const caller: Caller = {
      userId: job.createdBy,
      channelId: envelope.channelId,
      actorKind: 'service',
      ...(envelope.correlationId !== undefined ? { correlationId: envelope.correlationId } : {}),
    };

    let outcome: 'applied' | 'duplicate' = 'applied';
    await this.options.store.transaction(async (tx) => {
      if (!(await tx.markSeen(msg.id))) {
        outcome = 'duplicate';
        return;
      }
      await tx.putJob(job);
      await tx.enqueue(this.audit(caller, job, undefined, job, 'transcode.queued'));
    });
    return outcome;
  }

  // --- reads -----------------------------------------------------------------

  /** One job. Another channel's is NOT FOUND — that it exists is not this caller's business. */
  async get(caller: Caller, id: string): Promise<TranscodeJob> {
    this.authorize(caller, 'asset:read');
    const job = await this.options.store.job(id);
    if (!job || job.channelId !== caller.channelId) throw new NotFound(`no job ${id}`);
    return job;
  }

  async list(
    caller: Caller,
    query: { assetId?: string; limit?: number } = {},
  ): Promise<TranscodeJob[]> {
    this.authorize(caller, 'asset:read');
    return this.options.store.jobs({
      channelId: caller.channelId,
      ...(query.assetId !== undefined ? { assetId: query.assetId } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });
  }

  // --- the worker ------------------------------------------------------------

  /**
   * Lease the next queued job and run it. `idle` when there is nothing to do.
   *
   * The lease is the compare-and-set: two workers can read the same row, and only the one whose
   * `putJob(..., 'queued')` returns true owns it. The loser takes the next one rather than
   * waiting — there is no coordination here beyond the row itself.
   */
  async runNext(signal?: AbortSignal): Promise<RunOutcome> {
    const at = this.now().toISOString();
    const candidate = await this.options.store.nextQueued(at);
    if (!candidate) return 'idle';

    // Omitted rather than `undefined`: the row is JSON, and a lease clears the backoff it waited
    // out and the reason the previous attempt gave.
    const { retryAt: _retryAt, reason: _reason, ...rest } = candidate;
    const running: TranscodeJob = {
      ...rest,
      state: 'running',
      attempts: candidate.attempts + 1,
      workerId: this.options.workerId ?? 'mts',
      startedAt: at,
      updatedAt: at,
      percent: 0,
      version: candidate.version + 1,
    };
    const leased = await this.options.store.transaction(async (tx) => {
      // Guarded by the state it was READ in — `queued`, or `failed` with its backoff passed.
      if (!(await tx.putJob(running, candidate.state))) return false;
      await tx.enqueue(
        this.record(this.callerFor(running), running.channelId, 'transcode.started', {
          jobId: running.id,
          assetId: running.assetId,
          ...(running.workerId !== undefined ? { workerId: running.workerId } : {}),
        } satisfies EventPayloads['transcode.started']),
      );
      await tx.enqueue(
        this.audit(this.callerFor(running), running, candidate, running, 'transcode.started'),
      );
      return true;
    });
    // Another worker got there first. Not an error and not a retry: the next call takes the next
    // row, and the queue drains either way.
    if (!leased) return 'idle';

    return this.execute(running, signal);
  }

  /** Run every preset of a leased job, then commit what happened. */
  private async execute(job: TranscodeJob, signal?: AbortSignal): Promise<RunOutcome> {
    const renditions: RenditionResult[] = [];
    try {
      for (const presetId of job.presetIds) {
        // Checked again here rather than trusted from the enqueue: a preset can be removed
        // between the command and the run, and a job holding an id nothing implements should say
        // so rather than throw a TypeError deep in the loop.
        const preset = presetById(presetId);
        if (!preset) throw new TranscodeRefusal(`unknown preset ${presetId}`);
        renditions.push(await this.produce(job, preset, signal));
      }
    } catch (err) {
      if (signal?.aborted) {
        // A drain, not a failure: the job goes back to the queue for whoever is still up, with
        // its attempt count intact — the work was interrupted, not attempted and found wanting.
        await this.requeue(job, 'worker shut down mid-job');
        return 'cancelled';
      }
      return this.fail(job, err);
    }

    const at = this.now().toISOString();
    const completed: TranscodeJob = {
      ...job,
      state: 'completed',
      renditions,
      percent: 100,
      finishedAt: at,
      updatedAt: at,
      version: job.version + 1,
    };
    await this.options.store.transaction(async (tx) => {
      if (!(await tx.putJob(completed, 'running'))) return;
      await tx.enqueue(
        this.record(this.callerFor(job), job.channelId, 'transcode.completed', {
          jobId: completed.id,
          assetId: completed.assetId,
          renditions: renditionsFor(completed),
        } satisfies EventPayloads['transcode.completed']),
      );
      await tx.enqueue(
        this.audit(this.callerFor(job), completed, job, completed, 'transcode.completed'),
      );
    });
    return 'completed';
  }

  /** One preset: run the encoder, then checksum what it wrote. */
  private async produce(
    job: TranscodeJob,
    preset: Preset,
    signal?: AbortSignal,
  ): Promise<RenditionResult> {
    // Named by job and preset, so a retry of the same job overwrites its own previous output
    // rather than accumulating one file per attempt. mts.md calls this idempotent output naming,
    // and it is what makes at-least-once delivery safe on a filesystem.
    const outputPath = join(
      this.options.workRoot,
      'renditions',
      job.id,
      `${preset.id}.${preset.extension}`,
    );
    await mkdir(dirname(outputPath), { recursive: true });

    const output = await this.options.transcoder.run(
      { inputPath: job.inputPath, outputPath, args: preset.args },
      {
        ...(signal ? { signal } : {}),
        onProgress: (percent) => void this.progress(job, preset, percent),
      },
    );

    return {
      presetId: preset.id,
      kind: preset.kind,
      path: outputPath,
      checksum: { algorithm: 'sha256', value: await sha256(outputPath) },
      sizeBytes: output.sizeBytes,
      // A still has no duration, and reporting 0 for one would put a zero-length clip in MAM.
      ...(!preset.still && output.durationSec !== undefined
        ? { durationSec: output.durationSec }
        : {}),
    };
  }

  /**
   * Best-effort progress: the percentage of THIS preset, scaled across the job's presets.
   *
   * Written to the row, not emitted as an event. `transcode.progress` (EP-16.4) is a per-tick
   * broadcast, and putting one through the outbox — which is a durable, ordered, audited log —
   * would make a progress bar cost what a domain event costs. The row is what `GET /jobs/{id}`
   * reads, and it is enough for a progress bar to poll.
   *
   * A write that loses its compare-and-set is dropped in silence: the job has moved on, and
   * progress about a job that already finished is noise, not news.
   */
  private async progress(job: TranscodeJob, preset: Preset, percent: number): Promise<void> {
    const index = job.presetIds.indexOf(preset.id);
    const share = 100 / Math.max(job.presetIds.length, 1);
    const overall = Math.min(100, Math.round(index * share + (percent / 100) * share));
    const current = await this.options.store.job(job.id);
    if (!current || current.state !== 'running') return;
    if ((current.percent ?? 0) >= overall) return;
    await this.options.store
      .transaction((tx) =>
        tx.putJob({ ...current, percent: overall, updatedAt: this.now().toISOString() }, 'running'),
      )
      .catch(() => undefined);
  }

  /** An attempt that did not work: retried, or dead-lettered when it never will be. */
  private async fail(job: TranscodeJob, err: unknown): Promise<RunOutcome> {
    const reason = trim(err instanceof Error ? err.message : String(err));
    const refused = err instanceof TranscodeRefusal;
    const exhausted = job.attempts >= (this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    const terminal = refused || exhausted;

    const now = this.now();
    const at = now.toISOString();
    const base = this.options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    const delay = Math.min(base * 2 ** Math.max(job.attempts - 1, 0), MAX_RETRY_DELAY_MS);
    const after: TranscodeJob = {
      ...job,
      state: terminal ? 'dead-letter' : 'failed',
      reason,
      updatedAt: at,
      version: job.version + 1,
      ...(terminal
        ? { finishedAt: at }
        : { retryAt: new Date(now.getTime() + delay).toISOString() }),
    };
    await this.options.store.transaction(async (tx) => {
      if (!(await tx.putJob(after, 'running'))) return;
      if (terminal) {
        // `transcode.failed` is emitted when the platform has given up, not on every attempt:
        // mts.md points it at Notifications and BMS, and a notification per retry is a pager that
        // gets muted.
        await tx.enqueue(
          this.record(this.callerFor(job), job.channelId, 'transcode.failed', {
            jobId: after.id,
            assetId: after.assetId,
            attempts: after.attempts,
            error: {
              code: refused ? 'TRANSCODE_REFUSED' : 'TRANSCODE_FAILED',
              message: reason,
              retryable: false,
            },
          } satisfies EventPayloads['transcode.failed']),
        );
      }
      await tx.enqueue(
        this.audit(
          this.callerFor(job),
          after,
          job,
          after,
          terminal ? 'transcode.failed' : 'transcode.attemptFailed',
        ),
      );
    });
    return terminal ? 'dead-letter' : 'failed';
  }

  /** Put a job back on the queue — a drain, or the sweep finding a worker that never returned. */
  private async requeue(job: TranscodeJob, reason: string): Promise<void> {
    const at = this.now().toISOString();
    const requeued: TranscodeJob = {
      ...job,
      state: 'queued',
      reason,
      // The attempt is given back: it was interrupted rather than tried and found wanting, and
      // charging a pod rotation against a job's retry budget is how a deploy eats a queue.
      attempts: Math.max(0, job.attempts - 1),
      updatedAt: at,
      version: job.version + 1,
    };
    await this.options.store.transaction(async (tx) => {
      if (!(await tx.putJob(requeued, 'running'))) return;
      await tx.enqueue(
        this.audit(this.callerFor(job), requeued, job, requeued, 'transcode.requeued'),
      );
    });
  }

  /**
   * Return jobs whose worker never came back (mts.md §9, "worker dies mid-job").
   *
   * `olderThanMs` is the visibility timeout: a `running` row whose `updatedAt` has not moved for
   * longer than any heartbeat or progress write would is a job nobody holds.
   */
  async sweepStale(olderThanMs: number): Promise<number> {
    const before = new Date(this.now().getTime() - olderThanMs).toISOString();
    const stale = await this.options.store.stale(before);
    for (const job of stale) await this.requeue(job, 'worker did not return');
    return stale.length;
  }

  // --- internals -------------------------------------------------------------

  /**
   * A path inside the work root, or a refusal.
   *
   * `resolve` then a prefix test on the RESOLVED path: `..` segments, a symlinked parent and an
   * absolute path that merely starts with the right characters (`/work-other`) all collapse here,
   * and none of them would be caught by testing the string that arrived.
   */
  private resolveInput(path: string): string {
    const root = resolve(this.options.workRoot);
    const full = resolve(root, normalize(path));
    if (full !== root && !full.startsWith(root.endsWith(sep) ? root : root + sep)) {
      throw new ValidationError(`inputPath must be inside the work root: ${path}`);
    }
    if (!isAbsolute(full)) throw new ValidationError(`inputPath is not resolvable: ${path}`);
    return full;
  }

  /**
   * The input exists and is a file — at ENQUEUE, over HTTP.
   *
   * A job for a file that is not there can only fail, three times, over several minutes of
   * backoff, and then dead-letter. Saying so in the 422 costs one `stat`. Not applied to the
   * broker command: that one may name a file HSM is still placing, and waiting for it is what the
   * retry is for.
   */
  private async requireInput(full: string, asGiven: string): Promise<void> {
    const info = await stat(full).catch(() => undefined);
    if (!info?.isFile()) throw new ValidationError(`inputPath does not exist: ${asGiven}`);
  }

  /**
   * `canEnforce`, never `can` (AGENTS.md): strict, with the context MTS actually has — the
   * channel and the `files` group. What it does NOT have is the asset's category or owner; those
   * are MAM's. So a writer whose grant is narrowed to a category subtree is REFUSED here rather
   * than let through: strict evaluation of a predicate with no supplied value denies, and that is
   * the safe direction. Such a writer's transcodes arrive as broker commands from the service
   * that does know the asset (BMS/RIM), which is the normal path anyway.
   */
  private authorize(caller: Caller, permission: 'asset:read' | 'asset:write'): void {
    if (!caller.policy) throw new Forbidden('no policy for the caller');
    const decision = canEnforce(caller.policy, permission, {
      type: 'asset',
      channelId: caller.channelId,
      fieldGroup: FILES_GROUP,
    });
    if (!decision.allowed) throw new Forbidden(decision.reason ?? `missing ${permission}`);
  }

  private callerFor(job: TranscodeJob): Caller {
    return { userId: 'mts', channelId: job.channelId, actorKind: 'service' };
  }

  private audit(
    caller: Caller,
    at: TranscodeJob,
    before: TranscodeJob | undefined,
    after: TranscodeJob,
    action: string,
  ): OutboxRecord {
    return this.record(caller, at.channelId, 'audit.recorded', {
      entityType: 'transcode-job',
      entityId: at.id,
      revision: at.version,
      action,
      origin: { service: 'mts' },
      delta: delta(
        before as unknown as Record<string, unknown> | undefined,
        after as unknown as Record<string, unknown>,
      ),
    } satisfies EventPayloads['audit.recorded']);
  }

  private record(caller: Caller, channelId: string, type: string, payload: object): OutboxRecord {
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
      actor: { kind: caller.actorKind ?? 'user', id: caller.userId },
      ...(caller.correlationId !== undefined ? { correlationId: caller.correlationId } : {}),
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

  /** The envelope, checked for shape and type — a message that is not one is refused for good. */
  private envelopeOf<P extends object>(msg: Message, type: string): Envelope<P> {
    const shape = envelopeShapeErrors(msg.body);
    if (!shape.valid) {
      throw new ValidationError(
        `message ${msg.id} on ${msg.subject} is not an envelope: ${shape.errors
          .map((e) => `${e.path} ${e.message}`)
          .join('; ')}`,
      );
    }
    const envelope = msg.body as Envelope;
    if (envelope.type !== type) {
      throw new ValidationError(`message ${msg.id} is a ${envelope.type}, not a ${type}`);
    }
    const payload = validatePayload(type, envelope.payload);
    if (!payload.valid) {
      throw new ValidationError(
        `message ${msg.id} payload does not match ${type}: ${payload.errors
          .map((e) => `${e.path} ${e.message}`)
          .join('; ')}`,
      );
    }
    return envelope as Envelope<P>;
  }
}

/** Streamed, not read into memory: a broadcast master is measured in gigabytes. */
async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** FFmpeg's last words, as a sentence a person reads in a job row. */
function trim(message: string): string {
  const oneLine = message.replace(/\s+/g, ' ').trim();
  return oneLine.length > 400 ? `${oneLine.slice(0, 399)}…` : oneLine;
}

export { canTransition };
