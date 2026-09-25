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
  liveSubjectFor,
  subjectFor,
  ulid,
  validatePayload,
  type Envelope,
  type EventPayloads,
} from '@atlas/contracts';
import type { Message, OutboxRecord } from '@atlas/messaging';
import { canEnforce, type EffectivePolicy } from '@atlas/policy';
import { Conflict, Forbidden, NotFound, ValidationError } from '@atlas/service-kit';
import { canTransition, renditionsFor, type RenditionResult, type TranscodeJob } from './job.ts';
import { presetById, type Preset } from './preset.ts';
import {
  compileProfile,
  gpuEncoderFor,
  profileErrors,
  type CompiledProfile,
  type ProfileInput,
  type TranscodeProfile,
} from './profile.ts';
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
  /**
   * Where `transcode.progress` goes (EP-16.4): the broker's `publishLive`, on
   * `live.<channel>.transcode.progress` — never the outbox, never the durable stream, never the
   * audit log (messaging §1.1). Absent, or the broker away, and progress is simply not announced;
   * the job row still carries `percent` for anyone who polls.
   */
  publishLive?: (msg: Message) => Promise<void>;
  /** At most one progress message per job per this interval. Default 1 s. */
  progressIntervalMs?: number;
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
  /** The message this write answers (EP-03.5) — set on the platform's own writes, never a request's. */
  causationId?: string;
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
    if (input.presetIds.length === 0) throw new ValidationError('presetIds must not be empty');
    const unknown = await this.unresolvable(caller.channelId, input.presetIds);
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
      ...(caller.correlationId !== undefined ? { correlationId: caller.correlationId } : {}),
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
    const unknown = await this.unresolvable(envelope.channelId, presetIds);
    if (unknown.length > 0) throw new ValidationError(`unknown preset(s): ${unknown.join(', ')}`);
    const resolved = this.resolveInput(inputPath);

    const at = this.now().toISOString();
    // follow()'s rule (@atlas/contracts): the chain continues, or starts at the command.
    const correlationId = envelope.correlationId ?? envelope.messageId;
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
      correlationId,
      causationId: envelope.messageId,
    };
    const caller: Caller = {
      userId: job.createdBy,
      channelId: envelope.channelId,
      actorKind: 'service',
      correlationId,
      causationId: envelope.messageId,
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
    try {
      return await this.executePresets(job, signal);
    } finally {
      // However it ended, the throttle has nothing more to remember about this job.
      this.announced.delete(job.id);
    }
  }

  private async executePresets(job: TranscodeJob, signal?: AbortSignal): Promise<RunOutcome> {
    const renditions: RenditionResult[] = [];
    // Once per job, before the first preset: what turns FFmpeg's `out_time` into a percentage.
    // Unreadable is not a failure — the job runs without a progress bar.
    const durationSec = await this.options.transcoder
      .probeDuration(job.inputPath)
      .catch(() => undefined);
    try {
      for (const presetId of job.presetIds) {
        // Resolved again at RUN time, not trusted from the enqueue: a profile can be edited or
        // disabled between the two, and the job uses the channel's CURRENT definition — as a
        // re-run would. One that no longer resolves is a refusal, not a TypeError in the loop.
        const preset = await this.resolvePreset(job.channelId, presetId);
        if (!preset) throw new TranscodeRefusal(`unknown preset ${presetId}`);
        renditions.push(await this.produce(job, preset, durationSec, signal));
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
    preset: Preset | CompiledProfile,
    durationSec: number | undefined,
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
      {
        inputPath: job.inputPath,
        outputPath,
        args: preset.args,
        ...(durationSec !== undefined ? { durationSec } : {}),
      },
      {
        ...(signal ? { signal } : {}),
        onProgress: (percent, speed) => void this.progress(job, preset, percent, speed),
      },
    );

    return {
      presetId: preset.id,
      kind: preset.kind,
      path: outputPath,
      checksum: { algorithm: 'sha256', value: await sha256(outputPath) },
      sizeBytes: output.sizeBytes,
      // Which encoder made it, and whether a GPU the profile asked for was unusable here.
      ...('encoder' in preset && preset.encoder !== undefined ? { encoder: preset.encoder } : {}),
      ...('fallback' in preset && preset.fallback ? { fallback: true } : {}),
      // A still has no duration, and reporting 0 for one would put a zero-length clip in MAM.
      ...(!preset.still && output.durationSec !== undefined
        ? { durationSec: output.durationSec }
        : {}),
    };
  }

  /**
   * Best-effort progress: the percentage of THIS preset, scaled across the job's presets.
   *
   * Announced live (`announce`, EP-16.4) and written to the row for whoever polls. Never through
   * the outbox — a durable, ordered, audited log —
   * would make a progress bar cost what a domain event costs. The row is what `GET /jobs/{id}`
   * reads, and it is enough for a progress bar to poll.
   *
   * A write that loses its compare-and-set is dropped in silence: the job has moved on, and
   * progress about a job that already finished is noise, not news.
   */
  private async progress(
    job: TranscodeJob,
    preset: Preset,
    percent: number,
    speed?: number,
  ): Promise<void> {
    const index = job.presetIds.indexOf(preset.id);
    const share = 100 / Math.max(job.presetIds.length, 1);
    const overall = Math.min(100, Math.round(index * share + (percent / 100) * share));
    this.announce(job, overall, speed);
    const current = await this.options.store.job(job.id);
    if (!current || current.state !== 'running') return;
    if ((current.percent ?? 0) >= overall) return;
    await this.options.store
      .transaction((tx) =>
        tx.putJob({ ...current, percent: overall, updatedAt: this.now().toISOString() }, 'running'),
      )
      .catch(() => undefined);
  }

  /** When each job last announced progress, and at what percentage — the throttle's memory. */
  private readonly announced = new Map<string, { at: number; percent: number }>();

  /**
   * `transcode.progress` on `live.<channel>.transcode.progress` (EP-16.4), throttled.
   *
   * The first report of a job always goes — a short job may have no second — and after that at
   * most one per `progressIntervalMs`, and only when the whole-number percentage moved: FFmpeg
   * reports twice a second, and a progress bar needs neither. Fire-and-forget by contract: a
   * failed publish is dropped, never retried, never an error for the job.
   */
  private announce(job: TranscodeJob, percent: number, speed?: number): void {
    const publish = this.options.publishLive;
    if (!publish) return;
    const now = this.now().getTime();
    const last = this.announced.get(job.id);
    const interval = this.options.progressIntervalMs ?? 1_000;
    if (last && (now - last.at < interval || percent <= last.percent)) return;
    this.announced.set(job.id, { at: now, percent });
    // A long-lived worker must not grow a map entry per job it ever ran; the entry is only
    // needed while the job runs, and 100 is its last word.
    if (percent >= 100) this.announced.delete(job.id);

    const payload = {
      jobId: job.id,
      assetId: job.assetId,
      percent,
      ...(speed !== undefined ? { speed } : {}),
    } satisfies EventPayloads['transcode.progress'];
    const check = validatePayload('transcode.progress', payload);
    if (!check.valid) return;
    const envelope = buildEnvelope({
      type: 'transcode.progress',
      channelId: job.channelId,
      payload,
      actor: { kind: 'service', id: 'mts' },
      ...(job.correlationId !== undefined ? { correlationId: job.correlationId } : {}),
      ...(job.causationId !== undefined ? { causationId: job.causationId } : {}),
    });
    void publish({
      id: envelope.messageId,
      subject: liveSubjectFor(job.channelId, 'transcode.progress'),
      body: envelope,
    }).catch(() => undefined);
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
  // --- the profile registry (EP-16.6; mts.md §11.1) -------------------------------------------------

  /**
   * What a preset id means for a channel: its own enabled profile of that id, else the
   * platform-wide one, else the built-in. A DISABLED profile is skipped, not refused — disabling a
   * channel's override of `broadcast` puts the channel back on the default, which is what
   * "retire my override" means; a disabled custom id with nothing beneath it is unknown.
   *
   * A GPU the profile asks for is tested on this node (a one-frame encode, cached) before the
   * profile is compiled; an unusable one compiles to the CPU encoder and the rendition says so.
   */
  async resolvePreset(
    channelId: string,
    id: string,
  ): Promise<Preset | CompiledProfile | undefined> {
    for (const scope of [channelId, null]) {
      const profile = await this.options.store.profile(id, scope);
      if (!profile?.enabled) continue;
      const encoder = gpuEncoderFor(profile);
      const usable = encoder ? await this.options.transcoder.encoderUsable(encoder) : false;
      return compileProfile(profile, usable);
    }
    return presetById(id);
  }

  private async unresolvable(channelId: string, ids: readonly string[]): Promise<string[]> {
    const missing: string[] = [];
    for (const id of ids) if (!(await this.resolvePreset(channelId, id))) missing.push(id);
    return missing;
  }

  /** The channel's profiles and the platform-wide ones — what the channel resolves against. */
  async listProfiles(caller: Caller): Promise<TranscodeProfile[]> {
    this.authorizeConfig(caller, 'read', caller.channelId);
    return this.options.store.profiles(caller.channelId);
  }

  async getProfile(
    caller: Caller,
    id: string,
    scope: 'channel' | 'platform' = 'channel',
  ): Promise<TranscodeProfile> {
    const channelId = scope === 'platform' ? null : caller.channelId;
    // Read with the CALLER's channel as the context even for a platform-wide one: every channel
    // resolves against it, so a channel's reader may see it — writing it is what needs more.
    this.authorizeConfig(caller, 'read', caller.channelId);
    const profile = await this.options.store.profile(id, channelId);
    if (!profile) throw new NotFound(`no ${scope} profile ${id}`);
    return profile;
  }

  /**
   * Create a profile. `channelId: null` is platform-wide, and needs an UNSCOPED `config:admin`
   * (a strict check with no channel cannot be met by a channel-scoped rule); anything else is the
   * caller's channel — a channel administrator cannot write another channel's registry.
   */
  async createProfile(caller: Caller, input: ProfileInput): Promise<TranscodeProfile> {
    const channelId = this.profileScope(caller, input.channelId);
    this.authorizeConfig(caller, 'admin', channelId);
    const errors = profileErrors(input);
    if (errors.length > 0) throw new ValidationError(errors.join('; '));

    const at = this.now().toISOString();
    const profile = this.profileRecord(input, channelId, {
      version: 1,
      createdBy: caller.userId,
      createdAt: at,
      updatedAt: at,
    });
    const created = await this.options.store.transaction(async (tx) => {
      if (!(await tx.putProfile(profile))) return false;
      await tx.enqueue(this.profileAudit(caller, undefined, profile, 'transcode-profile.created'));
      return true;
    });
    if (!created) {
      throw new Conflict(
        `profile ${input.id} already exists ${channelId ? 'in this channel' : 'platform-wide'} — replace it instead`,
      );
    }
    return profile;
  }

  /**
   * Replace a profile, compare-and-set on `version`: a stale write is 409, never a silent
   * overwrite of another administrator's change. There is no delete — `enabled: false`.
   */
  async replaceProfile(
    caller: Caller,
    id: string,
    input: ProfileInput & { version: number },
    scope: 'channel' | 'platform' = 'channel',
  ): Promise<TranscodeProfile> {
    const channelId = scope === 'platform' ? undefined : caller.channelId;
    this.authorizeConfig(caller, 'admin', channelId);
    const before = await this.options.store.profile(id, channelId ?? null);
    if (!before) throw new NotFound(`no ${scope} profile ${id}`);
    if (input.id !== id) throw new ValidationError('the id in the body must match the path');
    const errors = profileErrors(input);
    if (errors.length > 0) throw new ValidationError(errors.join('; '));

    const after = this.profileRecord(input, channelId, {
      version: before.version + 1,
      createdBy: before.createdBy,
      createdAt: before.createdAt,
      updatedAt: this.now().toISOString(),
    });
    const replaced = await this.options.store.transaction(async (tx) => {
      if (!(await tx.putProfile(after, input.version))) return false;
      await tx.enqueue(this.profileAudit(caller, before, after, 'transcode-profile.replaced'));
      return true;
    });
    if (!replaced) {
      throw new Conflict(
        `profile ${id} is at version ${before.version}, not ${input.version} — re-read it and apply the change again`,
      );
    }
    return after;
  }

  /** `null` is platform-wide; absent is the caller's channel; another channel is refused. */
  private profileScope(caller: Caller, requested: string | null | undefined): string | undefined {
    if (requested === null) return undefined;
    if (requested === undefined || requested === caller.channelId) return caller.channelId;
    throw new Forbidden('a profile belongs to your channel, or (unscoped) to the platform');
  }

  private profileRecord(
    input: ProfileInput,
    channelId: string | undefined,
    meta: Pick<TranscodeProfile, 'version' | 'createdBy' | 'createdAt' | 'updatedAt'>,
  ): TranscodeProfile {
    // Field by field from the grammar, not a spread of the body: a key the grammar does not know
    // is not stored, so nothing an admin page sends can ride into the registry unvalidated.
    return {
      id: input.id,
      ...(channelId !== undefined ? { channelId } : {}),
      name: input.name.trim(),
      ...(input.description !== undefined ? { description: input.description } : {}),
      kind: input.kind,
      container: input.container,
      ...(input.video !== undefined ? { video: { ...input.video } } : {}),
      ...(input.audio !== undefined ? { audio: { ...input.audio } } : {}),
      enabled: input.enabled,
      ...meta,
    };
  }

  /**
   * `config:read` or `config:admin` to read (configuration §8: read is implied by the admin
   * grant); `config:admin` to write — in `channelId`, or with none for a platform-wide profile,
   * which only an unscoped grant satisfies (strict).
   */
  private authorizeConfig(
    caller: Caller,
    need: 'read' | 'admin',
    channelId: string | undefined,
  ): void {
    if (!caller.policy) throw new Forbidden('no policy for the caller');
    const context =
      channelId !== undefined
        ? { type: 'transcode-profile', channelId }
        : { type: 'transcode-profile' };
    const permissions = need === 'read' ? ['config:read', 'config:admin'] : ['config:admin'];
    const allowed = permissions.some((perm) => canEnforce(caller.policy!, perm, context).allowed);
    if (!allowed) {
      throw new Forbidden(
        need === 'admin' && channelId === undefined
          ? 'an unscoped config:admin is required for a platform-wide profile'
          : `config:${need} required`,
      );
    }
  }

  private profileAudit(
    caller: Caller,
    before: TranscodeProfile | undefined,
    after: TranscodeProfile,
    action: string,
  ): OutboxRecord {
    return this.record(caller, caller.channelId, 'audit.recorded', {
      entityType: 'transcode-profile',
      // The scope is part of the identity: a channel's `broadcast` and the platform's are two
      // profiles with two histories.
      entityId: after.channelId ? after.id : `platform:${after.id}`,
      revision: after.version,
      action,
      origin: { service: 'mts' },
      delta: delta(
        before as unknown as Record<string, unknown> | undefined,
        after as unknown as Record<string, unknown>,
      ),
    } satisfies EventPayloads['audit.recorded']);
  }

  private authorize(caller: Caller, permission: 'asset:read' | 'asset:write'): void {
    if (!caller.policy) throw new Forbidden('no policy for the caller');
    const decision = canEnforce(caller.policy, permission, {
      type: 'asset',
      channelId: caller.channelId,
      fieldGroup: FILES_GROUP,
    });
    if (!decision.allowed) throw new Forbidden(decision.reason ?? `missing ${permission}`);
  }

  /**
   * The worker's hands on a job. It carries the job's chain: without it, everything the worker
   * announces — started, completed, failed, and their audit — would start a new trace exactly
   * where the minutes of work happen, and "what did this request cause" would stop at `queued`.
   */
  private callerFor(job: TranscodeJob): Caller {
    return {
      userId: 'mts',
      channelId: job.channelId,
      actorKind: 'service',
      ...(job.correlationId !== undefined ? { correlationId: job.correlationId } : {}),
      ...(job.causationId !== undefined ? { causationId: job.causationId } : {}),
    };
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
      ...(caller.causationId !== undefined ? { causationId: caller.causationId } : {}),
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
