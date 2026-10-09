// A behaviour suite every ScheduleStore must pass — sqlite in tests, Postgres in production.
//
// Driven through SchedulingService, because what has to hold on the store actually deployed are
// properties of the unit of work: a reel replaced atomically with its events, ids preserved across
// a save, the aggregate's invariants refused, the thin write path NOT refusing overlaps, and the
// two §3.6 reads answering from the materialized rows.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEnvelope,
  subjectFor,
  ulid,
  validatePayload,
  type Envelope,
  type EventPayloads,
} from '@atlas/contracts';
import { InMemoryBroker, OutboxRelay, type Message, type OutboxStore } from '@atlas/messaging';
import { compile, type EffectivePolicy } from '@atlas/policy';
import { SchedulingService, type Caller } from './service.ts';
import type { ScheduleItemInput } from './schedule.ts';
import type { ScheduleStore } from './store.ts';

export interface ScheduleStoreHarness {
  /** A clean store, plus the outbox store the relay drains — both on the same database. */
  make: () => Promise<{ store: ScheduleStore; outbox: OutboxStore; cleanup?: () => Promise<void> }>;
}

const CH = 'ch12';
const policy: EffectivePolicy = compile({
  subjectId: 'user-1',
  permVersion: 1,
  rules: [{ id: 'r', permissions: ['schedule:read', 'schedule:write'] }],
  roles: [],
  groups: [],
});
const caller = (channelId = CH): Caller => ({
  userId: 'user-1',
  channelId,
  policy,
  correlationId: ulid(),
});

const T0 = Date.parse('2026-09-12T06:00:00.000Z');
const at = (min: number): string => new Date(T0 + min * 60_000).toISOString();
const media = (
  seq: number,
  startMin: number,
  durationMin: number,
  extra: Partial<ScheduleItemInput> = {},
): ScheduleItemInput => ({
  seq,
  start: at(startMin),
  durationSec: durationMin * 60,
  fixed: false,
  itemType: 'media',
  mediaId: ulid(),
  description: '',
  repeat: false,
  featured: false,
  ...extra,
});

/** A live item: streamed, so no mediaId — the key is absent, not undefined. */
const live = (
  seq: number,
  startMin: number,
  durationMin: number,
  extra: Partial<ScheduleItemInput> = {},
): ScheduleItemInput => {
  const { mediaId: _none, ...rest } = media(seq, startMin, durationMin, extra);
  void _none;
  return { ...rest, itemType: 'live' };
};

/** A MAM lifecycle event as the broker delivers it — a real envelope, at a chosen time. */
function assetEvent(
  type: string,
  payload: Record<string, unknown>,
  occurredAt: string,
  channelId = CH,
): Message {
  const envelope = buildEnvelope({
    type,
    channelId,
    payload,
    actor: { kind: 'user', id: 'u-mam' },
  });
  const body = { ...envelope, occurredAt };
  return { id: envelope.messageId, subject: subjectFor(channelId, type), body };
}
const approved = (assetId: string, at: string, expiresAt?: string): Message =>
  assetEvent(
    'asset.approved',
    { assetId, approver: 'u-2', approvedAt: at, ...(expiresAt ? { expiresAt } : {}) },
    at,
  );

/** A librarian: asset rights read and written (the `rights` field group), plus scheduling. */
const librarian = (channelId = CH): Caller => ({
  userId: 'user-lib',
  channelId,
  correlationId: ulid(),
  policy: compile({
    subjectId: 'user-lib',
    permVersion: 1,
    rules: [
      { id: 'sched', permissions: ['schedule:read', 'schedule:write'] },
      { id: 'read', permissions: ['asset:read'] },
      { id: 'rights', permissions: ['asset:write'], fieldGroups: ['rights'] },
    ],
    roles: [],
    groups: [],
  }),
});

