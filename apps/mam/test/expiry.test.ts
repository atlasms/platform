// EP-24.5 — the expiry sweep (review plan WS-D1): an approved asset whose `expiresAt` has passed
// becomes `expired`, needing re-review, with `asset.expired` naming whose approval lapsed — once,
// whoever sweeps, in every channel, the longest-lapsed first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Envelope, EventPayloads } from '@atlas/contracts';
import { SqliteOutboxStore } from '@atlas/data';
import { InMemoryBroker, OutboxRelay } from '@atlas/messaging';
import { compile } from '@atlas/policy';
import { MamService, type Caller } from '../src/index.ts';
import { seededStore } from './categories.fixture.ts';

const T0 = Date.parse('2026-08-05T12:00:00.000Z');

function harness() {
  const store = seededStore();
  let clock = T0;
  const service = new MamService({ store, now: () => new Date(clock) });
  const broker = new InMemoryBroker();
  const relay = new OutboxRelay(new SqliteOutboxStore(store.db), broker);
  const caller = (userId = 'ana', channelId = 'ch12'): Caller => ({
    userId,
    channelId,
    policy: compile({
      subjectId: userId,
      permVersion: 1,
      rules: [
        {
          id: 'r',
          permissions: ['asset:read', 'asset:write', 'asset:approve'],
          scope: { channelIds: [channelId] },
        },
      ],
    }),
  });
  const approved = async (expiresAt: string | undefined, who = caller()) => {
    const a = await service.create(who, {
      title: 'Clip',
      mediaType: 'video',
      fileType: 'mxf',
      categoryId: who.channelId === 'ch12' ? 'cat-1' : `cat-1@${who.channelId}`,
    });
    await service.attachRenditions(who, a.id);
    await service.transition(who, a.id, 'startProcessing');
    await service.transition(who, a.id, 'markReady');
    return service.transition(who, a.id, 'approve', expiresAt !== undefined ? { expiresAt } : {});
  };
  const expiredEvents = async () => {
    await relay.drain();
    return broker.published
      .map((m) => m.body as Envelope)
      .filter((e) => e.type === 'asset.expired')
      .map((e) => e.payload as unknown as EventPayloads['asset.expired']);
  };
  return {
    service,
    caller,
    approved,
    expiredEvents,
    at: (ms: number) => {
      clock = T0 + ms;
    },
  };
}

test('a lapsed approval is swept to expired once — its event names whose approval lapsed', async () => {
  const h = harness();
  const soon = await h.approved('2026-08-05T12:00:30.000Z');
  const later = await h.approved('2026-08-05T13:00:00.000Z');
  const forever = await h.approved(undefined);
  assert.equal(soon.approvedBy, 'ana', 'the approver is recorded on the asset');

  assert.equal(await h.service.expireLapsed(), 0, 'nothing is due yet');
  h.at(60_000);
  assert.equal(await h.service.expireLapsed(), 1);
  assert.equal(await h.service.expireLapsed(), 0, 'a second sweep finds nothing — idempotent');

  const read = async (id: string) => (await h.service.get(h.caller(), id)).state;
  assert.deepEqual(
    [await read(soon.id), await read(later.id), await read(forever.id)],
    ['expired', 'approved', 'approved'],
  );
  assert.deepEqual(await h.expiredEvents(), [
    {
      assetId: soon.id,
      expiredAt: '2026-08-05T12:00:30.000Z',
      expirySource: 'asset',
      priorApprover: 'ana',
      // EP-25.5: who to tell of it, and what they must be able to read.
      createdBy: 'ana',
      categoryPath: '/cat-1/',
    },
  ]);
  // An expired asset may be approved again — the re-review (lifecycle: expired → approved).
  const again = await h.service.transition(h.caller('ben'), soon.id, 'approve', {
    expiresAt: '2027-01-01T00:00:00.000Z',
  });
  assert.deepEqual([again.state, again.approvedBy], ['approved', 'ben']);
});

test('the sweep crosses channels, the longest-lapsed first, a batch at a time; an offset is a time', async () => {
  const h = harness();
  const late = await h.approved('2026-08-05T12:00:40.000Z', h.caller('ana', 'ch12'));
  // 12:00:10Z written with an offset: earlier than `late` as a time, later as text.
  const early = await h.approved('2026-08-05T14:00:10+02:00', h.caller('cy', 'ch99'));
  h.at(60_000);
  assert.equal(await h.service.expireLapsed(1), 1, 'one batch of one');
  assert.deepEqual(
    (await h.expiredEvents()).map((e) => e.assetId),
    [early.id],
  );
  assert.equal(await h.service.expireLapsed(1), 1);
  assert.deepEqual(
    (await h.expiredEvents()).map((e) => e.assetId),
    [early.id, late.id],
  );
});
