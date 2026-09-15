// The RIM store conformance suite against node:sqlite. store-pg.test.ts runs the SAME suite
// against Postgres.

import { SqliteOutboxStore } from '@atlas/data';
import { rimStoreConformance } from '../src/store-conformance.ts';
import { sqliteRimStore } from '../src/store-sqlite.ts';

rimStoreConformance('sqliteRimStore', {
  make: async () => {
    const store = sqliteRimStore();
    return { store, outbox: new SqliteOutboxStore(store.db) };
  },
});
