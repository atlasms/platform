// Copy a range (EP-31; data-model §3.7, FR-SCH-13): the planner, pure, and the operation over the
// wire — authorized, a compare-and-set on the target, one audited write.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from '@atlas/contracts';
import { compile, type Rule } from '@atlas/policy';
import { HealthRegistry } from '@atlas/service-kit';
import {
  buildSchedulingApp,
  endOf,
  INTERNAL_HEADERS,
  parseCopyRequest,
  planCopy,
  SchedulingService,
  sqliteScheduleStore,
  type ScheduleItem,
} from '../src/index.ts';

const day = (d: string, hhmm: string): string => `2026-09-${d}T${hhmm}:00.000Z`;

function item(
  scheduleId: string,
  seq: number,
  start: string,
  minutes: number,
  extra: Partial<ScheduleItem> = {},
): ScheduleItem {
  return {
    id: ulid(),
    scheduleId,
    seq,
    start,
    durationSec: minutes * 60,
    end: endOf(start, minutes * 60),
    fixed: false,
    itemType: 'media',
    mediaId: ulid(),
    description: `item ${seq}`,
    repeat: false,
    featured: false,
    ...extra,
  };
}

const A = ulid();
const B = ulid();

test('17:00–20:00 of day A onto 06:00 of day B: what STARTS in the range, shifted, with new ids', () => {
  const { mediaId: _none, ...live } = item(A, 2, day('12', '18:00'), 60, {
    itemType: 'live',
    fixed: true,
    mediaTitle: 'News at Six',
  });
  void _none;
  const source = [
    item(A, 0, day('12', '16:30'), 45), // starts before the range: not taken, though it runs into it
    item(A, 1, day('12', '17:15'), 45),
    live,
    item(A, 0, day('12', '18:10'), 10, { parentItemId: live.id }),
    item(A, 1, day('12', '18:30'), 10, { parentItemId: live.id }),
    item(A, 3, day('12', '19:30'), 60), // starts inside, ends after: taken whole, never cut
    item(A, 4, day('12', '20:00'), 30), // starts AT `to`: not taken
  ];
  const plan = planCopy(source, [], B, {
    from: day('12', '17:00'),
    to: day('12', '20:00'),
    at: day('13', '06:00'),
    mode: 'merge',
  });
  assert.equal(plan.copied, 5);
  assert.equal(plan.removed, 0);
  const tops = plan.items.filter((i) => i.parentItemId === undefined);
  assert.deepEqual(
    tops.map((i) => [i.seq, i.start, i.end]),
    [
      [0, day('13', '06:15'), day('13', '07:00')],
      [1, day('13', '07:00'), day('13', '08:00')],
      [2, day('13', '08:30'), day('13', '09:30')],
    ],
  );
  const copiedLive = tops[1]!;
  // The anchor and the overrides travel; the sub-schedule follows its live item, re-parented.
  assert.equal(copiedLive.fixed, true);
  assert.equal(copiedLive.mediaTitle, 'News at Six');
  assert.notEqual(copiedLive.id, live.id);
  assert.deepEqual(
    plan.items.filter((i) => i.parentItemId === copiedLive.id).map((i) => [i.seq, i.start]),
    [
      [0, day('13', '07:10')],
      [1, day('13', '07:30')],
    ],
  );
  assert.ok(plan.items.every((i) => i.scheduleId === B));
  assert.ok(
    plan.items.every((i) => !source.some((s) => s.id === i.id)),
    'every id is new',
  );
});

test('overwrite clears what starts in the destination range; merge keeps it, and seq is one sequence again', () => {
  const source = [item(A, 0, day('12', '17:00'), 30), item(A, 1, day('12', '17:30'), 30)];
  const target = [
    item(B, 0, day('13', '05:30'), 30), // before the destination range: kept either way
    item(B, 1, day('13', '06:00'), 30), // inside: cleared by an overwrite
    item(B, 2, day('13', '06:45'), 30), // inside
    item(B, 3, day('13', '07:00'), 30), // starts at the range's end: kept
  ];
  const request = { from: day('12', '17:00'), to: day('12', '18:00'), at: day('13', '06:00') };

  const over = planCopy(source, target, B, { ...request, mode: 'overwrite' });
  assert.deepEqual([over.copied, over.removed], [2, 2]);
  assert.deepEqual(
    over.items.map((i) => [i.seq, i.start.slice(11, 16), target.some((t) => t.id === i.id)]),
    [
      [0, '05:30', true],
      [1, '06:00', false],
      [2, '06:30', false],
      [3, '07:00', true],
    ],
  );

  const merged = planCopy(source, target, B, { ...request, mode: 'merge' });
  assert.deepEqual([merged.copied, merged.removed, merged.items.length], [2, 0, 6]);
  // At a tie, what was there comes first; the overlaps are /validate's to name, not the copy's.
  assert.deepEqual(
    merged.items.map((i) => [i.seq, i.start.slice(11, 16), target.some((t) => t.id === i.id)]),
    [
      [0, '05:30', true],
      [1, '06:00', true],
      [2, '06:00', false],
      [3, '06:30', false],
      [4, '06:45', true],
      [5, '07:00', true],
    ],
  );
});

