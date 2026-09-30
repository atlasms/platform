// HSM (EP-14; ADR-0009) — the file ledger and every operation on stored bytes.
//
// The invariants this file keeps, in the order they matter:
//   1. The ledger never points at bytes that are not there. Bytes are written, verified, and only
//      then referenced, in one transaction with the event and the audit record.
//   2. Referenced bytes are never removed. Bytes are removed only by a `release` operation, queued
//      in the transaction that made them unreferenced — a replacement, a move, a delete. A crash can
//      leak bytes (an orphan a sweep collects); it cannot lose a file.
//   3. The checksum is HSM's own, of the bytes it wrote; a producer's claim is only compared to it.
//   4. Every write the ledger sees is a compare-and-set: two replicas cannot both win.
// Streams never sit inside a transaction: bytes move first, the ledger commits after.

import { pipeline, Transform, type Readable } from 'node:stream';
import {
  buildEnvelope,
  delta,
  subjectFor,
  ulid,
  validatePayload,
  type EventPayloads,
} from '@atlas/contracts';
import type { OutboxRecord } from '@atlas/messaging';
import { canEnforce, type EffectivePolicy } from '@atlas/policy';
import { Conflict, Forbidden, NotFound, Unauthorized, ValidationError } from '@atlas/service-kit';
import { StorageMissing } from './driver.ts';
import {
  keyFor,
  type FileEntry,
  type FileKind,
  type PlacementInput,
  type Replica,
  type Tier,
} from './file.ts';
import {
  backoffMs,
  MAX_ATTEMPTS,
  OperationRefusal,
  REQUESTABLE_KINDS,
  type Operation,
  type OperationKind,
} from './operation.ts';
import type { HsmStore, HsmTx } from './store.ts';
import type { DriverFactory, StorageTarget, StorageTargetInput } from './targets.ts';

export interface Caller {
  userId: string;
  channelId: string;
  policy: EffectivePolicy;
  correlationId?: string;
}

/** Who is acting when no person is: a producer's placement, the worker, the bootstrap. */
const SYSTEM = { kind: 'service' as const, id: 'hsm' };

export interface HsmServiceOptions {
  store: HsmStore;
  drivers: DriverFactory;
  now?: () => Date;
  /** How long a worker's lease lasts without progress; renewed as bytes move. */
  leaseMs?: number;
  traceHeaders?: () => Record<string, string> | undefined;
}

export interface OperationRequest {
  /** The caller's id for the request: a retry with the same id is the same operation. */
  id?: string;
  kind: OperationKind;
  fileId: string;
  toTargetId?: string;
}

export class HsmService {
  private readonly store: HsmStore;
  private readonly drivers: DriverFactory;
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly traceHeaders: () => Record<string, string> | undefined;

  constructor(options: HsmServiceOptions) {
    this.store = options.store;
    this.drivers = options.drivers;
    this.now = options.now ?? (() => new Date());
    this.leaseMs = options.leaseMs ?? 60_000;
    this.traceHeaders = options.traceHeaders ?? (() => undefined);
  }

  // --- placement (EP-14.3, EP-14.4) ---------------------------------------------------------------

