// The SAME conformance suite, against a REAL Postgres.
//
// CI has no database, so this skips unless ATLAS_PG_URL is set:
//
//   docker compose -f infra/docker-compose.dev.yml up -d
//   ATLAS_PG_URL=postgres://atlas:atlas@localhost:55432/atlas npm test -w @atlas/mam

import test from 'node:test';
import assert from 'node:assert/strict';
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

  // Postgres ONLY, and deliberately outside the shared suite.
  //
  // The claim `setTags` rests on is that minting a tag is safe when two editors type the same
  // keyword at the same instant. That is a property of concurrent CONNECTIONS, and the sqlite
  // adapter has one writer by construction — running this there would assert nothing and would
  // read as though the guarantee had been checked on both.
  test('CONCURRENCY: two transactions minting the same label agree on one tag', async () => {
    const schema = `mam_race_${Date.now().toString(36)}`;
    const pool = openPool({ connectionString, max: 4 });
    await pool.query(`CREATE SCHEMA ${schema}`);
    pool.on('connect', (c) => void c.query(`SET search_path TO ${schema}`));
    await pool.query(`SET search_path TO ${schema}`);
    await migrate(pool, mamMigrations);
    const store = pgAssetStore(pool);

    try {
      // Two DIFFERENT assets, so nothing but the tag itself is contended.
      const now = '2026-01-01T00:00:00.000Z';
      const base = {
        channelId: 'ch12',
        title: 'Clip',
        mediaType: 'video',
        fileType: 'mxf',
        state: 'created' as const,
        version: 1,
        hasRenditions: false,
        createdBy: 'u',
        createdAt: now,
        updatedAt: now,
      };
      await store.transaction(async (tx) => {
        await tx.put({ ...base, id: 'RACE-A' });
        await tx.put({ ...base, id: 'RACE-B' });
      });

      // Started together and awaited together: one of these blocks on the other's uncommitted
      // insert, which is exactly the interleaving that a read-then-insert in the service would
      // lose. Each offers its OWN candidate id for the same normalized label.
      const [a, b] = await Promise.all([
        store.transaction(async (tx) =>
          tx.setTags('RACE-A', 'ch12', [
            { id: 'CAND-A', label: 'Football', normalized: 'football' },
          ]),
        ),
        store.transaction(async (tx) =>
          tx.setTags('RACE-B', 'ch12', [
            { id: 'CAND-B', label: 'football', normalized: 'football' },
          ]),
        ),
      ]);

      assert.equal(a[0]?.id, b[0]?.id, 'both assets must end up carrying the SAME tag');
      assert.equal(
        (await store.listTags('ch12')).length,
        1,
        'the unique index must have collapsed the race into one row, not rejected the loser',
      );
      // Whichever transaction committed first defined the display label, and the other adopted it.
      assert.equal(a[0]?.label, b[0]?.label);
    } finally {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    }
  });
}
