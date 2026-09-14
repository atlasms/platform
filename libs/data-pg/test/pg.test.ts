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
import { seenStoreConformance } from '@atlas/messaging/conformance';
import {
  migrate,
  openPool,
  outboxHeadersMigration,
  outboxMigration,
  PgOutboxStore,
  PgSeenStore,
  schemaOf,
  seenMigration,
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
        outboxHeadersMigration,
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

  // --- consumer dedup ----------------------------------------------------------
  // The SAME suite the in-memory and sqlite stores pass. Here it runs across real connections,
  // which is the only place the atomicity case is more than a formality.

  seenStoreConformance('PgSeenStore', {
    make: async () => {
      const schema = `seen_${Date.now().toString(36)}_${n++}`;
      const pool = openPool({ connectionString });
      await pool.query(`CREATE SCHEMA ${schema}`);
      // Queued on each new connection BEFORE the pool hands it out, so every client in the pool
      // is pinned to this schema — which matters here because the atomicity case deliberately
      // uses several connections at once.
      pool.on('connect', (c) => void c.query(`SET search_path TO ${schema}`));
      await pool.query(`SET search_path TO ${schema}`);
      await migrate(pool, [seenMigration]);

      return {
        store: new PgSeenStore(pool),
        cleanup: async () => {
          await pool.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => undefined);
          await pool.end();
        },
      };
    },
  });

  test('OWNERSHIP: a pool opened for a schema migrates and writes there, and there only', async () => {
    // EP-07.6. Every service shares one database, so ownership is the schema: two services with
    // the same migrations get two `outbox` tables, and one's relay cannot see the other's rows.
    // Before this, all four services created ONE `outbox` in `public` and four relays drained it.
    const stamp = Date.now().toString(36);
    const a = openPool({ connectionString, schema: `own_a_${stamp}` });
    const b = openPool({ connectionString, schema: `own_b_${stamp}` });
    try {
      // The schema does not exist yet; migrate() creates it (under the migration lock).
      await migrate(a, [outboxMigration, outboxHeadersMigration]);
      await migrate(b, [outboxMigration, outboxHeadersMigration]);

      const outboxA = new PgOutboxStore(a);
      const outboxB = new PgOutboxStore(b);
      await withTransaction(a, (client) =>
        outboxA.enqueue(client, {
          id: 'm-a',
          message: { id: 'm-a', subject: 'atlas.ch12.asset.created', body: { from: 'a' } },
        }),
      );
      assert.equal((await outboxA.listUnsent(10)).length, 1);
      assert.equal((await outboxB.listUnsent(10)).length, 0, "b's relay cannot see a's row");

      // Every connection the pool hands out is on the schema, not only the first.
      const paths = await Promise.all(
        Array.from({ length: 4 }, () =>
          a.query<{ search_path: string }>('SHOW search_path').then((r) => r.rows[0]!.search_path),
        ),
      );
      assert.ok(
        paths.every((p) => p.includes(`own_a_${stamp}`)),
        paths.join(', '),
      );
      assert.equal(schemaOf(a), `own_a_${stamp}`);
      assert.throws(() => openPool({ connectionString, schema: 'public; DROP SCHEMA x' }));
    } finally {
      await a.query(`DROP SCHEMA IF EXISTS own_a_${stamp} CASCADE`).catch(() => undefined);
      await b.query(`DROP SCHEMA IF EXISTS own_b_${stamp} CASCADE`).catch(() => undefined);
      await a.end();
      await b.end();
    }
  });

  test('SEEN: a competing transaction BLOCKS on the row lock, then loses', async () => {
    // What makes `INSERT ... ON CONFLICT DO NOTHING` an atomic claim rather than a hopeful one:
    // the second transaction does not read a stale "not seen" and proceed. It waits for the first
    // to settle and is then told, correctly, that the id is taken. The ordering is decided by the
    // database, not by which caller happened to be scheduled first.
    const schema = `lock_${Date.now().toString(36)}`;
    const pool = openPool({ connectionString });
    await pool.query(`CREATE SCHEMA ${schema}`);
    pool.on('connect', (c) => void c.query(`SET search_path TO ${schema}`));
    await pool.query(`SET search_path TO ${schema}`);
    await migrate(pool, [seenMigration]);
    const store = new PgSeenStore(pool);

    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');

      assert.equal(await store.mark(a, 'evt-contended'), true, 'the first claim succeeds');

      // B must not resolve while A holds the row.
      const pending = store.mark(b, 'evt-contended');
      const settledEarly = await Promise.race([
        pending.then(() => 'resolved'),
        new Promise((r) => setTimeout(() => r('still-blocked'), 300)),
      ]);
      assert.equal(settledEarly, 'still-blocked', 'the competing claim must wait, not guess');

      await a.query('COMMIT');
      assert.equal(await pending, false, 'and once it can see the winner, it must lose');
      await b.query('COMMIT');
    } finally {
      a.release();
      b.release();
      await pool.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => undefined);
      await pool.end();
    }
  });

  test('SEEN: the mark and the domain write commit — or roll back — TOGETHER', async () => {
    // The crash window closed. A claim that commits on its own connection survives a handler that
    // never finished, and every redelivery is then suppressed for an effect that never happened.
    const schema = `seentx_${Date.now().toString(36)}`;
    const pool = openPool({ connectionString });
    await pool.query(`CREATE SCHEMA ${schema}`);
    pool.on('connect', (c) => void c.query(`SET search_path TO ${schema}`));
    await pool.query(`SET search_path TO ${schema}`);
    await migrate(pool, [
      seenMigration,
      { id: 'fixture_domain', up: 'CREATE TABLE assets (id text PRIMARY KEY)' },
    ]);
    const store = new PgSeenStore(pool);

    await assert.rejects(
      withTransaction(pool, async (client) => {
        assert.equal(await store.mark(client, 'evt-1'), true);
        await client.query('INSERT INTO assets (id) VALUES ($1)', ['a1']);
        throw new Error('handler failed after both writes');
      }),
      /handler failed/,
    );

    const assets = await pool.query<{ c: string }>('SELECT count(*) c FROM assets');
    assert.equal(Number(assets.rows[0]?.c), 0, 'the effect rolled back');
    assert.equal(await store.count(), 0, 'and the mark rolled back with it');
    assert.equal(await store.markSeen('evt-1'), true, 'so redelivery is processed, not skipped');

    await pool.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => undefined);
    await pool.end();
  });

  test('SEEN: prune drops marks older than the cutoff and keeps the rest', async () => {
    const schema = `prune_${Date.now().toString(36)}`;
    const pool = openPool({ connectionString });
    await pool.query(`CREATE SCHEMA ${schema}`);
    pool.on('connect', (c) => void c.query(`SET search_path TO ${schema}`));
    await pool.query(`SET search_path TO ${schema}`);
    await migrate(pool, [seenMigration]);
    const store = new PgSeenStore(pool);

    await pool.query("INSERT INTO seen (id, seen_at) VALUES ('old', '2020-01-01Z')");
    await pool.query("INSERT INTO seen (id, seen_at) VALUES ('recent', '2999-01-01Z')");

    assert.equal(await store.prune(new Date('2021-01-01T00:00:00Z')), 1, 'only the old mark goes');
    assert.equal(await store.count(), 1);
    assert.equal(await store.markSeen('recent'), false, 'the retained mark still dedupes');
    assert.equal(await store.markSeen('old'), true, 'the pruned one no longer does');

    await pool.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => undefined);
    await pool.end();
  });

  // --- Postgres-specific behaviour ---------------------------------------------

  test('migrations are idempotent and re-running applies only what is new', async () => {
    const schema = `mig_${Date.now().toString(36)}`;
    const pool = openPool({ connectionString });
    await pool.query(`CREATE SCHEMA ${schema}`);
    pool.on('connect', (c) => void c.query(`SET search_path TO ${schema}`));
    await pool.query(`SET search_path TO ${schema}`);

    const first = await migrate(pool, [outboxMigration, outboxHeadersMigration]);
    assert.deepEqual(first.applied, ['core_outbox', 'core_outbox_headers']);

    const second = await migrate(pool, [outboxMigration, outboxHeadersMigration]);
    assert.deepEqual(second.applied, [], 're-running must be a no-op');

    const third = await migrate(pool, [
      outboxMigration,
      outboxHeadersMigration,
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
      outboxHeadersMigration,
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
