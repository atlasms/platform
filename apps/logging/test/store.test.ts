// The audit store conformance suite against node:sqlite — the fast path, and the one that runs
// on a laptop without Docker. store-pg.test.ts runs the SAME suite against Postgres.

import { auditStoreConformance } from '../src/store-conformance.ts';
import { sqliteAuditStore } from '../src/store-sqlite.ts';

auditStoreConformance('sqliteAuditStore', {
  make: async () => ({ store: sqliteAuditStore() }),
  tamper: async (store, messageId) => {
    const db = (store as ReturnType<typeof sqliteAuditStore>).db;
    db.prepare("UPDATE audit_events SET type = 'forged' WHERE message_id = ?").run(messageId);
  },
});
