// The schedule store conformance suite against node:sqlite. store-pg.test.ts runs the SAME suite
// against Postgres.

import { SqliteOutboxStore } from '@atlas/data';
import { scheduleStoreConformance } from '../src/store-conformance.ts';
import { sqliteScheduleStore } from '../src/store-sqlite.ts';

scheduleStoreConformance('sqliteScheduleStore', {
  make: async () => {
    const store = sqliteScheduleStore();
    return { store, outbox: new SqliteOutboxStore(store.db) };
  },
});