  /**
   * Place a producer's bytes: stream them to the channel's default online target under a key no
   * placement has used, hashing as they are written; `verify(sha256)` then checks the request's
   * signature against the digest of what arrived (ADR-0009 §3) — on refusal the bytes are removed.
   * Only then does the ledger reference them, with `file.placed` and the audit, in one transaction.
   *
   * Placing the bytes a live file already has is a no-op that returns it (`created: false`); other
   * bytes replace it at the version read, and the old bytes are released.
   */
  async place(
    input: PlacementInput,
    body: Readable,
    verify: (sha256: string) => boolean,
    correlationId?: string,
  ): Promise<{ file: FileEntry; outcome: 'created' | 'replaced' | 'unchanged' }> {
    const target = await this.store.defaultTarget(input.channelId, 'online');
    if (!target) {
      body.resume(); // drain, so the connection is not left hanging
      throw new Conflict(`no online storage target for channel ${input.channelId}`);
    }
    const driver = await this.drivers(target);
    const blobId = ulid();
    const path = keyFor(input, blobId);
    const written = await driver.write(path, body);
    if (!verify(written.sha256)) {
      await driver.remove(path);
      throw new Unauthorized('signature does not match the bytes received');
    }

    const current = await this.store.liveFile(input.assetId, input.kind, input.variant);
    if (current && current.channelId !== input.channelId) {
      await driver.remove(path);
      throw new Conflict(`asset ${input.assetId} has files in another channel`);
    }
    if (
      current &&
      current.checksum.value === written.sha256 &&
      current.sizeBytes === written.sizeBytes
    ) {
      // The same bytes again — a producer's retry. Nothing changes; what was just written goes.
      await driver.remove(path);
      return { file: current, outcome: 'unchanged' };
    }

    const at = this.now().toISOString();
    const file: FileEntry = {
      id: current?.id ?? ulid(),
      channelId: input.channelId,
      assetId: input.assetId,
      kind: input.kind,
      ...(input.variant !== undefined ? { variant: input.variant } : {}),
      storage: { targetId: target.id, path, tier: target.tier, status: 'available' },
      checksum: { algorithm: 'sha256', value: written.sha256 },
      sizeBytes: written.sizeBytes,
      ...(input.technical !== undefined ? { technical: input.technical } : {}),
      provenance: {
        producedBy: input.producedBy,
        ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
        ...(input.profile !== undefined ? { profile: input.profile } : {}),
      },
      version: (current?.version ?? 0) + 1,
      createdAt: current?.createdAt ?? at,
      updatedAt: at,
    };
    // Read before the transaction (AGENTS.md §6): the replicas the replaced bytes had go with them.
    const oldReplicas = current ? await this.store.replicasOf(current.id) : [];
    const committed = await this.store.transaction(async (tx) => {
      if (!(await tx.putFile(file, current?.version))) return false;
      if (current) {
        await this.queueRelease(
          tx,
          current.channelId,
          current.storage.targetId,
          current.storage.path,
          at,
        );
        for (const r of oldReplicas)
          await this.queueRelease(tx, r.channelId, r.targetId, r.path, at);
        await tx.deleteReplicas(current.id);
      }
      await tx.enqueue(this.placedEvent(file, correlationId));
      await tx.enqueue(
        this.fileAudit(file, current, current ? 'file.replaced' : 'file.placed', correlationId),
      );
      return true;
    });
    if (!committed) {
      // Another placement of the same file won the race; ours is unreferenced — remove it.
      await driver.remove(path);
      throw new Conflict(
        `${input.kind} of asset ${input.assetId} was placed concurrently; the other placement stands`,
      );
    }
    return { file, outcome: current ? 'replaced' : 'created' };
  }

  /** A live file's bytes, from its primary copy — for a producer reading an input (internal). */
  async content(
    assetId: string,
    kind: FileKind,
    variant?: string,
  ): Promise<{ file: FileEntry; stream: Readable }> {
    const file = await this.store.liveFile(assetId, kind, variant);
    if (!file) throw new NotFound(`no ${kind} file for asset ${assetId}`);
    const target = await this.requireTarget(file.storage.targetId);
    try {
      const stream = await (await this.drivers(target)).read(file.storage.path);
      return { file, stream };
    } catch (err) {
      if (err instanceof StorageMissing) {
        throw new Conflict(`the ledger's bytes for ${kind} of asset ${assetId} are missing`);
      }
      throw err;
    }
  }

  // --- reads (EP-14.6) ------------------------------------------------------------------------------

  /** Where an asset's files are, with their replicas — `asset:read` on the files group. */
  async location(
    caller: Caller,
    assetId: string,
  ): Promise<{ file: FileEntry; replicas: Replica[] }[]> {
    this.authorizeFiles(caller, 'asset:read');
    const files = await this.store.filesOf(caller.channelId, assetId);
    return Promise.all(
      files.map(async (file) => ({ file, replicas: await this.store.replicasOf(file.id) })),
    );
  }

