// The schedule store conformance suite against a REAL Postgres — including the UNIQUE per channel
// and day, the cascade from a schedule to its items, and the range index the on-air read uses.
//
// CI runs this — the workflow declares a Postgres service and sets ATLAS_PG_URL. Locally it skips
// unless you point it at one:
//
//   ATLAS_PG_URL=postgres://atlas:atlas@localhost:55432/atlas npm test -w @atlas/scheduling

import test from 'node:test';
import { migrate, openPool, PgOutboxStore } from '@atlas/data-pg';
import { scheduleStoreConformance } from '../src/store-conformance.ts';
import { pgMigrations, pgScheduleStore } from '../src/store-pg.ts';

const URL = process.env['ATLAS_PG_URL'];

if (!URL) {
  if (process.env['CI']) {
    throw new Error(
      'ATLAS_PG_URL is unset in CI: the Postgres schedule-store conformance would skip, leaving the ' +
        'deployed adapter unexercised. Restore the postgres service in .github/workflows/ci.yml.',
    );
  }
  test(
    'Postgres schedule store conformance',
    { skip: 'set ATLAS_PG_URL to run against a real database' },
    () => {},
  );
} else {
  const connectionString = URL;
  let n = 0;
  scheduleStoreConformance('pgScheduleStore', {
    make: async () => {
      const schema = `sched_${Date.now().toString(36)}_${n++}`;
      const pool = openPool({ connectionString });
      await pool.query(`CREATE SCHEMA ${schema}`);
      pool.on('connect', (c) => void c.query(`SET search_path TO ${schema}`));
      await pool.query(`SET search_path TO ${schema}`);
      await migrate(pool, pgMigrations);
      return {
        store: pgScheduleStore(pool),
        outbox: new PgOutboxStore(pool),
        cleanup: async () => {
          await pool.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => undefined);
        },
      };
    },
  });
}
