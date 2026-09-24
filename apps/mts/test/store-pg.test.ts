// The MTS job store conformance suite against a REAL Postgres — the lease's compare-and-set, the
// backoff read on `timestamptz`, jsonb documents round-tripping.
//
// CI runs this — the workflow declares a Postgres service and sets ATLAS_PG_URL. Locally it skips
// unless you point it at one:
//
//   ATLAS_PG_URL=postgres://atlas:atlas@localhost:55432/atlas npm test -w @atlas/mts

import test from 'node:test';
import { migrate, openPool, PgOutboxStore } from '@atlas/data-pg';
import { jobStoreConformance } from '../src/store-conformance.ts';
import { pgJobStore, pgMigrations } from '../src/store-pg.ts';

const URL = process.env['ATLAS_PG_URL'];

if (!URL) {
  if (process.env['CI']) {
    throw new Error(
      'ATLAS_PG_URL is unset in CI: the Postgres MTS store conformance would skip, leaving the ' +
        'deployed adapter unexercised. Restore the postgres service in .github/workflows/ci.yml.',
    );
  }
  test(
    'Postgres MTS store conformance',
    { skip: 'set ATLAS_PG_URL to run against a real database' },
    () => {},
  );
} else {
  const connectionString = URL;
  let n = 0;
  jobStoreConformance('pgJobStore', {
    make: async () => {
      // A schema per fixture, the way production isolates services (EP-07.6).
      const pool = openPool({
        connectionString,
        schema: `mts_spec_${Date.now().toString(36)}_${n++}`,
      });
      await migrate(pool, pgMigrations);
      return {
        store: pgJobStore(pool),
        outbox: new PgOutboxStore(pool),
        cleanup: async () => {
          const { rows } = await pool.query<{ s: string }>('SELECT current_schema() AS s');
          await pool.query(`DROP SCHEMA IF EXISTS "${rows[0]!.s}" CASCADE`).catch(() => undefined);
        },
      };
    },
  });
}
