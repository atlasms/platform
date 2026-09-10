import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb,
  withTransaction,
  migrate,
  jsonRepo,
  jsonTableMigration,
  SqliteOutboxStore,
  outboxHeadersMigration,
  outboxMigration,
  SqliteSeenStore,
  seenMigration,
} from '../src/index.ts';
import { withTransactionAsync } from '../src/db.ts';
import { outboxConformance } from '../src/conformance.ts';
import { seenStoreConformance } from '@atlas/messaging/conformance';
import { InMemoryBroker, OutboxRelay, type OutboxRecord } from '@atlas/messaging';

interface AssetRow {
  id: string;
  state: string;
}
const rec = (id: string, type: string): OutboxRecord => ({
  id,
  message: { id, subject: `atlas.ch12.${type}`, body: { type } },
});

function setup() {
  const db = openDb();
  migrate(db, [jsonTableMigration('asset'), outboxMigration, outboxHeadersMigration]);
  return { db, assets: jsonRepo<AssetRow>(db, 'asset'), outbox: new SqliteOutboxStore(db) };
}

test('migrations apply once and are idempotent', () => {
  const db = openDb();
  const first = migrate(db, [jsonTableMigration('asset'), outboxMigration, outboxHeadersMigration]);
  assert.deepEqual(first.applied, ['table_asset', 'core_outbox', 'core_outbox_headers']);
  const second = migrate(db, [
    jsonTableMigration('asset'),
    outboxMigration,
    outboxHeadersMigration,
  ]); // re-run
  assert.deepEqual(second.applied, []); // nothing new
  assert.equal((db.prepare('SELECT count(*) c FROM _migrations').get() as any).c, 3);
});

test('a bad migration fails without half-applying', () => {
  const db = openDb();
  assert.throws(
    () => migrate(db, [{ id: 'x', up: 'CREATE TABLE oops (' }]),
    /migration "x" failed/,
  );
  assert.equal((db.prepare('SELECT count(*) c FROM _migrations').get() as any).c, 0); // not recorded
});

test('jsonRepo put/get/all/delete round-trips', () => {
  const { assets } = setup();
  assets.put({ id: 'A', state: 'ready' });
  assert.equal(assets.get('A')!.state, 'ready');
  assets.put({ id: 'A', state: 'approved' }); // upsert
  assert.equal(assets.get('A')!.state, 'approved');
  assert.equal(assets.all().length, 1);
  assets.delete('A');
  assert.equal(assets.get('A'), undefined);
});

test('transactional outbox commits atomically on success', () => {
  const s = setup();
  withTransaction(s.db, () => {
    s.assets.put({ id: 'B', state: 'created' });
    s.outbox.enqueue(rec('m1', 'asset.created'));
  });
  assert.equal(s.assets.get('B')!.state, 'created');
  assert.equal(s.outbox.unsentCount(), 1); // both persisted
});

test('transactional outbox ROLLS BACK both writes on failure (atomicity)', () => {
  const s = setup();
  s.assets.put({ id: 'seed', state: 'x' });
  assert.throws(
    () =>
      withTransaction(s.db, () => {
        s.assets.put({ id: 'C', state: 'created' }); // written...
        s.outbox.enqueue(rec('m2', 'asset.created')); // ...and its event...
        throw new Error('boom after the writes'); // ...then the tx fails
      }),
    /boom/,
  );
  assert.equal(s.assets.get('C'), undefined); // neither the asset...
  assert.equal(s.outbox.unsentCount(), 0); // ...nor the event survived
  assert.equal(s.assets.get('seed')!.state, 'x'); // prior committed data intact
});

test('SqliteOutboxStore drains through the messaging OutboxRelay', async () => {
  const s = setup();
  withTransaction(s.db, () => {
    s.assets.put({ id: 'D', state: 'created' });
    s.outbox.enqueue(rec('evt1', 'asset.created'));
  });
  const broker = new InMemoryBroker();
  const captured: unknown[] = [];
  broker.subscribe('atlas.ch12.>', (m) => {
    captured.push(m.body);
  });
  const relay = new OutboxRelay(s.outbox, broker);
  assert.equal(await relay.drain(), 1); // relayed the one unsent event
  assert.equal(captured.length, 1);
  assert.equal(s.outbox.unsentCount(), 0); // marked sent
  assert.equal(await relay.drain(), 0); // idempotent re-run
});