test('no range is the whole reel, landing its first item at `at`; an empty range is refused', () => {
  const source = [item(A, 0, day('12', '06:00'), 60), item(A, 1, day('12', '07:00'), 60)];
  const plan = planCopy(source, source, A, { at: day('12', '20:00'), mode: 'merge' });
  assert.deepEqual(
    plan.items.map((i) => i.start.slice(11, 16)),
    ['06:00', '07:00', '20:00', '21:00'],
  );
  assert.throws(
    () =>
      planCopy(source, [], B, {
        from: day('12', '12:00'),
        to: day('12', '13:00'),
        at: day('13', '06:00'),
        mode: 'merge',
      }),
    /nothing to copy/,
  );
});

test('the request: a range both-or-neither, instants with a zone, a target version, a mode', () => {
  const ok = {
    from: day('12', '17:00'),
    to: day('12', '20:00'),
    targetScheduleId: B,
    targetVersion: 3,
    at: day('13', '06:00'),
    mode: 'overwrite',
  };
  assert.deepEqual(parseCopyRequest(ok), ok);
  const { from: _f, to: _t, ...whole } = ok;
  void _f;
  void _t;
  assert.deepEqual(parseCopyRequest(whole), whole);
  for (const [bad, why] of [
    [{ ...ok, to: undefined }, /from and to come together/],
    [{ ...ok, to: ok.from }, /to must be after from/],
    [{ ...ok, at: '2026-09-13 06:00' }, /at must be an ISO-8601 instant/],
    [{ ...ok, targetVersion: 0 }, /targetVersion is required/],
    [{ ...ok, mode: 'replace' }, /mode must be merge or overwrite/],
    [{ ...ok, extra: 1 }, /unknown field extra/],
  ] as const) {
    assert.throws(() => parseCopyRequest(bad), why);
  }
});

// --- over the wire --------------------------------------------------------------------------------

async function harness(permissions = ['schedule:read', 'schedule:write']) {
  const store = sqliteScheduleStore();
  const service = new SchedulingService({ store });
  const rules: Rule[] = permissions.map((p) => ({ id: `r-${p}`, permissions: [p] }));
  const app = await buildSchedulingApp({
    service,
    policyFor: () => compile({ subjectId: 'u1', permVersion: 1, rules, roles: [], groups: [] }),
    health: new HealthRegistry(),
  });
  const headers = {
    [INTERNAL_HEADERS.user]: 'u1',
    [INTERNAL_HEADERS.channel]: 'ch12',
    'content-type': 'application/json',
  };
  return { app, store, headers };
}

test('POST /copy: one audited write on the target, over the version read — a stale one is a 409', async () => {
  const { app, store, headers } = await harness();
  const create = async (broadcastDate: string) =>
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/schedules',
        headers,
        payload: { broadcastDate, timezone: 'UTC' },
      })
    ).json();
  const a = await create('2026-09-12');
  const b = await create('2026-09-13');
  const reel = [0, 1, 2].map((n) => ({
    seq: n,
    start: day('12', `${17 + n}:00`),
    durationSec: 3600,
    itemType: 'media',
    mediaId: ulid(),
  }));
  await app.inject({
    method: 'PUT',
    url: `/api/v1/schedules/${a.id}/items`,
    headers,
    payload: reel,
  });

  const body = {
    from: day('12', '17:00'),
    to: day('12', '19:00'),
    targetScheduleId: b.id,
    targetVersion: b.version,
    at: day('13', '06:00'),
    mode: 'overwrite',
  };
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/schedules/${a.id}/copy`,
    headers,
    payload: body,
  });
  assert.equal(res.statusCode, 200, res.body);
  const out = res.json();
  assert.deepEqual([out.copied, out.removed, out.schedule.version], [2, 0, b.version + 1]);
  assert.deepEqual(
    out.items.map((i: ScheduleItem) => i.start),
    [day('13', '06:00'), day('13', '07:00')],
  );

  // The same request again names a version the target has moved past.
  const stale = await app.inject({
    method: 'POST',
    url: `/api/v1/schedules/${a.id}/copy`,
    headers,
    payload: body,
  });
  assert.equal(stale.statusCode, 409);
  // What the copy wrote is the target's reel, read back.
  assert.equal((await store.items(b.id)).length, 2);
  await app.close();
});

test('POST /copy: the target must be this channel’s and writable; the source readable', async () => {
  const reader = await harness(['schedule:read']);
  const s = (
    await reader.app.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      headers: reader.headers,
      payload: { broadcastDate: '2026-09-12', timezone: 'UTC' },
    })
  ).statusCode;
  assert.equal(s, 403, 'a reader creates nothing');
  await reader.app.close();

  const { app, headers } = await harness();
  const a = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      headers,
      payload: { broadcastDate: '2026-09-12', timezone: 'UTC' },
    })
  ).json();
  const unknown = await app.inject({
    method: 'POST',
    url: `/api/v1/schedules/${a.id}/copy`,
    headers,
    payload: {
      targetScheduleId: ulid(),
      targetVersion: 1,
      at: day('13', '06:00'),
      mode: 'merge',
    },
  });
  assert.equal(unknown.statusCode, 404);
  const empty = await app.inject({
    method: 'POST',
    url: `/api/v1/schedules/${a.id}/copy`,
    headers,
    payload: {
      targetScheduleId: a.id,
      targetVersion: a.version,
      at: day('13', '06:00'),
      mode: 'merge',
    },
  });
  assert.equal(empty.statusCode, 422, 'an empty reel has nothing to copy');
  await app.close();
});
