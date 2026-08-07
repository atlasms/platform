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
}

export function openPool(options: PgOptions): PgPool {
  return new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
  });
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
