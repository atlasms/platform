// A behaviour suite every RimStore must pass — sqlite in tests, Postgres in production.
//
// Driven through RimService with a real staging directory, because what has to hold on the store
// actually deployed are properties of the whole upload: a part refused before it is stored, a
// resume answering from what was accepted, the last write winning, completion assembling the
// bytes in order with the checksum OF THOSE BYTES, the job and its events committing together,
// completion idempotent, another channel's upload not found, the sweeper taking only what expired.
// And past the upload (EP-15.3/15.6): the verdict committed with its events under the state it
// read (two validators, one write), a rejected job's bytes gone, the review's transitions, the
// queue's keyset page, the rule sets' audit trail.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid, validatePayload, type Envelope, type EventPayloads } from '@atlas/contracts';
import { InMemoryBroker, OutboxRelay, type OutboxStore } from '@atlas/messaging';
import { compile, type EffectivePolicy } from '@atlas/policy';
import type { AcceptanceRuleSetInput } from './acceptance.ts';
import { RimService, type Caller } from './service.ts';
import { fsStaging } from './staging.ts';
import type { RimStore } from './store.ts';
import type { IngestJob } from './upload.ts';

export interface RimStoreHarness {
  /** A clean store, plus the outbox store the relay drains — both on the same database. */
  make: () => Promise<{ store: RimStore; outbox: OutboxStore; cleanup?: () => Promise<void> }>;
}

