// The MTS job store conformance suite against node:sqlite. store-pg.test.ts runs the SAME suite
// against Postgres.

import { SqliteOutboxStore } from '@atlas/data';
import { jobStoreConformance } from '../src/store-conformance.ts';
import { sqliteJobStore } from '../src/store-sqlite.ts';

jobStoreConformance('sqliteJobStore', {
  make: async () => {
    const store = sqliteJobStore();
    return { store, outbox: new SqliteOutboxStore(store.db) };
  },
});
