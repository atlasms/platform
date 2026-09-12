// The audit store conformance suite against a REAL Postgres — including the append-only trigger,
// which only a real database can prove.
//
// CI runs this — the workflow declares a Postgres service and sets ATLAS_PG_URL. Locally it skips
// unless you point it at one:
//
//   docker compose -f infra/docker-compose.dev.yml up -d
//   ATLAS_PG_URL=postgres://atlas:atlas@localhost:55432/atlas npm test -w @atlas/logging

import test from 'node:test';
import { migrate, openPool } from '@atlas/data-pg';
import { auditStoreConformance } from '../src/store-conformance.ts';
import { pgAuditStore, pgMigrations } from '../src/store-pg.ts';

const URL = process.env['ATLAS_PG_URL'];

if (!URL) {
  // Convenient locally, REFUSED in CI: a silent skip there is indistinguishable from a passing suite.
  if (process.env['CI']) {
    throw new Error(
      'ATLAS_PG_URL is unset in CI: the Postgres audit-store conformance would skip, leaving the ' +
        'deployed adapter unexercised. Restore the postgres service in .github/workflows/ci.yml.',
    );
  }
  test(
    'Postgres audit store conformance',
    { skip: 'set ATLAS_PG_URL to run against a real database' },
    () => {},
  );
} else {
  const connectionString = URL;
  let n = 0;

  auditStoreConformance('pgAuditStore', {
    make: async () => {
      // A schema per test: parallel-safe, and cleanup is one DROP.
      const schema = `audit_${Date.now().toString(36)}_${n++}`;
      const pool = openPool({ connectionString });
      await pool.query(`CREATE SCHEMA ${schema}`);
      pool.on('connect', (c) => void c.query(`SET search_path TO ${schema}`));
      await pool.query(`SET search_path TO ${schema}`);
      await migrate(pool, pgMigrations);
      const store = pgAuditStore(pool);
      return {
        store,
        cleanup: async () => {
          await pool.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => undefined);
        },
      };
    },
    tamper: async (store, messageId) => {
      // Reach around the port: the adapter's pool is private, so open another connection to the
      // same schema the store is on. The trigger, not the code, is what must refuse this.
      const pool = openPool({ connectionString });
      try {
        const { rows } = await pool.query<{ nspname: string }>(
          `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'audit_%' ORDER BY nspname DESC LIMIT 1`,
        );
        const schema = rows[0]?.nspname;
        await pool.query(`SET search_path TO ${schema}`);
        await pool.query("UPDATE audit_events SET type = 'forged' WHERE message_id = $1", [
          messageId,
        ]);
      } finally {
        await pool.end();
      }
      void store;
    },
  });
}