  async operationFor(caller: Caller, id: string): Promise<Operation> {
    this.authorizeFiles(caller, 'asset:read');
    const op = await this.store.operation(id);
    if (!op || op.channelId !== caller.channelId) throw new NotFound(`operation ${id}`);
    return op;
  }

  async operation(id: string): Promise<Operation> {
    const op = await this.store.operation(id);
    if (!op) throw new NotFound(`operation ${id}`);
    return op;
  }

  // --- operations (EP-14.3, EP-14.5) ----------------------------------------------------------------

  /**
   * Queue a copy, move or delete (a service's request, signed). Idempotent by the caller's id: the
   * same id again returns the operation it made. Refused at once what could never run.
   */
  async requestOperation(
    request: OperationRequest,
    requestedBy: string,
    correlationId?: string,
  ): Promise<Operation> {
    if (!(REQUESTABLE_KINDS as readonly string[]).includes(request.kind)) {
      throw new ValidationError(`kind must be one of ${REQUESTABLE_KINDS.join(', ')}`);
    }
    const id = request.id ?? ulid();
    const existing = await this.store.operation(id);
    if (existing) return existing;
    const file = await this.store.file(request.fileId);
    if (!file || file.deletedAt !== undefined) throw new NotFound(`file ${request.fileId}`);
    if (request.kind !== 'delete') {
      if (request.toTargetId === undefined)
        throw new ValidationError(`toTargetId is required for a ${request.kind}`);
      const to = await this.requireTarget(request.toTargetId);
      if (!to.enabled) throw new ValidationError(`target ${to.id} is disabled`);
      if (to.channelId !== undefined && to.channelId !== file.channelId) {
        throw new ValidationError(`target ${to.id} belongs to another channel`);
      }
      if (to.id === file.storage.targetId) {
        throw new ValidationError(`the file is already on target ${to.id}`);
      }
    }
    const at = this.now().toISOString();
    const op: Operation = {
      id,
      channelId: file.channelId,
      kind: request.kind,
      fileId: file.id,
      assetId: file.assetId,
      ...(request.toTargetId !== undefined ? { toTargetId: request.toTargetId } : {}),
      state: 'queued',
      attempts: 0,
      bytesDone: 0,
      bytesTotal: request.kind === 'delete' ? 0 : file.sizeBytes,
      requestedBy,
      ...(correlationId !== undefined ? { correlationId } : {}),
      createdAt: at,
      updatedAt: at,
    };
    const inserted = await this.store.transaction(async (tx) => {
      if (!(await tx.insertOperation(op))) return false;
      await tx.enqueue(this.operationAudit(op, undefined, 'file-operation.queued'));
      return true;
    });
    return inserted ? op : ((await this.store.operation(id)) ?? op);
  }

  /**
   * One worker tick: take back lapsed leases, then lease and run up to `limit` due operations, one
   * after another. Returns how many ran.
   */
  async work(holder: string, limit = 1): Promise<number> {
    const now = this.now();
    for (const lapsed of await this.store.operationsLapsed(now.toISOString())) {
      // A dead worker's lease: the attempt counts, and it goes back to be retried — idempotent.
      await this.finish(lapsed, lapsed.holder, new Error('the worker holding it stopped'));
    }
    let ran = 0;
    for (const due of await this.store.operationsDue(now.toISOString(), limit)) {
      const leased: Operation = {
        ...due,
        state: 'running',
        attempts: due.attempts + 1,
        holder,
        leaseUntil: new Date(now.getTime() + this.leaseMs).toISOString(),
        bytesDone: 0,
        updatedAt: now.toISOString(),
      };
      const { retryAt: _r, error: _e, ...clean } = leased;
      void _r;
      void _e;
      const won = await this.store.transaction((tx) => tx.putOperation(clean, due.state));
      if (!won) continue; // another worker took it
      ran++;
      try {
        await this.execute(clean);
      } catch (err) {
        await this.finish(clean, holder, err);
      }
    }
    return ran;
  }

