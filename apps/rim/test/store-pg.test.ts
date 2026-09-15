// The RIM store conformance suite against a REAL Postgres — the cascade from an upload to its
// parts, the expiry index the sweeper reads, jsonb documents round-tripping.
//
// CI runs this — the workflow declares a Postgres service and sets ATLAS_PG_URL. Locally it skips
// unless you point it at one:
//
//   ATLAS_PG_URL=postgres://atlas:atlas@localhost:55432/atlas npm test -w @atlas/rim

import test from 'node:test';
import { migrate, openPool, PgOutboxStore } from '@atlas/data-pg';
import { rimStoreConformance } from '../src/store-conformance.ts';
import { pgMigrations, pgRimStore } from '../src/store-pg.ts';

const URL = process.env['ATLAS_PG_URL'];

if (!URL) {
  if (process.env['CI']) {
    throw new Error(
      'ATLAS_PG_URL is unset in CI: the Postgres RIM store conformance would skip, leaving the ' +
        'deployed adapter unexercised. Restore the postgres service in .github/workflows/ci.yml.',
    );
  }
  test(
    'Postgres RIM store conformance',
    { skip: 'set ATLAS_PG_URL to run against a real database' },
    () => {},
  );
} else {
  const connectionString = URL;
  let n = 0;
  rimStoreConformance('pgRimStore', {
    make: async () => {
      // A schema per fixture, the way production isolates services (EP-07.6) — created by migrate().
      const pool = openPool({
        connectionString,
        schema: `rim_spec_${Date.now().toString(36)}_${n++}`,
      });
      await migrate(pool, pgMigrations);
      return {
        store: pgRimStore(pool),
        outbox: new PgOutboxStore(pool),
        cleanup: async () => {
          const { rows } = await pool.query<{ s: string }>('SELECT current_schema() AS s');
          await pool.query(`DROP SCHEMA IF EXISTS "${rows[0]!.s}" CASCADE`).catch(() => undefined);
        },
      };
    },
  });
}
