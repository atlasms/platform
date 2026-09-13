// A behaviour suite every ScheduleStore must pass — sqlite in tests, Postgres in production.
//
// Driven through SchedulingService, because what has to hold on the store actually deployed are
// properties of the unit of work: a reel replaced atomically with its events, ids preserved across
// a save, the aggregate's invariants refused, the thin write path NOT refusing overlaps, and the
// two §3.6 reads answering from the materialized rows.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ulid, validatePayload, type Envelope, type EventPayloads } from '@atlas/contracts';
import { InMemoryBroker, OutboxRelay, type OutboxStore } from '@atlas/messaging';
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
}