  private async execute(op: Operation): Promise<void> {
    switch (op.kind) {
      case 'release':
        return this.executeRelease(op);
      case 'delete':
        return this.executeDelete(op);
      case 'copy':
      case 'move':
        return this.executeTransfer(op);
    }
  }

  /** Remove bytes nothing references. Idempotent: gone already is done. */
  private async executeRelease(op: Operation): Promise<void> {
    const { targetId, path } = op.release!;
    const target = await this.store.target(targetId);
    if (target) await (await this.drivers(target)).remove(path);
    await this.complete(op, async () => undefined);
  }

  /** The row leaves the live set; its bytes and replicas are released by the operations it queues. */
  private async executeDelete(op: Operation): Promise<void> {
    const file = await this.store.file(op.fileId!);
    if (!file || file.deletedAt !== undefined) {
      await this.complete(op, async () => undefined); // deleted already: done
      return;
    }
    const replicas = await this.store.replicasOf(file.id);
    const at = this.now().toISOString();
    const deleted: FileEntry = {
      ...file,
      storage: { ...file.storage, status: 'missing' },
      version: file.version + 1,
      updatedAt: at,
      deletedAt: at,
    };
    await this.complete(op, async (tx) => {
      if (!(await tx.putFile(deleted, file.version)))
        throw new Error('the file changed under the delete; retrying');
      await this.queueRelease(tx, file.channelId, file.storage.targetId, file.storage.path, at);
      for (const r of replicas) await this.queueRelease(tx, r.channelId, r.targetId, r.path, at);
      await tx.deleteReplicas(file.id);
      await tx.enqueue(this.fileAudit(deleted, file, 'file.deleted', op.correlationId));
    });
  }

  /**
   * Copy or move: stream the primary to the destination under a key derived from the operation id
   * (a retry overwrites its own partial work), hashing as it writes; the digest must be the
   * ledger's, or the SOURCE is corrupt — quarantined, alerted, dead-lettered. Then the ledger:
   * a copy records a replica; a move points the file at the new place (compare-and-set on the
   * version read before the bytes moved) and releases the old bytes.
   */
  private async executeTransfer(op: Operation): Promise<void> {
    const file = await this.store.file(op.fileId!);
    if (!file || file.deletedAt !== undefined)
      throw new OperationRefusal(`file ${op.fileId} is deleted`);
    const from = await this.requireTarget(file.storage.targetId);
    const to = await this.requireTarget(op.toTargetId!);
    if (!to.enabled) throw new OperationRefusal(`target ${to.id} is disabled`);
    const source = await this.drivers(from);
    const dest = await this.drivers(to);
    const path =
      op.kind === 'move' ? keyFor(file, op.id) : `${keyFor(file, file.id)}.replica-${op.id}`;

    let stream: Readable;
    try {
      stream = await source.read(file.storage.path);
    } catch (err) {
      if (err instanceof StorageMissing) {
        await this.quarantine(file, op, 'the bytes the ledger names are missing');
        throw new OperationRefusal('the source bytes are missing');
      }
      throw err;
    }
    const written = await this.withProgress(op, stream, (s) => dest.write(path, s));
    if (written.sha256 !== file.checksum.value || written.sizeBytes !== file.sizeBytes) {
      await dest.remove(path);
      await this.quarantine(
        file,
        op,
        `the source's bytes hash to ${written.sha256}, not the ledger's ${file.checksum.value}`,
      );
      throw new OperationRefusal('the source does not match its checksum');
    }

    const at = this.now().toISOString();
    if (op.kind === 'copy') {
      const replica: Replica = {
        fileId: file.id,
        channelId: file.channelId,
        targetId: to.id,
        path,
        tier: to.tier,
        sha256: written.sha256,
        sizeBytes: written.sizeBytes,
        createdAt: at,
      };
      const replicas = await this.store.replicasOf(file.id);
      const previous = replicas.find((r) => r.targetId === to.id);
      const bumped: FileEntry = { ...file, version: file.version + 1, updatedAt: at };
      await this.complete(op, async (tx) => {
        if (!(await tx.putFile(bumped, file.version)))
          throw new Error('the file changed under the copy; retrying');
        if (previous && previous.path !== path) {
          await this.queueRelease(tx, previous.channelId, previous.targetId, previous.path, at);
        }
        await tx.putReplica(replica);
        await tx.enqueue(
          this.record('audit.recorded', file.channelId, op.correlationId, {
            entityType: 'file',
            entityId: file.id,
            revision: bumped.version,
            action: 'file.replicated',
            origin: { service: 'hsm' },
            delta: {
              [`replicas.${to.id}`]: { ...(previous ? { before: previous } : {}), after: replica },
            },
          } satisfies EventPayloads['audit.recorded']),
        );
      });
      return;
    }

    const moved: FileEntry = {
      ...file,
      storage: { targetId: to.id, path, tier: to.tier, status: 'available' },
      version: file.version + 1,
      updatedAt: at,
    };
    try {
      await this.complete(op, async (tx) => {
        if (!(await tx.putFile(moved, file.version)))
          throw new Error('the file changed under the move; retrying');
        await this.queueRelease(tx, file.channelId, file.storage.targetId, file.storage.path, at);
        await tx.enqueue(
          this.record('file.moved', file.channelId, op.correlationId, {
            assetId: file.assetId,
            renditionKind: file.kind,
            fromTier: file.storage.tier,
            toTier: to.tier,
            path,
            fileId: file.id,
            ...(file.variant !== undefined ? { variant: file.variant } : {}),
          } satisfies EventPayloads['file.moved']),
        );
        await tx.enqueue(this.fileAudit(moved, file, 'file.moved', op.correlationId));
      });
    } catch (err) {
      // Not referenced: the new bytes go. The source is untouched; a retry starts over.
      await dest.remove(path);
      throw err;
    }
  }

