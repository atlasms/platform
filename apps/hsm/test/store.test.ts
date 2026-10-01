// The HSM store conformance suite against node:sqlite, with real bytes in a temporary directory.
// store-pg.test.ts runs the SAME suite against Postgres.

import { SqliteOutboxStore } from '@atlas/data';
import { hsmStoreConformance } from '../src/store-conformance.ts';
import { sqliteHsmStore } from '../src/store-sqlite.ts';

hsmStoreConformance('sqliteHsmStore', {
  make: async () => {
    const store = sqliteHsmStore();
    return { store, outbox: new SqliteOutboxStore(store.db) };
  },
});