export function scheduleStoreConformance(name: string, harness: ScheduleStoreHarness): void {
  async function withFixture(
    fn: (f: {
      service: SchedulingService;
      store: ScheduleStore;
      drain: () => Promise<Envelope[]>;
    }) => Promise<void>,
  ): Promise<void> {
    const { store, outbox, cleanup } = await harness.make();
    const broker = new InMemoryBroker();
    const relay = new OutboxRelay(outbox, broker);
    const service = new SchedulingService({ store });
    const drain = async (): Promise<Envelope[]> => {
      await relay.drain();
      return broker.published.map((m) => m.body as Envelope);
    };
    try {
      await fn({ service, store, drain });
    } finally {
      await cleanup?.();
      await store.close().catch(() => undefined);
    }
  }

  test(`[${name}] a schedule is one per channel per broadcast day, and channel-scoped on read`, async () => {
    await withFixture(async ({ service }) => {
      const s = await service.create(caller(), {
        broadcastDate: '2026-09-12',
        timezone: 'Europe/London',
      });
      assert.equal(s.state, 'draft');
      assert.equal(s.version, 1);
      await assert.rejects(
        service.create(caller(), { broadcastDate: '2026-09-12', timezone: 'Europe/London' }),
        /already exists/,
      );
      await service.create(caller('ch99'), { broadcastDate: '2026-09-12', timezone: 'UTC' }); // another channel: fine
      await assert.rejects(
        service.get(caller('ch99'), s.id),
        /not found|schedule/i,
        "another channel's schedule is not found, not forbidden",
      );
      assert.deepEqual(
        (await service.list(caller())).items.map((x) => x.id),
        [s.id],
      );
    });
  });

  test(`[${name}] the reel is persisted AS GIVEN — overlaps and gaps are not refused (§3.4)`, async () => {
    await withFixture(async ({ service }) => {
      const s = await service.create(caller(), { broadcastDate: '2026-09-12', timezone: 'UTC' });
      // 0–30, 20–50 (overlap), 90–100 (gap). The editor owns these; /validate reports them.
      const reel = await service.replaceItems(caller(), s.id, [
        media(0, 0, 30),
        media(1, 20, 30),
        media(2, 90, 10),
      ]);
      assert.equal(reel.length, 3);
      assert.deepEqual(
        reel.map((i) => i.seq),
        [0, 1, 2],
      );
      assert.equal(reel[0]?.end, at(30), 'end is computed from the materialized start + duration');
      assert.equal(
        (await service.get(caller(), s.id)).version,
        2,
        'a reel write bumps the schedule version',
      );
    });
  });

  test(`[${name}] a save keeps the ids it is given and mints the ones it is not`, async () => {
    await withFixture(async ({ service }) => {
      const s = await service.create(caller(), { broadcastDate: '2026-09-12', timezone: 'UTC' });
      const keep = ulid();
      const first = await service.replaceItems(caller(), s.id, [
        media(0, 0, 10, { id: keep }),
        media(1, 10, 10),
      ]);
      assert.equal(first[0]?.id, keep);
      const minted = first[1]?.id;
      assert.ok(minted && minted !== keep);
      // Save again with the same rows: the kept id survives, the minted one is sent back and kept too.
      const second = await service.replaceItems(caller(), s.id, [
        media(0, 0, 10, { id: keep, description: 'edited' }),
        media(1, 10, 10, { id: minted }),
      ]);
      assert.deepEqual(
        second.map((i) => i.id),
        [keep, minted],
      );
      assert.equal(second[0]?.description, 'edited');
    });
  });

  test(`[${name}] the aggregate's own invariants ARE refused: duplicate seq, live with media, nesting`, async () => {
    await withFixture(async ({ service }) => {
      const s = await service.create(caller(), { broadcastDate: '2026-09-12', timezone: 'UTC' });
      await assert.rejects(
        service.replaceItems(caller(), s.id, [media(0, 0, 10), media(0, 10, 10)]),
        /seq 0 appears twice/,
      );
      await assert.rejects(
        service.addItem(caller(), s.id, { ...media(0, 0, 10), itemType: 'live' }), // mediaId present
        /live item has no mediaId/,
      );
      const liveId = ulid();
      const child = ulid();
      await assert.rejects(
        service.replaceItems(caller(), s.id, [
          live(0, 0, 60, { id: liveId }),
          media(0, 0, 10, { id: child, parentItemId: liveId }),
          media(0, 10, 10, { parentItemId: child }), // a sub-schedule inside a sub-schedule
        ]),
        /only a live item may have a sub-schedule|cannot be nested/,
      );
      await assert.rejects(
        service.replaceItems(caller(), s.id, [media(0, 0, 10, { parentItemId: ulid() })]),
        /is not in this reel/,
      );
    });
  });

  test(`[${name}] a live item's sub-schedule reads back nested, and is removed with its parent`, async () => {
    await withFixture(async ({ service }) => {
      const s = await service.create(caller(), { broadcastDate: '2026-09-12', timezone: 'UTC' });
      const liveId = ulid();
      await service.replaceItems(caller(), s.id, [
        media(0, 0, 10),
        live(1, 10, 60, { id: liveId }),
        media(1, 30, 10, { parentItemId: liveId }),
        media(0, 10, 20, { parentItemId: liveId }),
        media(2, 70, 10),
      ]);
      const reel = await service.items(caller(), s.id);
      assert.deepEqual(
        reel.map((i) => [i.seq, i.parentItemId === liveId ? 'child' : 'top']),
        [
          [0, 'top'],
          [1, 'top'], // the live item
          [0, 'child'],
          [1, 'child'],
          [2, 'top'],
        ],
        'reel order: each live item followed by its sub-reel, both by seq',
      );
      await service.removeItem(caller(), s.id, liveId);
      assert.deepEqual(
        (await service.items(caller(), s.id)).map((i) => i.seq),
        [0, 2],
        'the sub-schedule went with it',
      );
    });
  });

  test(`[${name}] a header write leaves the reel intact — an upsert, not delete-and-insert`, async () => {
    // Found by this suite: sqlite's INSERT OR REPLACE is DELETE + INSERT, and the items cascade on
    // delete, so a PATCH to the notes wiped the reel on the test double while Postgres kept it.
    await withFixture(async ({ service }) => {
      const s = await service.create(caller(), { broadcastDate: '2026-09-12', timezone: 'UTC' });
      await service.replaceItems(caller(), s.id, [media(0, 0, 10), media(1, 10, 10)]);
      await service.update(caller(), s.id, { notes: 'still here?' });
      assert.equal(
        (await service.items(caller(), s.id)).length,
        2,
        'the reel survived the header write',
      );
      await service.addItem(caller(), s.id, media(2, 20, 10));
      assert.equal(
        (await service.items(caller(), s.id)).length,
        3,
        'and an append keeps the others',
      );
    });
  });

  test(`[${name}] §3.6: "what is on air at T" answers from the materialized rows`, async () => {
    await withFixture(async ({ service, store }) => {
      const s = await service.create(caller(), { broadcastDate: '2026-09-12', timezone: 'UTC' });
      await service.replaceItems(caller(), s.id, [
        media(0, 0, 30),
        media(1, 30, 30),
        media(2, 60, 30),
      ]);
      const onAir = await store.onAir(CH, at(35), at(36));
      assert.deepEqual(
        onAir.map((i) => i.seq),
        [1],
      );
      const across = await store.onAir(CH, at(25), at(65));
      assert.deepEqual(
        across.map((i) => i.seq),
        [0, 1, 2],
      );
      assert.deepEqual(await store.onAir('ch99', at(0), at(90)), [], 'channel-scoped');
    });
  });

  test(`[${name}] every write emits schedule.updated AND audit.recorded, in one transaction, valid`, async () => {
    await withFixture(async ({ service, drain }) => {
      const s = await service.create(caller(), { broadcastDate: '2026-09-12', timezone: 'UTC' });
      await service.replaceItems(caller(), s.id, [media(0, 0, 10)]);
      await service.update(caller(), s.id, { notes: 'evening' });
      await service.update(caller(), s.id, { notes: 'evening' }); // no-op: nothing

      const events = await drain();
      // Per SUBJECT order, not global: the relay pipelines different subjects concurrently
      // (EP-03.7 — "different subjects do overlap, that is the point"), so schedule.updated and
      // audit.recorded may interleave on the wire. Each subject's own sequence is what is promised.
      assert.deepEqual(
        events.filter((e) => e.type === 'schedule.updated').length,
        3,
        'three writes, three schedule.updated — the no-op emitted nothing',
      );
      assert.deepEqual(events.filter((e) => e.type === 'audit.recorded').length, 3);
      for (const e of events) {
        const check = validatePayload(e.type, e.payload);
        assert.equal(check.valid, true, `${e.type}: ${JSON.stringify(check.errors)}`);
      }
      const audits = events
        .filter((e) => e.type === 'audit.recorded')
        .map((e) => e.payload as unknown as EventPayloads['audit.recorded']);
      assert.deepEqual(
        audits.map((a) => [a.action, a.revision]),
        [
          ['schedule.created', 1],
          ['schedule.updated', 2],
          ['schedule.updated', 3],
        ],
      );
      assert.ok(
        audits[1]?.delta['items'],
        'the reel change is in the delta, supplied by the caller',
      );
      assert.deepEqual(audits[2]?.delta, { notes: { after: 'evening' } });
      const updates = events
        .filter((e) => e.type === 'schedule.updated')
        .map((e) => e.payload as unknown as EventPayloads['schedule.updated']);
      assert.deepEqual(
        updates.map((u) => u.itemCount),
        [0, 1, 1],
        'in subject order: created empty, reel of one, header edit',
      );
    });
  });

  test(`[${name}] ATOMICITY: a refused reel leaves the previous reel, the header and the outbox untouched`, async () => {
    await withFixture(async ({ service, drain }) => {
      const s = await service.create(caller(), { broadcastDate: '2026-09-12', timezone: 'UTC' });
      await service.replaceItems(caller(), s.id, [media(0, 0, 10)]);
      const published = (await drain()).length;
      await assert.rejects(
        service.replaceItems(caller(), s.id, [media(0, 0, 10), media(0, 10, 10)]),
        /twice/,
      );
      assert.equal((await service.items(caller(), s.id)).length, 1);
      assert.equal((await service.get(caller(), s.id)).version, 2);
      assert.equal((await drain()).length, published);
    });
  });

  // --- EP-31: MAM's word on approvals, and the validation that reads it ------------------------------

  test(`[${name}] APPROVALS: each fact lands once, in any order — a stale verdict or expiry never undoes a newer one`, async () => {
    await withFixture(async ({ service, store }) => {
      const a = ulid();
      const first = approved(a, '2026-09-10T10:00:00.000Z', '2026-12-31T00:00:00.000Z');
      assert.equal(await service.applyAssetEvent(first), 'applied');
      assert.equal(await service.applyAssetEvent(first), 'duplicate', 'a redelivery is seen');
      assert.deepEqual(await store.approvals(CH, [a]), [
        {
          assetId: a,
          channelId: CH,
          state: 'approved',
          stateAsOf: '2026-09-10T10:00:00.000Z',
          expiresAt: '2026-12-31T00:00:00.000Z',
          expiryAsOf: '2026-09-10T10:00:00.000Z',
        },
      ]);

      // The expiry moved by an edit at 11:00; then an OLDER approval is redelivered: it sets nothing.
      const edited = assetEvent(
        'asset.updated',
        {
          assetId: a,
          changedFields: ['expiresAt'],
          source: 'user',
          expiresAt: '2026-10-01T00:00:00.000Z',
        },
        '2026-09-10T11:00:00.000Z',
      );
      assert.equal(await service.applyAssetEvent(edited), 'applied');
      const stale = approved(a, '2026-09-09T09:00:00.000Z');
      assert.equal(await service.applyAssetEvent(stale), 'unchanged');
      const [record] = await store.approvals(CH, [a]);
      assert.deepEqual(
        [record?.state, record?.expiresAt],
        ['approved', '2026-10-01T00:00:00.000Z'],
      );

      // An edit that does not touch the expiry, and an event about something else: nothing.
      const renamed = assetEvent(
        'asset.updated',
        { assetId: a, changedFields: ['title'], source: 'user' },
        '2026-09-10T12:00:00.000Z',
      );
      assert.equal(await service.applyAssetEvent(renamed), 'unchanged');
      const created = assetEvent(
        'asset.created',
        { assetId: a, title: 'x', type: 'video', state: 'created' },
        '2026-09-10T12:00:00.000Z',
      );
      assert.equal(await service.applyAssetEvent(created), 'ignored');

      // The expiry edit arriving BEFORE any verdict (two cursors, a redelivery): kept, verdict unknown.
      const b = ulid();
      await service.applyAssetEvent(
        assetEvent(
          'asset.updated',
          { assetId: b, changedFields: ['expiresAt'], source: 'user', expiresAt: null },
          '2026-09-10T11:00:00.000Z',
        ),
      );
      assert.equal((await store.approvals(CH, [b]))[0]?.state, 'unknown');
      await service.applyAssetEvent(
        approved(b, '2026-09-10T10:00:00.000Z', '2026-09-20T00:00:00.000Z'),
      );
      const [late] = await store.approvals(CH, [b]);
      assert.equal(late?.state, 'approved', 'the verdict still lands');
      assert.equal(late?.expiresAt, undefined, 'and the newer "cleared" expiry stands');

      // Rejected later: the verdict follows the latest word.
      await service.applyAssetEvent(
        assetEvent(
          'asset.rejected',
          { assetId: a, reason: 'bad audio' },
          '2026-09-11T08:00:00.000Z',
        ),
      );
      assert.equal((await store.approvals(CH, [a]))[0]?.state, 'rejected');

      // Another channel's record is not visible here, and another channel cannot write this one.
      assert.deepEqual(await store.approvals('ch99', [a, b]), []);
      await assert.rejects(
        service
          .applyAssetEvent(approved(a, '2026-09-12T00:00:00.000Z'))
          .then(() =>
            service.applyAssetEvent(
              assetEvent(
                'asset.expired',
                { assetId: a, expiredAt: '2026-09-12T00:00:00.000Z' },
                '2026-09-12T01:00:00.000Z',
                'ch99',
              ),
            ),
          ),
        /recorded in channel ch12, not ch99/,
      );
      // A body that is not an envelope is refused — to the broker, never skipped.
      await assert.rejects(
        service.applyAssetEvent({
          id: ulid(),
          subject: 'atlas.ch12.asset.approved',
          body: { assetId: a },
        }),
        /not an envelope/,
      );
    });
  });

  test(`[${name}] VALIDATE: every kind named on its item, judged at AIR time — and a failed run changes nothing but says so`, async () => {
    await withFixture(async ({ service, drain }) => {
      const s = await service.create(caller(), {
        broadcastDate: '2026-09-12',
        timezone: 'Europe/London',
      });
      const ok = ulid();
      const lapsing = ulid(); // approved, but only until 06:50 — it airs 06:40–07:00
      const never = ulid();
      await service.applyAssetEvent(approved(ok, '2026-09-01T00:00:00.000Z'));
      await service.applyAssetEvent(approved(lapsing, '2026-09-01T00:00:00.000Z', at(50)));
      const reel = await service.replaceItems(caller(), s.id, [
        media(0, 0, 30, { mediaId: ok, mediaTitle: 'News' }), //        06:00–06:30
        media(1, 20, 10, { mediaId: ok }), //                           06:20–06:30  overlap 10 min
        media(2, 40, 20, { mediaId: lapsing }), //                      06:40–07:00  gap 10 min; expiry
        media(3, 55, 5, { mediaId: never, fixed: true }), //            06:55–07:00  anchor 5 min; approval
        live(4, 60, 30, { description: 'studio' }), //                  07:00–07:30
      ]);
      const liveId = reel.find((i) => i.itemType === 'live')!.id;
      await service.addItem(caller(), s.id, {
        ...media(0, 85, 10, { mediaId: ok, mediaTitle: 'VT' }), //      07:25–07:35  outside its live item
        parentItemId: liveId,
      });
      const before = await service.get(caller(), s.id);
      const seen = (await drain()).length;

      const report = await service.validate(caller(), s.id);
      assert.equal(report.valid, false);
      assert.equal(report.state, 'draft');
      assert.equal(report.version, before.version, 'a failed run on a draft writes nothing');
      assert.deepEqual(report.unchecked, ['availability']);
      const byItem = (seq: number) => reel.find((i) => i.seq === seq && !i.parentItemId)!.id;
      assert.deepEqual(
        report.issues.map((i) => [i.kind, i.severity, i.seconds]),
        [
          ['overlap', 'critical', 600],
          ['gap', 'warning', 600],
          ['anchor', 'critical', 300],
          ['overlap', 'critical', undefined],
          ['expiry', 'critical', undefined],
          ['approval', 'critical', undefined],
        ],
      );
      assert.deepEqual(
        report.issues.slice(0, 3).map((i) => i.itemId),
        [byItem(1), byItem(2), byItem(3)],
      );
      // In the schedule's zone (BST, +1): what the person reading it plans in.
      assert.equal(
        report.issues[0]!.message,
        '“media” starts at 07:20:00, 600 s before “News” ends',
      );
      assert.match(report.issues[2]!.message, /runs 300 s into the fixed start of .* at 07:55:00$/);
      assert.match(
        report.issues[3]!.message,
        /“VT” runs outside its live item “studio” \(08:00:00–08:30:00\)/,
      );
      assert.match(
        report.issues[4]!.message,
        /the approval expires at 2026-09-12T06:50:00.000Z, before it ends$/,
      );
      assert.match(report.issues[5]!.message, /has no approval from MAM yet$/);

      const events = (await drain()).slice(seen);
      assert.deepEqual(
        events.map((e) => e.type),
        ['schedule.validated'],
        'announced, not audited: nothing changed',
      );
      const payload = events[0]!.payload as unknown as EventPayloads['schedule.validated'];
      assert.ok(validatePayload('schedule.validated', payload).valid);
      assert.equal(payload.issues?.length, 6);
    });
  });

  test(`[${name}] VALIDATE: a clean run makes a draft validated (audited); an edit, or a lapse, makes it a draft again`, async () => {
    await withFixture(async ({ service, drain }) => {
      const s = await service.create(caller(), { broadcastDate: '2026-09-12', timezone: 'UTC' });
      const a = ulid();
      await service.applyAssetEvent(approved(a, '2026-09-01T00:00:00.000Z'));
      await service.replaceItems(caller(), s.id, [
        media(0, 0, 30, { mediaId: a }),
        live(1, 30, 30),
      ]);
      await drain();

      const clean = await service.validate(caller(), s.id);
      assert.deepEqual(
        [clean.valid, clean.state, clean.version, clean.issues],
        [true, 'validated', 3, []],
      );
      // The last audit record of the stream — the sqlite outbox orders a transaction's rows by a
      // clock that ties, so position within one commit is not a thing to assert on.
      const lastAudit = (events: Envelope[]) =>
        events.filter((e) => e.type === 'audit.recorded').at(-1)!
          .payload as unknown as EventPayloads['audit.recorded'];
      let events = await drain();
      assert.deepEqual(
        events
          .slice(-3)
          .map((e) => e.type)
          .sort(),
        ['audit.recorded', 'schedule.updated', 'schedule.validated'],
      );
      const audit = lastAudit(events);
      assert.equal(audit.action, 'schedule.validated');
      assert.deepEqual(audit.delta['state'], { before: 'draft', after: 'validated' });

      // Validating again changes nothing: announced, not written.
      const again = await service.validate(caller(), s.id);
      assert.deepEqual([again.state, again.version], ['validated', 3]);

      // Any edit is a draft again (§3.1).
      const edited = await service.update(caller(), s.id, { notes: 'late change' });
      assert.equal(edited.state, 'draft');
      assert.equal((await service.validate(caller(), s.id)).state, 'validated');

      // With no edit at all, MAM rejects the media: the next run takes the schedule back to draft.
      await service.applyAssetEvent(
        assetEvent('asset.rejected', { assetId: a, reason: 'rights' }, '2026-09-11T00:00:00.000Z'),
      );
      const lapsed = await service.validate(caller(), s.id);
      assert.deepEqual([lapsed.valid, lapsed.state], [false, 'draft']);
      assert.match(lapsed.issues[0]!.message, /was rejected in review$/);
      events = await drain();
      assert.deepEqual(lastAudit(events).delta['state'], { before: 'validated', after: 'draft' });
    });
  });

  test(`[${name}] VALIDATE: the state is written only over the version validated — an edit in between is a 409`, async () => {
    await withFixture(async ({ service, store }) => {
      const s = await service.create(caller(), { broadcastDate: '2026-09-12', timezone: 'UTC' });
      const current = await store.get(s.id);
      const moved = { ...current!, state: 'validated' as const, version: current!.version + 1 };
      assert.equal(await store.transaction((tx) => tx.put(moved, current!.version + 5)), false);
      assert.equal(
        (await store.get(s.id))?.state,
        'draft',
        'nothing written over the wrong version',
      );
      assert.equal(await store.transaction((tx) => tx.put(moved, current!.version)), true);
      assert.equal((await store.get(s.id))?.state, 'validated');
    });
  });

  test(`[${name}] VALIDATE is schedule:write, in the caller's channel`, async () => {
    await withFixture(async ({ service }) => {
      const s = await service.create(caller(), { broadcastDate: '2026-09-12', timezone: 'UTC' });
      const reader: Caller = {
        ...caller(),
        policy: compile({
          subjectId: 'user-2',
          permVersion: 1,
          rules: [{ id: 'r', permissions: ['schedule:read'] }],
          roles: [],
          groups: [],
        }),
      };
      await assert.rejects(service.validate(reader, s.id), /schedule:write/);
      await assert.rejects(service.validate(caller('ch99'), s.id), /not found|schedule/i);
    });
  });

  // --- EP-31: rights windows ---------------------------------------------------------------------

  test(`[${name}] RIGHTS WINDOWS: written under the rights group, audited, compare-and-set, channel-scoped`, async () => {
    await withFixture(async ({ service, drain }) => {
      const asset = ulid();
      const w = await service.createRightsWindow(librarian(), {
        assetId: asset,
        validFrom: at(0),
        validTo: at(120),
        territory: 'GB',
      });
      assert.equal(w.version, 1);
      assert.equal(w.channelId, CH);
      assert.deepEqual(
        (await service.listRightsWindows(librarian(), { assetId: asset })).map((x) => x.id),
        [w.id],
      );
      const moved = await service.updateRightsWindow(librarian(), w.id, 1, {
        assetId: asset,
        validFrom: at(0),
        validTo: at(240),
      });
      assert.equal(moved.version, 2);
      assert.equal(moved.territory, undefined, 'a PUT replaces the terms — territory was not sent');
      await assert.rejects(
        service.updateRightsWindow(librarian(), w.id, 1, {
          assetId: asset,
          validFrom: at(0),
          validTo: at(60),
        }),
        /not at version 1/,
      );
      await assert.rejects(service.deleteRightsWindow(librarian(), w.id, 1), /not at version 1/);

      // Another channel's window is not found; the channel's list does not hold another's.
      await assert.rejects(
        service.getRightsWindow(librarian('ch99'), w.id),
        /not found|rights window/i,
      );
      assert.deepEqual(await service.listRightsWindows(librarian('ch99')), []);

      // A scheduler without the rights group reads nothing and writes nothing here.
      await assert.rejects(service.listRightsWindows(caller()), /asset:read/);
      await assert.rejects(
        service.createRightsWindow(caller(), {
          categoryId: 'films',
          validFrom: at(0),
          validTo: at(1),
        }),
        /asset:write/,
      );

      await service.deleteRightsWindow(librarian(), w.id, 2);
      assert.deepEqual(await service.listRightsWindows(librarian()), []);

      const audits = (await drain())
        .filter((e) => e.type === 'audit.recorded')
        .map((e) => e.payload as unknown as EventPayloads['audit.recorded'])
        .filter((a) => a.entityType === 'rights-window');
      assert.deepEqual(
        audits.map((a) => [a.action, a.revision]),
        [
          ['rights-window.created', 1],
          ['rights-window.updated', 2],
          ['rights-window.deleted', 3],
        ],
      );
      assert.deepEqual(audits[1]!.delta['validTo'], { before: at(120), after: at(240) });
      assert.deepEqual(audits[1]!.delta['territory'], { before: 'GB' });
      assert.deepEqual(
        audits[2]!.delta['assetId'],
        { before: asset },
        'a delete records what went',
      );
    });
  });

  test(`[${name}] VALIDATE: rights — the asset's windows govern, else its category's, else none; wholly inside one`, async () => {
    await withFixture(async ({ service }) => {
      const s = await service.create(caller(), { broadcastDate: '2026-09-12', timezone: 'UTC' });
      const [licensed, film, own] = [ulid(), ulid(), ulid()];
      for (const a of [licensed, film, own]) {
        await service.applyAssetEvent(approved(a, '2026-09-01T00:00:00.000Z'));
      }
      // `licensed` may air 06:00–06:45; category `films` 06:00–07:00 — but `licensed` is ALSO in
      // films, and its own window governs, so the category's longer window does not save it.
      await service.createRightsWindow(librarian(), {
        assetId: licensed,
        validFrom: at(0),
        validTo: at(45),
      });
      await service.createRightsWindow(librarian(), {
        categoryId: 'films',
        validFrom: at(0),
        validTo: at(60),
      });
      await service.replaceItems(caller(), s.id, [
        media(0, 0, 30, { mediaId: licensed, categoryId: 'films', mediaTitle: 'Licensed' }), //  inside
        media(1, 30, 30, { mediaId: licensed, categoryId: 'films', mediaTitle: 'Rerun' }), //    ends 07:00 > 06:45
        media(2, 60, 30, { mediaId: film, categoryId: 'films', mediaTitle: 'Film' }), //         after 07:00
        media(3, 90, 30, { mediaId: own, categoryId: 'news', mediaTitle: 'Own' }), //            not managed
      ]);
      const report = await service.validate(caller(), s.id);
      assert.deepEqual(report.unchecked, ['availability']);
      assert.deepEqual(
        report.issues.map((i) => [i.kind, i.severity, i.message.split(':')[0]]),
        [
          ['rights', 'critical', '“Rerun” at 06'],
          ['rights', 'critical', '“Film” at 07'],
        ],
      );
      assert.match(
        report.issues[0]!.message,
        /outside the media's rights windows \(2026-09-12T06:00–2026-09-12T06:45Z\)$/,
      );
      assert.match(report.issues[1]!.message, /outside the category's rights windows/);
      assert.equal(report.valid, false);

      // Another channel's windows are not this channel's licence.
      await service.createRightsWindow(librarian('ch99'), {
        categoryId: 'films',
        validFrom: at(0),
        validTo: at(600),
      });
      assert.equal((await service.validate(caller(), s.id)).issues.length, 2);
    });
  });
  test(`[${name}] a copy (§3.7) is ONE write on the target: the reel, schedule.updated and an audit record saying where it came from`, async () => {
    await withFixture(async ({ service, store, drain }) => {
      const a = await service.create(caller(), { broadcastDate: '2026-09-12', timezone: 'UTC' });
      const b = await service.create(caller(), { broadcastDate: '2026-09-13', timezone: 'UTC' });
      await service.replaceItems(caller(), a.id, [media(0, 0, 30), media(1, 30, 30)]);
      await service.replaceItems(caller(), b.id, [media(0, 1440, 30), media(1, 1500, 30)]);
      const target = await service.get(caller(), b.id);
      await drain();

      const out = await service.copy(caller(), a.id, {
        from: at(0),
        to: at(60),
        targetScheduleId: b.id,
        targetVersion: target.version,
        at: at(1440),
        mode: 'overwrite',
      });
      assert.deepEqual([out.copied, out.removed, out.schedule.version], [2, 1, target.version + 1]);
      const reel = await store.items(b.id);
      assert.deepEqual(
        reel.map((i) => [i.seq, i.start]),
        [
          [0, at(1440)],
          [1, at(1470)],
          [2, at(1500)],
        ],
      );
      const events = (await drain()).slice(-2);
      assert.deepEqual(
        events.map((e) => e.type),
        ['schedule.updated', 'audit.recorded'],
      );
      const audit = events[1]!.payload as unknown as EventPayloads['audit.recorded'];
      assert.equal(audit.action, 'schedule.copied');
      assert.equal(audit.entityId, b.id);
      assert.deepEqual((audit.delta as Record<string, { after?: unknown }>)['copiedFrom']?.after, {
        scheduleId: a.id,
        from: at(0),
        to: at(60),
        at: at(1440),
        mode: 'overwrite',
      });
      assert.ok(validatePayload('audit.recorded', audit).valid);

      // Over a version the target has moved past: refused, and nothing written.
      await assert.rejects(
        service.copy(caller(), a.id, {
          targetScheduleId: b.id,
          targetVersion: target.version,
          at: at(1440),
          mode: 'merge',
        }),
        /reload/,
      );
      assert.equal((await store.items(b.id)).length, 3);
      // Another channel's target is not found, whatever its id.
      await assert.rejects(
        service.copy(caller('ch99'), a.id, {
          targetScheduleId: b.id,
          targetVersion: out.schedule.version,
          at: at(1440),
          mode: 'merge',
        }),
        /not found|schedule/i,
      );
    });
  });
}
