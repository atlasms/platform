// A behaviour suite every RimStore must pass — sqlite in tests, Postgres in production.
//
// Driven through RimService with a real staging directory, because what has to hold on the store
// actually deployed are properties of the whole upload: a part refused before it is stored, a
// resume answering from what was accepted, the last write winning, completion assembling the
// bytes in order with the checksum OF THOSE BYTES, the job and its events committing together,
// completion idempotent, another channel's upload not found, the sweeper taking only what expired.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid, validatePayload, type Envelope, type EventPayloads } from '@atlas/contracts';
import { InMemoryBroker, OutboxRelay, type OutboxStore } from '@atlas/messaging';
import { compile, type EffectivePolicy } from '@atlas/policy';
import { RimService, type Caller } from './service.ts';
import { fsStaging } from './staging.ts';
import type { RimStore } from './store.ts';

export interface RimStoreHarness {
  /** A clean store, plus the outbox store the relay drains — both on the same database. */
  make: () => Promise<{ store: RimStore; outbox: OutboxStore; cleanup?: () => Promise<void> }>;
}

const CH = 'ch12';
const policy: EffectivePolicy = compile({
  subjectId: 'user-1',
  permVersion: 1,
  rules: [{ id: 'r', permissions: ['ingest:read', 'ingest:write'] }],
  roles: [],
  groups: [],
});
const caller = (channelId = CH): Caller => ({
  userId: 'user-1',
  channelId,
  policy,
  correlationId: ulid(),
});

const PART = 1024;
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

