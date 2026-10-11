// The workflow store conformance suite against node:sqlite. store-pg.test.ts runs the SAME suite
// against Postgres.

import { SqliteOutboxStore } from '@atlas/data';
import { workflowStoreConformance } from '../src/store-conformance.ts';
import { sqliteWorkflowStore } from '../src/store-sqlite.ts';

workflowStoreConformance('sqliteWorkflowStore', {
  make: async () => {
    const store = sqliteWorkflowStore();
    return { store, outbox: new SqliteOutboxStore(store.db) };
  },
});