// --- shared conformance ------------------------------------------------------
// The same suite @atlas/data-pg must pass. Holding the sqlite store to the production store's
// rules is what makes it a legitimate stand-in rather than a convenient fiction.
outboxConformance('SqliteOutboxStore', {
  setup: async () => {
    const db = openDb(':memory:');
    migrate(db, [
      outboxMigration,
      outboxHeadersMigration,
      { id: 'fixture', up: 'CREATE TABLE assets (id TEXT PRIMARY KEY)' },
    ]);
    const store = new SqliteOutboxStore(db);
    return {
      store,
      transaction: <T>(fn: () => Promise<T>): Promise<T> => withTransactionAsync(db, fn),
      insertDomainRow: async (id: string) => {
        db.prepare('INSERT INTO assets (id) VALUES (?)').run(id);
      },
      countDomainRows: async () =>
        (db.prepare('SELECT count(*) c FROM assets').get() as { c: number }).c,
      enqueue: async (rec) => store.enqueue(rec),
      cleanup: async () => db.close(),
    };
  },
});

// --- consumer dedup ----------------------------------------------------------
// The same suite the in-memory and Postgres stores pass (@atlas/messaging/conformance).

seenStoreConformance('SqliteSeenStore', {
  make: async () => {
    const db = openDb(':memory:');
    migrate(db, [seenMigration]);
    return { store: new SqliteSeenStore(db) };
  },
});

test('SEEN: the mark and the domain write commit — or roll back — TOGETHER', async () => {
  // The crash window `idempotent()` cannot close on its own, closed. Claiming on a separate
  // connection and then dying mid-handler leaves the id marked with the effect never applied, so
  // every redelivery is suppressed and the message is lost. Sharing the transaction makes the two
  // outcomes the only two: both happened, or neither did.
  const db = openDb(':memory:');
  migrate(db, [seenMigration, { id: 'fixture', up: 'CREATE TABLE assets (id TEXT PRIMARY KEY)' }]);
  const seen = new SqliteSeenStore(db);

  assert.throws(
    () =>
      withTransaction(db, (tx) => {
        assert.equal(seen.mark(tx, 'evt-1'), true, 'claimed inside the unit of work');
        tx.prepare('INSERT INTO assets (id) VALUES (?)').run('a1');
        throw new Error('handler failed after both writes');
      }),
    /handler failed/,
  );

  const assets = db.prepare('SELECT count(*) c FROM assets').get() as { c: number };
  assert.equal(assets.c, 0, 'the effect rolled back');
  assert.equal(seen.count(), 0, 'and the mark rolled back with it');
  assert.equal(await seen.markSeen('evt-1'), true, 'so redelivery is processed, not skipped');
});

test('SEEN: prune drops marks older than the cutoff and keeps the rest', async () => {
  // Retention is a real decision: the window must outlive the longest redelivery the broker can
  // produce, because a mark pruned while its message can still arrive lets the duplicate through.
  const db = openDb(':memory:');
  migrate(db, [seenMigration]);
  const seen = new SqliteSeenStore(db);

  // Backdated directly — the column defaults to now(), and what is under test is the boundary.
  db.prepare('INSERT INTO seen (id, seen_at) VALUES (?, ?)').run('old', '2020-01-01 00:00:00');
  db.prepare('INSERT INTO seen (id, seen_at) VALUES (?, ?)').run('recent', '2999-01-01 00:00:00');

  assert.equal(seen.prune(new Date('2021-01-01T00:00:00Z')), 1, 'only the old mark goes');
  assert.equal(seen.count(), 1);
  assert.equal(await seen.markSeen('recent'), false, 'the retained mark still dedupes');
  assert.equal(await seen.markSeen('old'), true, 'the pruned one no longer does');
});