  /** Stream through a progress counter that renews the lease; stop if the lease is lost. */
  private async withProgress<T>(
    op: Operation,
    stream: Readable,
    sink: (s: Readable) => Promise<T>,
  ): Promise<T> {
    // A counting stage IN the pipeline — a 'data' listener on the source would start it flowing
    // before the sink is attached, and those bytes would be lost.
    let bytes = 0;
    let lastReport = Date.now();
    let lost = false;
    const counter = new Transform({
      transform: (chunk: Buffer, _enc, done) => {
        bytes += chunk.length;
        if (Date.now() - lastReport >= 1_000) {
          lastReport = Date.now();
          const leaseUntil = new Date(this.now().getTime() + this.leaseMs).toISOString();
          void this.store.progress(op.id, op.holder!, bytes, leaseUntil).then((held) => {
            if (!held && !lost) {
              lost = true;
              counter.destroy(new Error('the lease was lost to another worker'));
            }
          });
        }
        done(null, chunk);
      },
    });
    // A source error destroys the counter, which fails the sink's write — and so the attempt.
    pipeline(stream, counter, () => undefined);
    return sink(counter);
  }

  /** The terminal commit of a leased operation: `also` and the state change in ONE transaction. */
  private async complete(op: Operation, also: (tx: HsmTx) => Promise<void>): Promise<void> {
    const at = this.now().toISOString();
    const done: Operation = {
      ...op,
      state: 'completed',
      bytesDone: op.bytesTotal ?? op.bytesDone,
      updatedAt: at,
      completedAt: at,
    };
    const { holder: _h, leaseUntil: _l, ...clean } = done;
    void _h;
    void _l;
    await this.store.transaction(async (tx) => {
      if (!(await tx.putOperation(clean, 'running', op.holder))) {
        throw new Error('the lease was lost before the operation could commit');
      }
      await also(tx);
      await tx.enqueue(this.operationAudit(clean, op, 'file-operation.completed'));
    });
  }

