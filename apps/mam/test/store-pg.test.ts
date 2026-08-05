// The SAME conformance suite, against a REAL Postgres.
//
// CI has no database, so this skips unless ATLAS_PG_URL is set:
//
//   docker compose -f infra/docker-compose.dev.yml up -d
//   ATLAS_PG_URL=postgres://atlas:atlas@localhost:55432/atlas npm test -w @atlas/mam

import test from 'node:test';
import { migrate, openPool } from '@atlas/data-pg';
import { assetStoreConformance } from '../src/store-conformance.ts';
import { mamMigrations, pgAssetStore } from '../src/index.ts';

const URL = process.env['ATLAS_PG_URL'];

if (!URL) {
  test(
    'Postgres AssetStore',
    { skip: 'set ATLAS_PG_URL to run against a real database' },
    () => {},
  );
} else {
  const connectionString = URL;
  let n = 0;

  assetStoreConformance('pgAssetStore', {
    setup: async () => {
      // A schema per fixture: the suite's cases run concurrently, and sharing one `assets` table
      // would make the tenant-isolation and rollback assertions depend on each other's rows.
      const schema = `mam_spec_${Date.now().toString(36)}_${n++}`;
      const pool = openPool({ connectionString });
      await pool.query(`CREATE SCHEMA ${schema}`);
      // search_path is per-connection, so pin it for every connection the pool hands out — not
      // just the one that happened to create the schema.
      pool.on('connect', (c) => void c.query(`SET search_path TO ${schema}`));
      await pool.query(`SET search_path TO ${schema}`);

      await migrate(pool, mamMigrations);

      return {
        store: pgAssetStore(pool),
        unsentCount: async () => {
          const { rows } = await pool.query<{ c: string }>(
            'SELECT count(*) c FROM outbox WHERE sent_at IS NULL',
          );
          return Number(rows[0]?.c ?? 0);
        },
        cleanup: async () => {
          await pool.query(`DROP SCHEMA ${schema} CASCADE`);
          await pool.end();
        },
      };
    },
  });
}
