// Postgres unit of work.
//
// The shapes mirror @atlas/data's sqlite versions deliberately — a migration runner, a
// transaction wrapper, an outbox store — so moving a service from the test double to the real
// store is a change of construction, not of logic.

import pg from 'pg';
import type { Migration } from '@atlas/data';

export type PgPool = pg.Pool;
export type PgClient = pg.PoolClient;

export interface PgOptions {
  /** e.g. `postgres://atlas:atlas@localhost:55432/atlas`. */
  connectionString: string;
  max?: number;
  /** Fail fast rather than hanging a request behind an exhausted pool. */
  connectionTimeoutMillis?: number;
  /**
   * The service's OWN Postgres schema (EP-07.6; 02-system-architecture.md: the engines are shared
   * infrastructure, the schemas are owned per service). Every connection this pool hands out has
   * its `search_path` pinned to it, and `migrate()` creates it if it is missing.
   *
   * Without it every service lands in `public` of the one shared database — which is where they
   * all were: four `outbox` tables that were ONE table, drained by four relays with no claim
   * locking, so a row MAM wrote was as likely to be published by IAM, twice, out of its subject's
   * order. Named ownership is what makes "no service reads another's tables" true rather than
   * intended.
   */
  schema?: string;
}

/** A schema name is an identifier we interpolate — so it is checked, not trusted. */
const SCHEMA_NAME = /^[a-z][a-z0-9_]{0,62}$/;

const schemas = new WeakMap<pg.Pool, string>();

export function openPool(options: PgOptions): PgPool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
  });
  if (options.schema !== undefined) {
    if (!SCHEMA_NAME.test(options.schema)) {
      throw new Error(`invalid schema name "${options.schema}": expected ${SCHEMA_NAME}`);
    }
    schemas.set(pool, options.schema);
    // search_path is per CONNECTION, so pin it on every one the pool opens — not only the first.
    // A query issued in the `connect` handler is queued ahead of the checkout's own, so the
    // caller never sees a connection whose path is not yet set.
    pool.on('connect', (client) => void client.query(`SET search_path TO "${options.schema}"`));
  }
  return pool;
}

/** The schema a pool was opened for, if any. */
export function schemaOf(pool: PgPool): string | undefined {
  return schemas.get(pool);
}

/**
 * Run `fn` in a transaction on ONE pooled connection: COMMIT on success, ROLLBACK on any throw.
 *
 * The client is passed in rather than taken from the pool inside `fn`, because that is the whole
 * hazard: a nested call that checks out its OWN connection is not in this transaction, so its
 * writes commit independently and the atomicity the outbox depends on quietly disappears.
 * Everything belonging to the unit of work must use the client given here.
 */
export async function withTransaction<T>(
  pool: PgPool,
  fn: (client: PgClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Ordered, once-applied migrations, each in its own transaction so a failure never half-applies.
 *
 * Takes an advisory lock first: several service replicas start at once during a rolling deploy,
 * and without it they race to apply the same migration. Postgres gives us a real distributed lock
 * for free, which sqlite never needed because it had one writer by construction.
 */
export async function migrate(
  pool: PgPool,
  migrations: Migration[],
): Promise<{ applied: string[] }> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    // Under the lock, on purpose: two replicas racing `CREATE SCHEMA IF NOT EXISTS` can both pass
    // the existence check and one of them then fails on the catalogue's unique index — a known
    // Postgres wrinkle that the lock this function already takes removes for free.
    const schema = schemaOf(pool);
    if (schema !== undefined) await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await client.query(
      'CREATE TABLE IF NOT EXISTS _migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL)',
    );
    const done = new Set(
      (await client.query<{ id: string }>('SELECT id FROM _migrations')).rows.map((r) => r.id),
    );

    for (const m of migrations) {
      if (done.has(m.id)) continue;
      try {
        await client.query('BEGIN');
        await client.query(m.up);
        await client.query('INSERT INTO _migrations (id, applied_at) VALUES ($1, now())', [m.id]);
        await client.query('COMMIT');
        applied.push(m.id);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        // `cause` keeps the driver's error — its SQLSTATE, the failing position, the stack. The
        // message alone says a migration failed; the cause says which constraint, on which column.
        throw new Error(`migration "${m.id}" failed: ${(e as Error).message}`, { cause: e });
      }
    }
    return { applied };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
  }
}

/** Arbitrary but fixed: every Atlas service must use the same key for the lock to mean anything. */
const MIGRATION_LOCK = 4711;