  /** A failed attempt: retried with backoff, or dead-lettered — a refusal at once. */
  private async finish(op: Operation, holder: string | undefined, err: unknown): Promise<void> {
    const refusal = err instanceof OperationRefusal;
    const deadLetter = refusal || op.attempts >= MAX_ATTEMPTS;
    const at = this.now();
    const next: Operation = {
      ...op,
      state: deadLetter ? 'dead-letter' : 'failed',
      error: (err as Error).message,
      updatedAt: at.toISOString(),
      ...(deadLetter
        ? {}
        : { retryAt: new Date(at.getTime() + backoffMs(op.attempts)).toISOString() }),
    };
    const { holder: _h, leaseUntil: _l, ...clean } = next;
    void _h;
    void _l;
    await this.store.transaction(async (tx) => {
      if (!(await tx.putOperation(clean, 'running', holder))) return; // someone else settled it
      await tx.enqueue(
        this.operationAudit(
          clean,
          op,
          deadLetter ? 'file-operation.dead-lettered' : 'file-operation.failed',
        ),
      );
    });
  }

  /** The source is not what the ledger says: quarantine the file and raise the alert. */
  private async quarantine(file: FileEntry, op: Operation, reason: string): Promise<void> {
    const at = this.now().toISOString();
    const quarantined: FileEntry = {
      ...file,
      storage: { ...file.storage, status: 'quarantined' },
      version: file.version + 1,
      updatedAt: at,
    };
    await this.store.transaction(async (tx) => {
      if (!(await tx.putFile(quarantined, file.version))) return;
      await tx.enqueue(this.fileAudit(quarantined, file, 'file.quarantined', op.correlationId));
      await tx.enqueue(
        this.record('alert.raised', file.channelId, op.correlationId, {
          alertId: ulid(),
          source: 'hsm',
          kind: 'checksum-mismatch',
          severity: 'critical',
          subjectRef: { entityType: 'file', entityId: file.id },
          message: `${file.kind} of asset ${file.assetId} is quarantined: ${reason}`.slice(0, 1000),
          raisedAt: at,
        } satisfies EventPayloads['alert.raised']),
      );
    });
  }

  private async queueRelease(
    tx: HsmTx,
    channelId: string,
    targetId: string,
    path: string,
    at: string,
  ): Promise<void> {
    const op: Operation = {
      id: ulid(),
      channelId,
      kind: 'release',
      release: { targetId, path },
      state: 'queued',
      attempts: 0,
      bytesDone: 0,
      requestedBy: 'hsm',
      createdAt: at,
      updatedAt: at,
    };
    await tx.insertOperation(op);
  }

  // --- storage targets (EP-14.2) --------------------------------------------------------------------

  async targets(caller: Caller): Promise<StorageTarget[]> {
    this.authorizeAdmin(caller, caller.channelId);
    return this.store.targets(caller.channelId);
  }

  async target(caller: Caller, id: string): Promise<StorageTarget> {
    this.authorizeAdmin(caller, caller.channelId);
    const t = await this.store.target(id);
    if (!t || (t.channelId !== undefined && t.channelId !== caller.channelId))
      throw new NotFound(`storage target ${id}`);
    return t;
  }

  /** A channel's target, or — with an unscoped `storage:admin` — a platform-wide one. */
  async createTarget(
    caller: Caller,
    input: StorageTargetInput,
    platformWide: boolean,
  ): Promise<StorageTarget> {
    const channelId = platformWide ? undefined : caller.channelId;
    this.authorizeAdmin(caller, channelId);
    const at = this.now().toISOString();
    const target: StorageTarget = {
      id: ulid(),
      ...(channelId !== undefined ? { channelId } : {}),
      ...input,
      version: 1,
      createdBy: caller.userId,
      createdAt: at,
      updatedAt: at,
    };
    await this.writeTarget(caller, target, undefined);
    return target;
  }

