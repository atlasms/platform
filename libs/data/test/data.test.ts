import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb,
  withTransaction,
  migrate,
  jsonRepo,
  jsonTableMigration,
  SqliteOutboxStore,
  outboxMigration,
} from '../src/index.ts';
import { withTransactionAsync } from '../src/db.ts';
import { outboxConformance } from '../src/conformance.ts';
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
  migrate(db, [jsonTableMigration('asset'), outboxMigration]);
  return { db, assets: jsonRepo<AssetRow>(db, 'asset'), outbox: new SqliteOutboxStore(db) };
}

test('migrations apply once and are idempotent', () => {
  const db = openDb();
  const first = migrate(db, [jsonTableMigration('asset'), outboxMigration]);
  assert.deepEqual(first.applied, ['table_asset', 'core_outbox']);
  const second = migrate(db, [jsonTableMigration('asset'), outboxMigration]); // re-run
  assert.deepEqual(second.applied, []); // nothing new
  assert.equal((db.prepare('SELECT count(*) c FROM _migrations').get() as any).c, 2);
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
