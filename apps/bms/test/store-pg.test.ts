// The workflow store conformance suite against a REAL Postgres — the partial unique index that
// keeps one draft per workflow, and the upsert that never rewrites a published version.
//
// CI runs this — the workflow declares a Postgres service and sets ATLAS_PG_URL. Locally it skips
// unless you point it at one:
//
//   ATLAS_PG_URL=postgres://atlas:atlas@localhost:55432/atlas npm test -w @atlas/bms

import test from 'node:test';
import { migrate, openPool, PgOutboxStore } from '@atlas/data-pg';
import { workflowStoreConformance } from '../src/store-conformance.ts';
import { pgMigrations, pgWorkflowStore } from '../src/store-pg.ts';

const URL = process.env['ATLAS_PG_URL'];

if (!URL) {
  if (process.env['CI']) {
    throw new Error(
      'ATLAS_PG_URL is unset in CI: the Postgres workflow-store conformance would skip, leaving the ' +
        'deployed adapter unexercised. Restore the postgres service in .github/workflows/ci.yml.',
    );
  }
  test(
    'Postgres workflow store conformance',
    { skip: 'set ATLAS_PG_URL to run against a real database' },
    () => {},
  );
} else {
  const connectionString = URL;
  let n = 0;
  workflowStoreConformance('pgWorkflowStore', {
    make: async () => {
      const schema = `bms_${Date.now().toString(36)}_${n++}`;
      const pool = openPool({ connectionString });
      await pool.query(`CREATE SCHEMA ${schema}`);
      pool.on('connect', (c) => void c.query(`SET search_path TO ${schema}`));
      await pool.query(`SET search_path TO ${schema}`);
      await migrate(pool, pgMigrations);
      return {
        store: pgWorkflowStore(pool),
        outbox: new PgOutboxStore(pool),
        cleanup: async () => {
          await pool.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => undefined);
          await pool.end();
        },
      };
    },
  });
}
