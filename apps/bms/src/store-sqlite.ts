// The node:sqlite adapter — the test double, held to the same conformance suite as Postgres.

import {
  migrate,
  openDb,
  outboxHeadersMigration,
  outboxMigration,
  SqliteOutboxStore,
  withTransactionAsync,
  type Db,
  type Migration,
} from '@atlas/data';
import type { WorkflowStore, WorkflowTx } from './store.ts';
import type { Workflow, WorkflowVersion } from './workflow.ts';

export const sqliteMigrations: Migration[] = [
  outboxMigration,
  outboxHeadersMigration,
  {
    id: 'bms_workflows',
    up: `CREATE TABLE IF NOT EXISTS workflows (
           id         TEXT PRIMARY KEY,
           channel_id TEXT NOT NULL,
           revision   INTEGER NOT NULL,
           data       TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS workflows_channel_idx ON workflows (channel_id, id);
         CREATE TABLE IF NOT EXISTS workflow_versions (
           workflow_id TEXT NOT NULL REFERENCES workflows(id),
           version     INTEGER NOT NULL,
           channel_id  TEXT NOT NULL,
           status      TEXT NOT NULL CHECK (status IN ('draft', 'published')),
           data        TEXT NOT NULL,
           PRIMARY KEY (workflow_id, version)
         );
         -- At most one open draft per workflow (§7).
         CREATE UNIQUE INDEX IF NOT EXISTS workflow_versions_one_draft
           ON workflow_versions (workflow_id) WHERE status = 'draft';`,
  },
];

export function sqliteWorkflowStore(path = ':memory:'): WorkflowStore & { db: Db } {
  const db = openDb(path);
  migrate(db, sqliteMigrations);
  const outbox = new SqliteOutboxStore(db);

  const tx: WorkflowTx = {
    async put(w, ifRevision) {
      const data = JSON.stringify(w);
      const result =
        ifRevision === undefined
          ? db
              .prepare(
                `INSERT INTO workflows (id, channel_id, revision, data) VALUES (?, ?, ?, ?)
                 ON CONFLICT (id) DO NOTHING`,
              )
              .run(w.id, w.channelId, w.revision, data)
          : db
              .prepare(`UPDATE workflows SET revision = ?, data = ? WHERE id = ? AND revision = ?`)
              .run(w.revision, data, w.id, ifRevision);
      return Number(result.changes) === 1;
    },
    async putVersion(v) {
      // The WHERE on the upsert is the immutability: a published row matches nothing, so the
      // statement changes no row and the caller is told.
      const result = db
        .prepare(
          `INSERT INTO workflow_versions (workflow_id, version, channel_id, status, data)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (workflow_id, version) DO UPDATE SET status = excluded.status, data = excluded.data
           WHERE workflow_versions.status = 'draft'`,
        )
        .run(v.workflowId, v.version, v.channelId, v.status, JSON.stringify(v));
      return Number(result.changes) === 1;
    },
    async enqueue(record) {
      outbox.enqueue(record);
    },
  };

  return {
    db,
    async transaction(fn) {
      return withTransactionAsync(db, () => fn(tx));
    },
    async get(id) {
      const row = db.prepare('SELECT data FROM workflows WHERE id = ?').get(id) as
        { data: string } | undefined;
      return row ? (JSON.parse(row.data) as Workflow) : undefined;
    },
    async list(channelId, { after, limit }) {
      const rows = (
        after === undefined
          ? db
              .prepare('SELECT data FROM workflows WHERE channel_id = ? ORDER BY id LIMIT ?')
              .all(channelId, limit)
          : db
              .prepare(
                'SELECT data FROM workflows WHERE channel_id = ? AND id > ? ORDER BY id LIMIT ?',
              )
              .all(channelId, after, limit)
      ) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data) as Workflow);
    },
    async version(workflowId, version) {
      const row = db
        .prepare('SELECT data FROM workflow_versions WHERE workflow_id = ? AND version = ?')
        .get(workflowId, version) as { data: string } | undefined;
      return row ? (JSON.parse(row.data) as WorkflowVersion) : undefined;
    },
    async published(workflowId) {
      const rows = db
        .prepare(
          `SELECT data FROM workflow_versions WHERE workflow_id = ? AND status = 'published'
           ORDER BY version DESC`,
        )
        .all(workflowId) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data) as WorkflowVersion);
    },
    async close() {
      db.close();
    },
  };
}