export function rimStoreConformance(name: string, harness: RimStoreHarness): void {
  async function withFixture(
    fn: (f: {
      service: RimService;
      store: RimStore;
      dir: string;
      clock: { now: number };
      drain: () => Promise<Envelope[]>;
    }) => Promise<void>,
  ): Promise<void> {
    const { store, outbox, cleanup } = await harness.make();
    const dir = await mkdtemp(join(tmpdir(), 'rim-staging-'));
    const clock = { now: Date.parse('2026-09-14T12:00:00.000Z') };
    const broker = new InMemoryBroker();
    const relay = new OutboxRelay(outbox, broker);
    const service = new RimService({
      store,
      staging: fsStaging(dir),
      partSizeBytes: PART,
      uploadTtlMs: 60_000,
      now: () => new Date(clock.now),
    });
    const drain = async (): Promise<Envelope[]> => {
      await relay.drain();
      return broker.published.map((m) => m.body as Envelope);
    };
    try {
      await fn({ service, store, dir, clock, drain });
    } finally {
      await cleanup?.();
      await store.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  }

  test(`[${name}] the server sizes the parts, and refuses a part of the wrong length before storing it`, async () => {
    await withFixture(async ({ service, store }) => {
      const u = await service.start(caller(), { filename: 'clip.mxf', sizeBytes: PART * 2 + 100 });
      assert.equal(u.partSizeBytes, PART);
      assert.equal(u.partCount, 3);
      assert.deepEqual(u.received, []);
      assert.equal(u.state, 'open');

      // Too short for a middle part, too long for the last: neither is stored.
      await assert.rejects(
        service.putPart(caller(), u.uploadId, 1, randomBytes(PART - 1)),
        /1024 bytes/,
      );
      await assert.rejects(service.putPart(caller(), u.uploadId, 3, randomBytes(101)), /100 bytes/);
      await assert.rejects(
        service.putPart(caller(), u.uploadId, 4, randomBytes(PART)),
        /between 1 and 3/,
      );
      assert.deepEqual(await store.parts(u.uploadId), []);
    });
  });

  test(`[${name}] a resume answers from what was accepted, out of order, and the last write of a part wins`, async () => {
    await withFixture(async ({ service, store }) => {
      const u = await service.start(caller(), { filename: 'clip.mxf', sizeBytes: PART * 2 + 100 });
      const p3 = randomBytes(100);
      const p1a = randomBytes(PART);
      const p1b = randomBytes(PART);
      await service.putPart(caller(), u.uploadId, 3, p3);
      await service.putPart(caller(), u.uploadId, 1, p1a);
      assert.deepEqual((await service.status(caller(), u.uploadId)).received, [1, 3]);

      // Sent again — a retry after a lost response — and the record follows the bytes.
      await service.putPart(caller(), u.uploadId, 1, p1b);
      const parts = await store.parts(u.uploadId);
      assert.equal(parts.length, 2);
      assert.equal(parts[0]!.sha256, sha256(p1b), 'the second write of part 1 is the one recorded');

      // Completing with a hole names it rather than assembling around it.
      await assert.rejects(service.complete(caller(), u.uploadId), (err: unknown) => {
        const e = err as { status?: number; details?: { missing?: number[] } };
        assert.equal(e.status, 409);
        assert.deepEqual(e.details?.missing, [2]);
        return true;
      });
    });
  });

  test(`[${name}] completion assembles the parts in order, hashes what it wrote, and commits the job with its events`, async () => {
    await withFixture(async ({ service, store, drain }) => {
      const size = PART * 2 + 100;
      const whole = randomBytes(size);
      const u = await service.start(caller(), {
        filename: 'bulletin 1800.mxf',
        sizeBytes: size,
        contentType: 'application/mxf',
      });
      // Out of order on purpose: assembly is by part NUMBER, not by arrival.
      await service.putPart(caller(), u.uploadId, 2, whole.subarray(PART, PART * 2));
      await service.putPart(caller(), u.uploadId, 3, whole.subarray(PART * 2));
      await service.putPart(caller(), u.uploadId, 1, whole.subarray(0, PART));

      const job = await service.complete(caller(), u.uploadId);
      assert.equal(job.state, 'detected');
      assert.equal(job.source, 'upload');
      assert.equal(job.sourceKind, 'upload');
      assert.equal(job.channelId, CH);
      assert.equal(job.filename, 'bulletin 1800.mxf');
      assert.equal(job.sizeBytes, size);
      assert.equal(job.checksum, sha256(whole), 'the checksum is of the assembled bytes');
      assert.equal(job.contentType, 'application/mxf');
      assert.equal(job.version, 1);
      assert.equal(await readFile(job.receivedPath).then((b) => sha256(b)), sha256(whole));
      // The parts are gone once assembled; the received file stays for HSM (EP-14).
      assert.deepEqual(
        await stat(join(job.receivedPath, '..', 'part-1')).catch(() => 'gone'),
        'gone',
      );

      const after = await service.status(caller(), u.uploadId);
      assert.equal(after.state, 'completed');
      assert.equal(after.jobId, job.id);
      assert.deepEqual(await store.job(job.id), job);

      // Idempotent: the client whose 202 was lost asks again and gets the same job, no second one.
      const again = await service.complete(caller(), u.uploadId);
      assert.equal(again.id, job.id);

      // One transaction: the job, ingest.detected and the audit delta — and only once.
      const events = await drain();
      assert.deepEqual(events.map((e) => e.type).sort(), ['audit.recorded', 'ingest.detected']);
      for (const e of events) assert.ok(validatePayload(e.type, e.payload).valid, e.type);
      const detected = events.find((e) => e.type === 'ingest.detected')!
        .payload as unknown as EventPayloads['ingest.detected'];
      assert.equal(detected.sourceKind, 'upload');
      assert.equal(detected.sizeBytes, size);
      const audit = events.find((e) => e.type === 'audit.recorded')!
        .payload as unknown as EventPayloads['audit.recorded'];
      assert.equal(audit.entityType, 'ingest');
      assert.equal(audit.entityId, job.id);
      assert.equal(audit.revision, 1);
      assert.equal(audit.action, 'ingest.detected');
      assert.equal(
        (audit.delta as Record<string, { after?: unknown }>)['checksum']?.after,
        job.checksum,
      );
      assert.equal('receivedPath' in audit.delta, false, 'a disk path is not part of the trail');
      // A part after completion is refused: the bytes are already assembled.
      await assert.rejects(
        service.putPart(caller(), u.uploadId, 1, whole.subarray(0, PART)),
        /already complete/,
      );
    });
  });

  test(`[${name}] SECURITY: another channel's upload is not found, and ingest:write is required`, async () => {
    await withFixture(async ({ service }) => {
      const u = await service.start(caller(), { filename: 'a.bin', sizeBytes: 10 });
      await assert.rejects(service.status(caller('ch99'), u.uploadId), /not found|upload/i);
      await assert.rejects(
        service.putPart(caller('ch99'), u.uploadId, 1, randomBytes(10)),
        /not found|upload/i,
      );
      await assert.rejects(service.complete(caller('ch99'), u.uploadId), /not found|upload/i);
      const reader: Caller = {
        ...caller(),
        policy: compile({
          subjectId: 'user-2',
          permVersion: 1,
          rules: [{ id: 'r', permissions: ['ingest:read'] }],
          roles: [],
          groups: [],
        }),
      };
      await assert.rejects(
        service.start(reader, { filename: 'a.bin', sizeBytes: 10 }),
        /ingest:write/,
      );
    });
  });

  test(`[${name}] abort and the sweeper remove the parts and the row — and only what expired`, async () => {
    await withFixture(async ({ service, store, dir, clock }) => {
      const gone = await service.start(caller(), { filename: 'gone.bin', sizeBytes: PART });
      await service.putPart(caller(), gone.uploadId, 1, randomBytes(PART));
      await service.abort(caller(), gone.uploadId);
      assert.equal(await store.upload(gone.uploadId), undefined);
      assert.equal(await stat(join(dir, gone.uploadId)).catch(() => 'gone'), 'gone');
      await assert.rejects(service.abort(caller(), gone.uploadId), /not found|upload/i);

      const old = await service.start(caller(), { filename: 'old.bin', sizeBytes: PART });
      await service.putPart(caller(), old.uploadId, 1, randomBytes(PART));
      clock.now += 30_000;
      const fresh = await service.start(caller(), { filename: 'fresh.bin', sizeBytes: PART });
      clock.now += 31_000; // old is past its 60 s TTL; fresh has 29 s left
      assert.equal(await service.sweep(), 1);
      assert.equal(await store.upload(old.uploadId), undefined);
      assert.equal(await stat(join(dir, old.uploadId)).catch(() => 'gone'), 'gone');
      assert.ok(await store.upload(fresh.uploadId), 'the fresh upload is untouched');
      assert.equal(await service.sweep(), 0);
    });
  });
}