  async updateTarget(
    caller: Caller,
    id: string,
    version: number,
    input: StorageTargetInput,
  ): Promise<StorageTarget> {
    const current = await this.store.target(id);
    if (!current || (current.channelId !== undefined && current.channelId !== caller.channelId)) {
      throw new NotFound(`storage target ${id}`);
    }
    this.authorizeAdmin(caller, current.channelId);
    if (input.kind !== current.kind)
      throw new ValidationError('kind cannot change: make a new target and move the files');
    if (input.tier !== current.tier)
      throw new ValidationError('tier cannot change: make a new target and move the files');
    const { root: _r, s3: _s, credentialRef: _c, ...kept } = current;
    void _r;
    void _s;
    void _c;
    const next: StorageTarget = {
      ...kept,
      ...input,
      version: version + 1,
      updatedAt: this.now().toISOString(),
    };
    await this.writeTarget(caller, next, current, version);
    return next;
  }

  /**
   * The platform's first online target, from the deployment's config — once. A deployment with no
   * target cannot place anything, so `main.ts` makes one from `ATLAS_HSM_BOOTSTRAP_ROOT`; after that
   * it is data like any other, and an edit is not undone on restart.
   */
  async bootstrapTarget(root: string): Promise<StorageTarget | undefined> {
    const existing = (await this.store.targets(undefined)).find((t) => t.channelId === undefined);
    if (existing) return undefined;
    const at = this.now().toISOString();
    const target: StorageTarget = {
      id: ulid(),
      name: 'online',
      tier: 'online',
      kind: 'fs',
      root,
      isDefault: true,
      enabled: true,
      version: 1,
      createdBy: 'hsm',
      createdAt: at,
      updatedAt: at,
    };
    await this.store.transaction(async (tx) => {
      if (!(await tx.putTarget(target))) return;
      await tx.enqueue(this.targetAudit(undefined, target, undefined, 'storage-target.created'));
    });
    return target;
  }

  private async writeTarget(
    caller: Caller,
    target: StorageTarget,
    before: StorageTarget | undefined,
    ifVersion?: number,
  ): Promise<void> {
    if (target.enabled && target.kind === 'fs') {
      // A target that cannot be written is refused, not saved to fail every placement later.
      try {
        await (await this.drivers(target)).probe();
      } catch (err) {
        throw new ValidationError(`root is not writable by HSM: ${(err as Error).message}`);
      }
    }
    const others =
      target.isDefault && target.enabled
        ? (await this.store.targets(target.channelId)).filter(
            (t) =>
              t.id !== target.id &&
              t.isDefault &&
              t.tier === target.tier &&
              t.channelId === target.channelId,
          )
        : [];
    await this.store.transaction(async (tx) => {
      // The previous default of this (scope, tier) yields — one place new files go.
      for (const other of others) {
        const demoted = {
          ...other,
          isDefault: false,
          version: other.version + 1,
          updatedAt: target.updatedAt,
        };
        if (!(await tx.putTarget(demoted, other.version)))
          throw new Conflict(`storage target ${other.id} changed; retry`);
        await tx.enqueue(this.targetAudit(caller, demoted, other, 'storage-target.updated'));
      }
      if (!(await tx.putTarget(target, ifVersion))) {
        throw new Conflict(`storage target ${target.id} is not at version ${ifVersion}; reload it`);
      }
      await tx.enqueue(
        this.targetAudit(
          caller,
          target,
          before,
          before ? 'storage-target.updated' : 'storage-target.created',
        ),
      );
    });
  }

  // --- authorization -------------------------------------------------------------------------------

  /**
   * The files group, strictly, as MTS and MAM's files read enforce it: HSM knows the channel and
   * nothing else about the asset (not its category), so a grant narrowed to a category is refused.
   */
  private authorizeFiles(caller: Caller, permission: 'asset:read'): void {
    const decision = canEnforce(caller.policy, permission, {
      type: 'asset',
      channelId: caller.channelId,
      fieldGroup: 'files',
    });
    if (!decision.allowed)
      throw new Forbidden(decision.reason ?? `${permission} on files required`);
  }

