// The Postgres adapter against a REAL database. CI runs this (ATLAS_PG_URL from the workflow's
// service); locally it skips unless you point it at one:
//
//   ATLAS_PG_URL=postgres://atlas:atlas@localhost:55432/atlas npx nx test @atlas/iam

import test from 'node:test';
import { migrate, openPool } from '@atlas/data-pg';
import { iamStoreConformance, pgIamStore, pgMigrations } from '../src/index.ts';

const URL = process.env['ATLAS_PG_URL'];

if (!URL) {
  // Convenient locally, REFUSED in CI: a silent skip is indistinguishable from a pass, and this is
  // the adapter that holds every credential in production.
  if (process.env['CI']) {
    throw new Error(
      'ATLAS_PG_URL is unset in CI: the IAM Postgres conformance would skip. Restore the postgres ' +
        'service in .github/workflows/ci.yml.',
    );
  }
  test('IAM Postgres conformance', { skip: 'set ATLAS_PG_URL to run' }, () => {});
} else {
  const connectionString = URL;
  let n = 0;
  iamStoreConformance('pgIamStore', {
    make: async () => {
      // A schema per test: parallel-safe, and cleanup is one DROP.
      const schema = `iam_${Date.now().toString(36)}_${n++}`;
      const pool = openPool({ connectionString });
      await pool.query(`CREATE SCHEMA ${schema}`);
      pool.on('connect', (c) => void c.query(`SET search_path TO ${schema}`));
      await pool.query(`SET search_path TO ${schema}`);
      await migrate(pool, pgMigrations);
      return {
        store: pgIamStore(pool),
        cleanup: async () => {
          await pool.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => undefined);
        },
      };
    },
    tamper: async (_store, eventId) => {
      // Around the port: a fresh pool in the same schema, and a raw UPDATE the trigger refuses.
      const pool = openPool({ connectionString });
      try {
        const { rows } = await pool.query<{ nspname: string }>(
          `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'iam_%' ORDER BY nspname DESC LIMIT 1`,
        );
        await pool.query(`SET search_path TO ${rows[0]?.nspname}`);
        await pool.query("UPDATE login_events SET result = 'success' WHERE id = $1", [eventId]);
      } finally {
        await pool.end();
      }
    },
  });
}
