// Runs the shared outbox conformance suite against a REAL Postgres.
//
// CI runs this — the workflow declares a Postgres service and sets ATLAS_PG_URL. Locally it skips
// unless you point it at one:
//
//   docker compose -f infra/docker-compose.dev.yml up -d
//   ATLAS_PG_URL=postgres://atlas:atlas@localhost:55432/atlas npm test -w @atlas/data-pg

import test from 'node:test';
import assert from 'node:assert/strict';
import { outboxConformance } from '@atlas/data/conformance';
import {
  migrate,
  openPool,
  outboxMigration,
  PgOutboxStore,
  withTransaction,
  type PgClient,
} from '../src/index.ts';

const URL = process.env['ATLAS_PG_URL'];

if (!URL) {
  // Convenient locally, REFUSED in CI — see apps/mam/test/store-pg.test.ts for the reasoning. A
  // silent skip in CI is indistinguishable from a passing suite.
  if (process.env['CI']) {
    throw new Error(
      'ATLAS_PG_URL is unset in CI: the Postgres outbox conformance would skip, leaving the ' +
        'deployed adapter unexercised. Restore the postgres service in .github/workflows/ci.yml.',
    );
  }
  test(
    'Postgres conformance',
    { skip: 'set ATLAS_PG_URL to run against a real database' },
    () => {},
  );
} else {
  const connectionString = URL;
  let n = 0;

  outboxConformance('PgOutboxStore', {
    setup: async () => {
      // A schema per test: parallel-safe, and cleanup is one DROP rather than a pile of DELETEs
      // whose order has to respect foreign keys.
      const schema = `spec_${Date.now().toString(36)}_${n++}`;
      const pool = openPool({ connectionString });
      await pool.query(`CREATE SCHEMA ${schema}`);
      await pool.query(`SET search_path TO ${schema}`);
      // search_path is per-connection, so pin it for every connection this pool hands out.
      pool.on('connect', (c) => void c.query(`SET search_path TO ${schema}`));
      await pool.query(`SET search_path TO ${schema}`);

      await migrate(pool, [
        outboxMigration,
        { id: 'fixture_domain', up: 'CREATE TABLE assets (id text PRIMARY KEY)' },
      ]);

      const store = new PgOutboxStore(pool);
      let current: PgClient | undefined;

      return {
        store,
        transaction: async <T>(fn: () => Promise<T>): Promise<T> =>
          withTransaction(pool, async (client) => {
            current = client;
            try {
              return await fn();
            } finally {
              current = undefined;
            }
          }),
        insertDomainRow: async (id: string) => {
          const q = current ?? pool;
          await q.query('INSERT INTO assets (id) VALUES ($1)', [id]);
        },
        countDomainRows: async () => {
          const { rows } = await pool.query<{ c: string }>('SELECT count(*) c FROM assets');
          return Number(rows[0]?.c ?? 0);
        },
        enqueue: async (rec) => {
          if (!current) throw new Error('enqueue must run inside a transaction');
          await store.enqueue(current, rec);
        },
        cleanup: async () => {
          await pool.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => undefined);
          await pool.end();
        },
      };
    },
  });

  // --- Postgres-specific behaviour ---------------------------------------------

  test('migrations are idempotent and re-running applies only what is new', async () => {
    const schema = `mig_${Date.now().toString(36)}`;
    const pool = openPool({ connectionString });
    await pool.query(`CREATE SCHEMA ${schema}`);
    pool.on('connect', (c) => void c.query(`SET search_path TO ${schema}`));
    await pool.query(`SET search_path TO ${schema}`);

    const first = await migrate(pool, [outboxMigration]);
    assert.deepEqual(first.applied, ['core_outbox']);

    const second = await migrate(pool, [outboxMigration]);
    assert.deepEqual(second.applied, [], 're-running must be a no-op');

    const third = await migrate(pool, [
      outboxMigration,
      { id: 'add_thing', up: 'CREATE TABLE thing (id text PRIMARY KEY)' },
    ]);
    assert.deepEqual(third.applied, ['add_thing'], 'only the new migration runs');

    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  });

  test('a failing migration rolls back and does not record itself', async () => {
    const schema = `bad_${Date.now().toString(36)}`;
    const pool = openPool({ connectionString });
    await pool.query(`CREATE SCHEMA ${schema}`);
    pool.on('connect', (c) => void c.query(`SET search_path TO ${schema}`));
    await pool.query(`SET search_path TO ${schema}`);

    await assert.rejects(
      migrate(pool, [{ id: 'broken', up: 'CREATE TABLE ok (id text); THIS IS NOT SQL' }]),
      /migration "broken" failed/,
    );

    // Half-applied migrations are how a schema ends up in a state no migration can describe.
    const { rows } = await pool.query<{ c: string }>(
      `SELECT count(*) c FROM information_schema.tables WHERE table_schema = '${schema}' AND table_name = 'ok'`,
    );
    assert.equal(Number(rows[0]?.c), 0, 'the partial DDL must have rolled back');

    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  });

  test('SECURITY-ADJACENT: enqueue on a pooled connection is NOT in the caller transaction', async () => {
    // Proves why PgOutboxStore.enqueue demands a client. `add()` uses the pool, so it commits
    // independently — the failure mode this API shape exists to make unrepresentable.
    const schema = `leak_${Date.now().toString(36)}`;
    const pool = openPool({ connectionString });
    await pool.query(`CREATE SCHEMA ${schema}`);
    pool.on('connect', (c) => void c.query(`SET search_path TO ${schema}`));
    await pool.query(`SET search_path TO ${schema}`);
    await migrate(pool, [
      outboxMigration,
      { id: 'd', up: 'CREATE TABLE assets (id text PRIMARY KEY)' },
    ]);

    const store = new PgOutboxStore(pool);

    await assert.rejects(
      withTransaction(pool, async (client) => {
        await client.query('INSERT INTO assets (id) VALUES ($1)', ['a1']);
        await store.add({ id: 'evt-leak', message: { id: 'evt-leak', subject: 's', body: {} } });
        throw new Error('rollback');
      }),
      /rollback/,
    );

    const assets = await pool.query<{ c: string }>('SELECT count(*) c FROM assets');
    const events = await store.unsentCount();
    assert.equal(Number(assets.rows[0]?.c), 0, 'the domain row rolled back');
    assert.equal(events, 1, 'but add() survived — it was never in that transaction');

    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  });
}
