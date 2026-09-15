// The upload path (EP-15.1): start, parts, resume, complete — and the job the bytes become.
//
// AUTHORIZATION. `ingest:write` in the caller's channel, enforced with `canEnforce` and the
// resource context. An upload is channel-scoped like every row here; another channel's upload is
// "not found", not "forbidden" — a 403 would confirm it exists.
//
// WHAT IS ATOMIC, AND WHAT IS NOT. Bytes go to the staging area, rows go to the store, and a
// part is two writes that cannot share a transaction. The order makes that safe: the file first,
// the row second. A crash between the two leaves a part on disk that no row records — a resume
// sends it again and overwrites it, which costs one part. The other order would leave a row that
// promises bytes that are not there, and completion would assemble a hole. Completion is one
// store transaction: the job, `ingest.detected`, and the audit delta commit together, after the
// bytes are assembled and hashed — the checksum in the job is of what is on disk.

import {
  buildEnvelope,
  delta,
  subjectFor,
  ulid,
  validatePayload,
  type Envelope,
  type EventPayloads,
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
import type { Staging } from './staging.ts';
import type { RimStore } from './store.ts';
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
  /** Every part but the last is exactly this long. Bounded by what the gateway will carry. */
  partSizeBytes?: number;
  /** An open upload not completed within this is swept. */
  uploadTtlMs?: number;
  now?: () => Date;
  /** Trace context captured into the event where it is created (EP-13.3). */
  traceHeaders?: () => Record<string, string> | undefined;
}

export const DEFAULT_PART_BYTES = 8 * 1024 * 1024;
export const DEFAULT_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

export class RimService {
  private readonly store: RimStore;
  private readonly staging: Staging;
  private readonly partSizeBytes: number;
  private readonly uploadTtlMs: number;
  private readonly now: () => Date;
  private readonly traceHeaders: () => Record<string, string> | undefined;

  constructor(options: RimServiceOptions) {
    this.store = options.store;
    this.staging = options.staging;
    this.partSizeBytes = options.partSizeBytes ?? DEFAULT_PART_BYTES;
    this.uploadTtlMs = options.uploadTtlMs ?? DEFAULT_UPLOAD_TTL_MS;
    this.now = options.now ?? (() => new Date());
    this.traceHeaders = options.traceHeaders ?? (() => undefined);
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
   * events. Idempotent: an upload already completed returns its job again, because the client
   * that asks twice is the one whose first answer was lost.
   */
  async complete(caller: Caller, id: string): Promise<IngestJob> {
    this.authorize(caller, 'ingest:write');
    const upload = await this.uploadFor(caller, id);
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

    const at = this.now().toISOString();
    const job: IngestJob = {
      id: ulid(),
      channelId: upload.channelId,
      source: UPLOAD_SOURCE,
      sourceKind: 'upload',
      state: 'detected',
      filename: upload.filename,
      sizeBytes: assembled.sizeBytes,
      checksum: assembled.sha256,
      ...(upload.contentType !== undefined ? { contentType: upload.contentType } : {}),
      receivedPath: assembled.path,
      createdBy: caller.userId,
      createdAt: at,
      updatedAt: at,
      version: 1,
    };
    const done: Upload = { ...upload, state: 'completed', jobId: job.id };
    await this.store.transaction(async (tx) => {
      await tx.putJob(job);
      await tx.putUpload(done);
      await tx.enqueue(
        this.record(caller, job.channelId, 'ingest.detected', {
          source: job.source,
          sourceKind: job.sourceKind,
          path: job.receivedPath,
          sizeBytes: job.sizeBytes,
        } satisfies EventPayloads['ingest.detected']),
      );
      // The path is where the bytes sit on this node's disk — an operator's detail, not the
      // trail's. Everything else about the job is.
      const { receivedPath: _path, ...audited } = job;
      void _path;
      await tx.enqueue(
        this.record(caller, job.channelId, 'audit.recorded', {
          entityType: 'ingest',
          entityId: job.id,
          revision: job.version,
          action: 'ingest.detected',
          origin: { service: 'rim' },
          delta: delta(undefined, audited as unknown as Record<string, unknown>),
        } satisfies EventPayloads['audit.recorded']),
      );
    });
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

  async job(caller: Caller, id: string): Promise<IngestJob> {
    this.authorize(caller, 'ingest:read');
    const job = await this.store.job(id);
    if (!job || job.channelId !== caller.channelId) throw new NotFound(`ingest job ${id}`);
    return job;
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
    if (!upload || upload.channelId !== caller.channelId) throw new NotFound(`upload ${id}`);
    return upload;
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
      actor: { kind: 'user', id: caller.userId },
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
}