  /** `storage:admin` in the channel — or, for a platform-wide target (`channelId` absent), unscoped. */
  private authorizeAdmin(caller: Caller, channelId: string | undefined): void {
    const context =
      channelId !== undefined ? { type: 'storage-target', channelId } : { type: 'storage-target' };
    if (!canEnforce(caller.policy, 'storage:admin', context).allowed) {
      throw new Forbidden(
        channelId === undefined
          ? 'an unscoped storage:admin is required for a platform-wide storage target'
          : 'storage:admin required',
      );
    }
  }

  private async requireTarget(id: string): Promise<StorageTarget> {
    const t = await this.store.target(id);
    if (!t) throw new OperationRefusal(`storage target ${id} does not exist`);
    return t;
  }

  // --- events ---------------------------------------------------------------------------------------

  private placedEvent(file: FileEntry, correlationId?: string): OutboxRecord {
    return this.record('file.placed', file.channelId, correlationId, {
      assetId: file.assetId,
      renditionKind: file.kind,
      tier: file.storage.tier,
      path: file.storage.path,
      checksum: file.checksum,
      fileId: file.id,
      sizeBytes: file.sizeBytes,
      ...(file.variant !== undefined ? { variant: file.variant } : {}),
    } satisfies EventPayloads['file.placed']);
  }

  private fileAudit(
    after: FileEntry,
    before: FileEntry | undefined,
    action: string,
    correlationId?: string,
  ): OutboxRecord {
    return this.record('audit.recorded', after.channelId, correlationId, {
      entityType: 'file',
      entityId: after.id,
      revision: after.version,
      action,
      origin: { service: 'hsm' },
      delta: delta(
        before as unknown as Record<string, unknown> | undefined,
        after as unknown as Record<string, unknown>,
      ),
    } satisfies EventPayloads['audit.recorded']);
  }

  private operationAudit(
    after: Operation,
    before: Operation | undefined,
    action: string,
  ): OutboxRecord {
    const strip = (o: Operation | undefined) => {
      if (!o) return undefined;
      const { holder: _h, leaseUntil: _l, bytesDone: _b, ...rest } = o;
      void _h;
      void _l;
      void _b;
      return rest as unknown as Record<string, unknown>;
    };
    return this.record('audit.recorded', after.channelId, after.correlationId, {
      entityType: 'file-operation',
      entityId: after.id,
      revision: after.attempts + (after.state === 'queued' ? 1 : 2),
      action,
      origin: { service: 'hsm' },
      delta: delta(strip(before), strip(after)!),
    } satisfies EventPayloads['audit.recorded']);
  }

  private targetAudit(
    caller: Caller | undefined,
    after: StorageTarget,
    before: StorageTarget | undefined,
    action: string,
  ): OutboxRecord {
    // A platform-wide target's audit lands in the platform's own stream: `platform`.
    return this.record(
      'audit.recorded',
      after.channelId ?? 'platform',
      caller?.correlationId,
      {
        entityType: 'storage-target',
        entityId: after.id,
        revision: after.version,
        action,
        origin: { service: 'hsm' },
        delta: delta(
          before as unknown as Record<string, unknown> | undefined,
          after as unknown as Record<string, unknown>,
        ),
      } satisfies EventPayloads['audit.recorded'],
      caller ? { kind: 'user', id: caller.userId } : SYSTEM,
    );
  }

  private record(
    type: string,
    channelId: string,
    correlationId: string | undefined,
    payload: object,
    actor: { kind: 'service' | 'user'; id: string } = SYSTEM,
  ): OutboxRecord {
    const check = validatePayload(type, payload);
    if (!check.valid) {
      throw new Error(
        `${type} does not match its schema: ${check.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
      );
    }
    const envelope = buildEnvelope({
      type,
      channelId,
      payload: payload as Record<string, unknown>,
      actor,
      ...(correlationId !== undefined ? { correlationId } : {}),
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

export type { Tier };
