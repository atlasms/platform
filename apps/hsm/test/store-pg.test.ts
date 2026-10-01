// The HSM store conformance suite against a REAL Postgres — including the partial UNIQUE on the
// live file, the compare-and-set lease, and the one default target per scope and tier.
//
// CI runs this — the workflow declares a Postgres service and sets ATLAS_PG_URL. Locally it skips
// unless you point it at one:
//
//   ATLAS_PG_URL=postgres://atlas:atlas@localhost:55432/atlas npm test -w @atlas/hsm

import test from 'node:test';
import { migrate, openPool, PgOutboxStore } from '@atlas/data-pg';
import { hsmStoreConformance } from '../src/store-conformance.ts';
import { pgMigrations, pgHsmStore } from '../src/store-pg.ts';

const URL = process.env['ATLAS_PG_URL'];

if (!URL) {
  if (process.env['CI']) {
    throw new Error(
      'ATLAS_PG_URL is unset in CI: the Postgres HSM-store conformance would skip, leaving the ' +
        'deployed adapter unexercised. Restore the postgres service in .github/workflows/ci.yml.',
    );
  }
  test(
    'Postgres HSM store conformance',
    { skip: 'set ATLAS_PG_URL to run against a real database' },
    () => {},
  );
} else {
  const connectionString = URL;
  let n = 0;
  hsmStoreConformance('pgHsmStore', {
    make: async () => {
      const schema = `hsm_${Date.now().toString(36)}_${n++}`;
      const pool = openPool({ connectionString });
      await pool.query(`CREATE SCHEMA ${schema}`);
      pool.on('connect', (c) => void c.query(`SET search_path TO ${schema}`));
      await pool.query(`SET search_path TO ${schema}`);
      await migrate(pool, pgMigrations);
      return {
        store: pgHsmStore(pool),
        outbox: new PgOutboxStore(pool),
        cleanup: async () => {
          await pool.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => undefined);
        },
      };
    },
  });
}
