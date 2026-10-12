// The node:sqlite adapter — the test double, held to the same conformance suite as Postgres.

import {
  migrate,
  openDb,
  outboxHeadersMigration,
  outboxMigration,
  seenMigration,
  SqliteOutboxStore,
  SqliteSeenStore,
  withTransactionAsync,
  type Db,
  type Migration,
} from '@atlas/data';
import type { HistoryEntry, Instance } from './instance.ts';
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
  // EP-22.3: the instance mirror (Temporal holds the instance) and its step history, and the
  // seen-mark that makes every activity's writes idempotent.
  seenMigration,
  {
    id: 'bms_instances',
    up: `CREATE TABLE IF NOT EXISTS workflow_instances (
           id          TEXT PRIMARY KEY,
           channel_id  TEXT NOT NULL,
           workflow_id TEXT NOT NULL,
           state       TEXT NOT NULL,
           data        TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS workflow_instances_channel_idx ON workflow_instances (channel_id, id);
         CREATE INDEX IF NOT EXISTS workflow_instances_workflow_idx ON workflow_instances (channel_id, workflow_id, id);
         CREATE TABLE IF NOT EXISTS workflow_step_history (
           instance_id TEXT NOT NULL,
           seq         INTEGER NOT NULL,
           channel_id  TEXT NOT NULL,
           data        TEXT NOT NULL,
           PRIMARY KEY (instance_id, seq)
         );`,
  },
];

export function sqliteWorkflowStore(path = ':memory:'): WorkflowStore & { db: Db } {
  const db = openDb(path);
  migrate(db, sqliteMigrations);
  const outbox = new SqliteOutboxStore(db);
  const seen = new SqliteSeenStore(db);

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
    async insertInstance(i) {
      const result = db
        .prepare(
          `INSERT INTO workflow_instances (id, channel_id, workflow_id, state, data)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
        )
        .run(i.id, i.channelId, i.workflowId, i.state, JSON.stringify(i));
      return Number(result.changes) === 1;
    },
    async instanceForUpdate(id) {
      // sqlite serializes writers; the transaction is the lock.
      const row = db.prepare('SELECT data FROM workflow_instances WHERE id = ?').get(id) as
        { data: string } | undefined;
      return row ? (JSON.parse(row.data) as Instance) : undefined;
    },
    async putInstance(i) {
      db.prepare('UPDATE workflow_instances SET state = ?, data = ? WHERE id = ?').run(
        i.state,
        JSON.stringify(i),
        i.id,
      );
    },
    async appendHistory(e) {
      const result = db
        .prepare(
          `INSERT INTO workflow_step_history (instance_id, seq, channel_id, data)
           VALUES (?, ?, ?, ?) ON CONFLICT (instance_id, seq) DO NOTHING`,
        )
        .run(e.instanceId, e.seq, e.channelId, JSON.stringify(e));
      return Number(result.changes) === 1;
    },
    async markSeen(key) {
      return seen.mark(db, key);
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
    async instance(id) {
      const row = db.prepare('SELECT data FROM workflow_instances WHERE id = ?').get(id) as
        { data: string } | undefined;
      return row ? (JSON.parse(row.data) as Instance) : undefined;
    },
    async instances(channelId, { workflowId, after, limit }) {
      const params: (string | number)[] = [channelId];
      let where = 'channel_id = ?';
      if (workflowId !== undefined) {
        where += ' AND workflow_id = ?';
        params.push(workflowId);
      }
      if (after !== undefined) {
        where += ' AND id < ?';
        params.push(after);
      }
      params.push(limit);
      const rows = db
        .prepare(`SELECT data FROM workflow_instances WHERE ${where} ORDER BY id DESC LIMIT ?`)
        .all(...params) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data) as Instance);
    },
    async history(instanceId) {
      const rows = db
        .prepare('SELECT data FROM workflow_step_history WHERE instance_id = ? ORDER BY seq')
        .all(instanceId) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data) as HistoryEntry);
    },
    async close() {
      db.close();
    },
  };
}