const CH = 'ch12';
const policy: EffectivePolicy = compile({
  subjectId: 'user-1',
  permVersion: 1,
  rules: [
    { id: 'r', permissions: ['ingest:read', 'ingest:write', 'ingest:approve', 'ingest:admin'] },
  ],
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
      /** Run the work deferred past the requests so far — the validations. */
      settle: () => Promise<void>;
      /** A completed upload of `size` random bytes, as the job the request answered with. */
      uploaded: (filename: string, size: number, who?: Caller) => Promise<IngestJob>;
    }) => Promise<void>,
  ): Promise<void> {
    const { store, outbox, cleanup } = await harness.make();
    const dir = await mkdtemp(join(tmpdir(), 'rim-staging-'));
    const clock = { now: Date.parse('2026-09-14T12:00:00.000Z') };
    const broker = new InMemoryBroker();
    const relay = new OutboxRelay(outbox, broker);
    const deferred: (() => Promise<void>)[] = [];
    const service = new RimService({
      store,
      staging: fsStaging(dir),
      partSizeBytes: PART,
      uploadTtlMs: 60_000,
      validateAfterMs: 5_000,
      now: () => new Date(clock.now),
      defer: (task) => deferred.push(task),
    });
    const drain = async (): Promise<Envelope[]> => {
      await relay.drain();
      return broker.published.map((m) => m.body as Envelope);
    };
    const settle = async (): Promise<void> => {
      while (deferred.length > 0) await deferred.shift()!();
    };
    const uploaded = async (filename: string, size: number, who = caller()): Promise<IngestJob> => {
      const u = await service.start(who, { filename, sizeBytes: size });
      for (let n = 1; n <= u.partCount; n += 1) {
        await service.putPart(
          who,
          u.uploadId,
          n,
          randomBytes(n === u.partCount ? size - PART * (n - 1) : PART),
        );
      }
      return service.complete(who, u.uploadId);
    };
    try {
      await fn({ service, store, dir, clock, drain, settle, uploaded });
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
      assert.equal(await readFile(job.receivedPath!).then((b) => sha256(b)), sha256(whole));
      // The parts are gone once assembled; the received file stays for HSM (EP-14).
      assert.deepEqual(
        await stat(join(job.receivedPath!, '..', 'part-1')).catch(() => 'gone'),
        'gone',
      );

      const after = await service.status(caller(), u.uploadId);
      assert.equal(after.state, 'completed');
      assert.equal(after.jobId, job.id);
      assert.deepEqual(await store.job(job.id), job);

      // Idempotent: the client whose 202 was lost asks again and gets the same job, no second one.
      const again = await service.complete(caller(), u.uploadId);
      assert.equal(again.id, job.id);

      // One transaction: the job, ingest.detected and the audit delta — and only once. The
      // validation that follows is deferred past the request and has not run here.
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

  // --- EP-15.3: validation ------------------------------------------------------------------------------

  const ruleSet = (over: Partial<AcceptanceRuleSetInput> = {}): AcceptanceRuleSetInput => ({
    name: 'broadcast masters',
    scope: {},
    rules: [],
    enabled: true,
    ...over,
  });
  const auditsOf = (events: Envelope[], entityId: string) =>
    events
      .filter((e) => e.type === 'audit.recorded')
      .map((e) => e.payload as unknown as EventPayloads['audit.recorded'])
      .filter((a) => a.entityId === entityId)
      .sort((a, b) => a.revision - b.revision);

  test(`[${name}] with no applicable rule set a job is accepted: revision 2, no ingest.rejected`, async () => {
    await withFixture(async ({ service, uploaded, settle, drain }) => {
      // A disabled set and a set scoped to another source kind are not applicable.
      await service.createRuleSet(
        caller(),
        ruleSet({
          enabled: false,
          rules: [{ id: ulid(), kind: 'minSizeBytes', onFail: 'reject', bytes: 1 << 30 }],
        }),
      );
      await service.createRuleSet(
        caller(),
        ruleSet({
          scope: { sourceKind: 'watch' },
          rules: [{ id: ulid(), kind: 'minSizeBytes', onFail: 'reject', bytes: 1 << 30 }],
        }),
      );
      const job = await uploaded('clip.mxf', PART + 1);
      assert.equal(job.state, 'detected', 'the request answers before validation');
      await settle();
      const after = await service.job(caller(), job.id);
      assert.equal(after.state, 'accepted');
      assert.equal(after.version, 2);
      assert.equal(after.reason, undefined);
      assert.ok(after.receivedPath, 'an accepted job keeps its bytes for HSM');
      const events = await drain();
      assert.equal(
        events.some((e) => e.type === 'ingest.rejected'),
        false,
      );
      const audits = auditsOf(events, job.id);
      assert.deepEqual(
        audits.map((a) => [a.revision, a.action]),
        [
          [1, 'ingest.detected'],
          [2, 'ingest.validated'],
        ],
      );
      assert.deepEqual(audits[1]!.delta['state'], { before: 'detected', after: 'accepted' });
    });
  });

  test(`[${name}] a failed rule quarantines or rejects with the reason and the rule; reject beats quarantine; rejected bytes go`, async () => {
    await withFixture(async ({ service, uploaded, settle, drain }) => {
      const small = ulid();
      const mxf = ulid();
      await service.createRuleSet(
        caller(),
        ruleSet({
          scope: { sourceKind: 'upload' },
          rules: [
            {
              id: small,
              kind: 'minSizeBytes',
              onFail: 'quarantine',
              bytes: PART * 2,
              label: 'no stubs',
            },
            { id: mxf, kind: 'container', onFail: 'reject', containers: ['mxf', 'mov'] },
          ],
        }),
      );

      // Too small, right container: quarantined by the first rule — held, bytes kept.
      const held = await uploaded('short.mxf', PART);
      await settle();
      const q = await service.job(caller(), held.id);
      assert.equal(q.state, 'quarantined');
      assert.equal(q.ruleId, small);
      assert.match(q.reason ?? '', /under the minimum/);
      assert.match(q.reason ?? '', /no stubs/);
      assert.ok(
        q.receivedPath && (await stat(q.receivedPath)).isFile(),
        'a quarantined job keeps its bytes',
      );

      // Too small AND the wrong container: the reject wins, whatever the order — bytes discarded.
      const bad = await uploaded('short.avi', PART);
      await settle();
      const r = await service.job(caller(), bad.id);
      assert.equal(r.state, 'rejected');
      assert.equal(r.ruleId, mxf);
      assert.match(r.reason ?? '', /container "avi" is not one of mxf, mov/);
      assert.equal(r.receivedPath, undefined, 'a rejected job has no bytes to point at');
      assert.equal(
        await stat(bad.receivedPath!).catch(() => 'gone'),
        'gone',
        'the file is discarded',
      );

      const events = await drain();
      const rejected = events
        .filter((e) => e.type === 'ingest.rejected')
        .map((e) => e.payload as unknown as EventPayloads['ingest.rejected']);
      assert.deepEqual(
        rejected.map((e) => [e.ingestJobId, e.quarantined, e.ruleId]),
        [
          [held.id, true, small],
          [bad.id, false, mxf],
        ],
      );
      for (const e of events) assert.ok(validatePayload(e.type, e.payload).valid, e.type);
      assert.equal(
        events.find((e) => e.type === 'ingest.rejected')?.actor?.kind,
        'service',
        "the verdict is the system's",
      );
      const audits = auditsOf(events, bad.id);
      assert.deepEqual(
        audits.map((a) => [a.revision, a.action]),
        [
          [1, 'ingest.detected'],
          [2, 'ingest.rejected'],
        ],
      );
      assert.deepEqual(audits[1]!.delta['reason'], { after: r.reason });
      assert.equal('receivedPath' in audits[1]!.delta, false);

      // The wrong container alone, or the size alone with the size rule set to reject: still stable.
      const rules = await service.ruleSets(caller());
      assert.equal(rules.length, 1);
    });
  });

  test(`[${name}] two validators race: exactly one verdict is written, and its events once`, async () => {
    await withFixture(async ({ service, uploaded, settle, drain }) => {
      await service.createRuleSet(
        caller(),
        ruleSet({ rules: [{ id: ulid(), kind: 'maxSizeBytes', onFail: 'quarantine', bytes: 10 }] }),
      );
      const job = await uploaded('big.mxf', PART);
      // The request's deferred validation and the recovery loop's, at once.
      const [a, b] = await Promise.all([service.validate(job.id), service.validate(job.id)]);
      await settle();
      assert.equal(a?.state, 'quarantined');
      assert.equal(b?.state, 'quarantined');
      assert.equal(a?.version, 2);
      assert.equal(b?.version, 2);
      const events = await drain();
      assert.equal(events.filter((e) => e.type === 'ingest.rejected').length, 1);
      assert.equal(auditsOf(events, job.id).length, 2);
    });
  });

  test(`[${name}] the recovery loop validates a job whose validation never ran — after the grace, not before`, async () => {
    await withFixture(async ({ service, uploaded, clock }) => {
      const job = await uploaded('lost.mxf', PART);
      // Deferred work never runs here (the process died between the commit and the validation).
      assert.equal(await service.recover(), 0, 'a fresh job may still have its validation coming');
      clock.now += 5_001;
      assert.equal(await service.recover(), 1);
      assert.equal((await service.job(caller(), job.id)).state, 'accepted');
      assert.equal(await service.recover(), 0);
    });
  });

  // --- EP-15.6: the review and the queue ---------------------------------------------------------------

  test(`[${name}] the review: accept clears the rule and keeps it in the history; reject records the operator's reason and discards the bytes; anything else is a 409`, async () => {
    await withFixture(async ({ service, uploaded, settle, drain }) => {
      await service.createRuleSet(
        caller(),
        ruleSet({
          rules: [{ id: ulid(), kind: 'minSizeBytes', onFail: 'quarantine', bytes: PART * 2 }],
        }),
      );
      const a = await uploaded('a.mxf', PART);
      const b = await uploaded('b.mxf', PART);
      await settle();

      const accepted = await service.acceptJob(caller(), a.id);
      assert.equal(accepted.state, 'accepted');
      assert.equal(accepted.version, 3);
      assert.equal(accepted.reason, undefined);
      assert.equal(accepted.ruleId, undefined);
      assert.ok(accepted.receivedPath);

      await assert.rejects(service.rejectJob(caller(), b.id, '   '), /reason/);
      const rejected = await service.rejectJob(caller(), b.id, 'wrong bulletin');
      assert.equal(rejected.state, 'rejected');
      assert.equal(rejected.reason, 'wrong bulletin');
      assert.equal(rejected.receivedPath, undefined);
      assert.equal(await stat(b.receivedPath!).catch(() => 'gone'), 'gone');

      // Only a quarantined job is reviewable.
      await assert.rejects(service.acceptJob(caller(), a.id), /not quarantined/);
      await assert.rejects(service.rejectJob(caller(), b.id, 'again'), /not quarantined/);
      await assert.rejects(service.acceptJob(caller('ch99'), a.id), /ingest job/);

      const events = await drain();
      const audits = auditsOf(events, a.id);
      assert.deepEqual(
        audits.map((x) => [x.revision, x.action]),
        [
          [1, 'ingest.detected'],
          [2, 'ingest.rejected'],
          [3, 'ingest.accept'],
        ],
      );
      assert.deepEqual(audits[2]!.delta['state'], { before: 'quarantined', after: 'accepted' });
      assert.ok(audits[2]!.delta['reason']?.before, 'the reason it was held stays in the history');
      const operatorReject = events
        .filter((e) => e.type === 'ingest.rejected')
        .map((e) => e.payload as unknown as EventPayloads['ingest.rejected'])
        .find((e) => e.ingestJobId === b.id && e.quarantined === false);
      assert.equal(operatorReject?.reason, 'wrong bulletin');
      assert.equal(operatorReject?.ruleId, undefined, 'an operator is not a rule');
    });
  });

  test(`[${name}] the queue: the caller's channel, newest first, by state, keyset-paged`, async () => {
    await withFixture(async ({ service, uploaded, settle }) => {
      await service.createRuleSet(
        caller(),
        ruleSet({
          rules: [{ id: ulid(), kind: 'container', onFail: 'quarantine', containers: ['mxf'] }],
        }),
      );
      const ids: string[] = [];
      for (const name of ['1.mxf', '2.avi', '3.mxf', '4.avi', '5.mxf'])
        ids.push((await uploaded(name, PART)).id);
      const other = await uploaded('elsewhere.mxf', PART, caller('ch99'));
      await settle();

      const page1 = await service.queue(caller(), { limit: 2, order: 'desc' });
      assert.deepEqual(
        page1.items.map((j) => j.id),
        [ids[4], ids[3]],
      );
      assert.equal(page1.nextCursor, ids[3]);
      const page2 = await service.queue(caller(), {
        limit: 2,
        order: 'desc',
        cursor: page1.nextCursor!,
      });
      assert.deepEqual(
        page2.items.map((j) => j.id),
        [ids[2], ids[1]],
      );
      const page3 = await service.queue(caller(), {
        limit: 2,
        order: 'desc',
        cursor: page2.nextCursor!,
      });
      assert.deepEqual(
        page3.items.map((j) => j.id),
        [ids[0]],
      );
      assert.equal(page3.nextCursor, undefined, 'the end is the absence of a cursor');

      const held = await service.queue(caller(), { limit: 50, order: 'asc', state: 'quarantined' });
      assert.deepEqual(
        held.items.map((j) => j.filename),
        ['2.avi', '4.avi'],
      );
      assert.equal(
        held.items.some((j) => j.id === other.id),
        false,
        "another channel's jobs are not here",
      );
      assert.equal(
        (await service.queue(caller('ch99'), { limit: 50, order: 'desc' })).items.length,
        1,
      );
    });
  });

  test(`[${name}] rule sets: created, replaced and deleted with an audit revision each; another channel's is not found`, async () => {
    await withFixture(async ({ service, drain }) => {
      const set = await service.createRuleSet(caller(), ruleSet({ name: 'v1' }));
      assert.equal(set.version, 1);
      assert.equal(set.channelId, CH);
      const replaced = await service.replaceRuleSet(
        caller(),
        set.id,
        ruleSet({ name: 'v2', enabled: false }),
      );
      assert.equal(replaced.version, 2);
      assert.equal(replaced.name, 'v2');
      assert.equal(replaced.createdAt, set.createdAt);
      assert.deepEqual(await service.ruleSets(caller()), [replaced]);
      await assert.rejects(service.ruleSet(caller('ch99'), set.id), /rule set/);
      await assert.rejects(service.replaceRuleSet(caller('ch99'), set.id, ruleSet()), /rule set/);
      await service.deleteRuleSet(caller(), set.id);
      await assert.rejects(service.ruleSet(caller(), set.id), /rule set/);
      assert.deepEqual(await service.ruleSets(caller()), []);

      const audits = auditsOf(await drain(), set.id);
      assert.deepEqual(
        audits.map((a) => [a.entityType, a.revision, a.action]),
        [
          ['acceptance-rule-set', 1, 'acceptance-rules.created'],
          ['acceptance-rule-set', 2, 'acceptance-rules.replaced'],
          ['acceptance-rule-set', 3, 'acceptance-rules.deleted'],
        ],
      );
      assert.deepEqual(audits[1]!.delta['name'], { before: 'v1', after: 'v2' });
      assert.deepEqual(audits[2]!.delta['name'], { before: 'v2' });
    });
  });
}
