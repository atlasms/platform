// The inbox store conformance suite on node:sqlite — the fast path, held to the same suite as
// Postgres (store-pg.test.ts).
import { SqliteOutboxStore } from '@atlas/data';
import { inboxStoreConformance } from '../src/store-conformance.ts';
import { sqliteInboxStore } from '../src/store-sqlite.ts';

inboxStoreConformance('sqliteInboxStore', {
  make: async () => {
    const store = sqliteInboxStore();
    return { store, outbox: new SqliteOutboxStore(store.db) };
  },
});
