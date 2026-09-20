// Retention (EP-19.4): the tick trims each channel's hot index to its policy's window and never
// its head; legal hold pauses it; the defaults apply until a policy is set; and the tiered
// browse reads past the hot window from the record without a row seen twice.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope, ulid } from '@atlas/contracts';
import {
  effectivePolicy,
  hotCutoff,
  ingest,
  memoryAuditIndex,
  parseRetentionPolicyInput,
  retentionTick,
  sqliteAuditStore,
  startProjector,
  tieredBrowser,
  type AuditStore,
} from '../src/index.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-21T12:00:00.000Z');

/** One record, `daysAgo` days old, appended the way the sink would. */
async function record(store: AuditStore, daysAgo: number, channelId = 'ch12'): Promise<void> {
  const envelope = {
    ...buildEnvelope({
      type: 'asset.created',
      channelId,
      payload: { assetId: ulid() },
      actor: { kind: 'user', id: 'u1' },
    }),
    occurredAt: new Date(NOW - daysAgo * DAY).toISOString(),
  };
  await ingest(store, { id: envelope.messageId, subject: 'atlas.x', body: envelope });
}

async function fixture() {
  const store = sqliteAuditStore();
  const { index, docs } = memoryAuditIndex();
  const projector = startProjector({ store, index, intervalMs: 10 ** 9 });
  const defaults = { hotDays: 30, coldDays: 0 };
  const tick = () => retentionTick({ store, index, defaults, now: () => new Date(NOW) });
  return { store, index, docs, projector, defaults, tick };
}

test('the tick trims documents older than the hot window, keeps the head whatever its age, and reports per channel', async () => {
  const f = await fixture();
  // ch12: 100, 60, 10 and 1 days old; ch99: one record, 400 days old — its head.
  for (const days of [100, 60, 10, 1]) await record(f.store, days);
  await record(f.store, 400, 'ch99');
  await f.projector.tick();
  assert.equal(f.docs.size, 5);

  const reports = await f.tick();
  assert.deepEqual(reports, [
    { channelId: 'ch12', trimmed: 2 },
    { channelId: 'ch99', trimmed: 0 },
  ]);
  const left = [...f.docs.values()].map((e) => [e.channelId, e.seq]).sort();
  assert.deepEqual(left, [
    ['ch12', 3],
    ['ch12', 4],
    ['ch99', 1],
  ]);
  // The heads the projector reads are intact, so the next tick indexes only what is new.
  await record(f.store, 0);
  assert.equal(await f.projector.tick(), 1);
  assert.deepEqual(await f.tick(), [
    { channelId: 'ch12', trimmed: 0 },
    { channelId: 'ch99', trimmed: 0 },
  ]);
  f.projector.stop();
});

test('a channel policy narrows the window; legal hold pauses the trim for that channel only', async () => {
  const f = await fixture();
  for (const days of [20, 5]) await record(f.store, days);
  for (const days of [20, 5]) await record(f.store, days, 'ch99');
  await f.projector.tick();

  await f.store.transaction((tx) =>
    tx.putRetentionPolicy({
      channelId: 'ch12',
      hotDays: 7,
      coldDays: 0,
      legalHold: false,
      version: 1,
      updatedAt: '',
      updatedBy: 'u1',
    }),
  );
  await f.store.transaction((tx) =>
    tx.putRetentionPolicy({
      channelId: 'ch99',
      hotDays: 1,
      coldDays: 0,
      legalHold: true,
      version: 1,
      updatedAt: '',
      updatedBy: 'u1',
    }),
  );
  assert.deepEqual(await f.tick(), [
    { channelId: 'ch12', trimmed: 1 },
    { channelId: 'ch99', trimmed: undefined },
  ]);
  assert.equal([...f.docs.values()].filter((e) => e.channelId === 'ch99').length, 2, 'held');
  f.projector.stop();
});

test('the tiered browse: the index answers what it has, the record the rest — older than the last hot row, never twice', async () => {
  const f = await fixture();
  for (const days of [100, 60, 10, 1]) await record(f.store, days);
  await f.projector.tick();
  await f.tick(); // the index now holds seq 3 and 4 only
  const browser = tieredBrowser(f.index, f.store);

  const all = await browser.browse('ch12', { limit: 10 });
  assert.deepEqual(
    all.map((e) => e.seq),
    [4, 3, 2, 1],
    'hot first, then the record, no overlap',
  );
  const page = await browser.browse('ch12', { limit: 3 });
  assert.deepEqual(
    page.map((e) => e.seq),
    [4, 3, 2],
  );
  const next = await browser.browse('ch12', { limit: 3, before: 2 });
  assert.deepEqual(
    next.map((e) => e.seq),
    [1],
    'a keyset page entirely in the cold tier',
  );
  // A filter the index answers in full never reaches the record: a type nothing matches is
  // empty from the index, and empty from the record too.
  assert.deepEqual(await browser.browse('ch12', { limit: 3, types: ['asset.deleted'] }), []);
  f.projector.stop();
});

test('the effective policy is the stored one or the defaults, and the parser refuses what is not a policy', () => {
  const defaults = { hotDays: 90, coldDays: 0 };
  const eff = effectivePolicy('ch12', undefined, defaults);
  assert.deepEqual([eff.hotDays, eff.coldDays, eff.legalHold, eff.version], [90, 0, false, 0]);
  assert.equal(hotCutoff({ hotDays: 1 }, new Date(NOW)), '2026-09-20T12:00:00.000Z');
  assert.deepEqual(parseRetentionPolicyInput({ hotDays: 7, coldDays: 365 }), {
    hotDays: 7,
    coldDays: 365,
    legalHold: false,
  });
  for (const bad of [
    null,
    { hotDays: 0, coldDays: 0 },
    { hotDays: 1.5, coldDays: 0 },
    { hotDays: 7, coldDays: -1 },
    { hotDays: 7, coldDays: 0, legalHold: 'yes' },
    { hotDays: 99_999, coldDays: 0 },
  ]) {
    assert.throws(() => parseRetentionPolicyInput(bad), /must be/, JSON.stringify(bad));
  }
});
