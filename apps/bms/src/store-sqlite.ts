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
import {
  assetKey,
  type BufferedEvent,
  type CommandAwait,
  type EventAwait,
  type HistoryEntry,
  type Instance,
} from './instance.ts';
import type { WorkflowStore, WorkflowTx } from './store.ts';
import { withState, type Workflow, type WorkflowVersion } from './workflow.ts';

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
  // EP-22.11: a workflow's lifecycle state, as a column the catalog and the list filter on. A header
  // written before it is backfilled as its reader would interpret it (withState): published once →
  // active, never → draft.
  {
    id: 'bms_workflow_state',
    up: `ALTER TABLE workflows ADD COLUMN state TEXT;
         UPDATE workflows SET state = CASE WHEN json_extract(data, '$.latestVersion') > 0 THEN 'active' ELSE 'draft' END WHERE state IS NULL;
         CREATE INDEX IF NOT EXISTS workflows_state_idx ON workflows (channel_id, state, id);`,
  },
  // EP-22.4: the commands command steps issued, by the correlation id their answers carry back.
  {
    id: 'bms_command_awaits',
    up: `CREATE TABLE IF NOT EXISTS command_awaits (
           correlation_id TEXT PRIMARY KEY,
           channel_id     TEXT NOT NULL,
           instance_id    TEXT NOT NULL,
           answered_at    TEXT,
           data           TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS command_awaits_instance_idx ON command_awaits (channel_id, instance_id);`,
  },
  // EP-22.6: the steps waiting for an event, by its keys — the open ones of a type are what the
  // router reads for every event of it, so they are indexed by type and asset, open only.
  {
    id: 'bms_event_awaits',
    up: `CREATE TABLE IF NOT EXISTS event_awaits (
           correlation_id TEXT NOT NULL,
           event_type     TEXT NOT NULL,
           channel_id     TEXT NOT NULL,
           instance_id    TEXT NOT NULL,
           asset_id       TEXT,
           answered_at    TEXT,
           data           TEXT NOT NULL,
           PRIMARY KEY (correlation_id, event_type)
         );
         CREATE INDEX IF NOT EXISTS event_awaits_open_idx
           ON event_awaits (channel_id, event_type, asset_id) WHERE answered_at IS NULL;`,
  },
  // EP-22.7: the waitable events, kept a while for a step that starts waiting after them; and the
  // index that says which events already moved an instance.
  {
    id: 'bms_event_buffer',
    up: `CREATE TABLE IF NOT EXISTS event_buffer (
           message_id  TEXT PRIMARY KEY,
           channel_id  TEXT NOT NULL,
           event_type  TEXT NOT NULL,
           asset_id    TEXT,
           occurred_at TEXT NOT NULL,
           received_at TEXT NOT NULL,
           data        TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS event_buffer_lookup_idx
           ON event_buffer (channel_id, event_type, asset_id, occurred_at);
         CREATE INDEX IF NOT EXISTS event_buffer_received_idx ON event_buffer (received_at);
         CREATE INDEX IF NOT EXISTS event_awaits_instance_idx ON event_awaits (instance_id);`,
  },
  // EP-22.9: the failed runs an operator lists (`GET /instances?state=failed`).
  {
    id: 'bms_instances_state_idx',
    up: `CREATE INDEX IF NOT EXISTS workflow_instances_state_idx ON workflow_instances (channel_id, state, id);`,
  },
];

/** The row's `state` column is the truth for the filter, so it is the truth on the record too. */
const fromRow = (r: { data: string; state: string | null }): Workflow => {
  const w = JSON.parse(r.data) as Workflow;
  return r.state !== null ? { ...w, state: r.state as Workflow['state'] } : withState(w);
};

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
                `INSERT INTO workflows (id, channel_id, revision, state, data) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (id) DO NOTHING`,
              )
              .run(w.id, w.channelId, w.revision, w.state, data)
          : db
              .prepare(
                `UPDATE workflows SET revision = ?, state = ?, data = ? WHERE id = ? AND revision = ?`,
              )
              .run(w.revision, w.state, data, w.id, ifRevision);
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
    async workflowForUpdate(id) {
      // sqlite serializes writers; the transaction is the lock.
      const row = db.prepare('SELECT data, state FROM workflows WHERE id = ?').get(id) as
        { data: string; state: string | null } | undefined;
      return row ? fromRow(row) : undefined;
    },
    async liveInstances(workflowId) {
      const row = db
        .prepare(
          `SELECT count(*) AS n FROM workflow_instances
           WHERE workflow_id = ? AND state NOT IN ('completed', 'failed')`,
        )
        .get(workflowId) as { n: number };
      return Number(row.n);
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
    async insertAwait(a) {
      const result = db
        .prepare(
          `INSERT INTO command_awaits (correlation_id, channel_id, instance_id, data)
           VALUES (?, ?, ?, ?) ON CONFLICT (correlation_id) DO NOTHING`,
        )
        .run(a.correlationId, a.channelId, a.instanceId, JSON.stringify(a));
      return Number(result.changes) === 1;
    },
    async answerAwait(correlationId, answeredAt, answeredBy) {
      const result = db
        .prepare(
          `UPDATE command_awaits
              SET answered_at = ?,
                  data = json_set(data, '$.answeredAt', ?, '$.answeredBy', ?)
            WHERE correlation_id = ? AND answered_at IS NULL`,
        )
        .run(answeredAt, answeredAt, answeredBy, correlationId);
      return Number(result.changes) === 1;
    },
    async insertEventAwait(a) {
      const result = db
        .prepare(
          `INSERT INTO event_awaits (correlation_id, event_type, channel_id, instance_id, asset_id, data)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (correlation_id, event_type) DO NOTHING`,
        )
        .run(
          a.correlationId,
          a.eventType,
          a.channelId,
          a.instanceId,
          assetKey(a),
          JSON.stringify(a),
        );
      return Number(result.changes) === 1;
    },
    async answerEventAwaits(correlationId, answeredAt, answeredBy) {
      const result = db
        .prepare(
          `UPDATE event_awaits
              SET answered_at = ?,
                  data = json_set(data, '$.answeredAt', ?, '$.answeredBy', ?)
            WHERE correlation_id = ? AND answered_at IS NULL`,
        )
        .run(answeredAt, answeredAt, answeredBy, correlationId);
      return Number(result.changes) > 0;
    },
    async bufferEvent(e) {
      const result = db
        .prepare(
          `INSERT INTO event_buffer (message_id, channel_id, event_type, asset_id, occurred_at, received_at, data)
           VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (message_id) DO NOTHING`,
        )
        .run(
          e.messageId,
          e.channelId,
          e.eventType,
          e.assetId ?? null,
          e.occurredAt,
          e.receivedAt,
          JSON.stringify(e),
        );
      return Number(result.changes) === 1;
    },
    async pruneEventBuffer(before) {
      const result = db.prepare('DELETE FROM event_buffer WHERE received_at < ?').run(before);
      return Number(result.changes);
    },
  };

  return {
    db,
    async transaction(fn) {
      return withTransactionAsync(db, () => fn(tx));
    },
    async get(id) {
      const row = db.prepare('SELECT data, state FROM workflows WHERE id = ?').get(id) as
        { data: string; state: string | null } | undefined;
      return row ? fromRow(row) : undefined;
    },
    async list(channelId, { state, after, limit }) {
      const params: (string | number)[] = [channelId];
      let where = 'channel_id = ?';
      if (state !== undefined) {
        where += ' AND state = ?';
        params.push(state);
      }
      if (after !== undefined) {
        where += ' AND id > ?';
        params.push(after);
      }
      params.push(limit);
      const rows = db
        .prepare(`SELECT data, state FROM workflows WHERE ${where} ORDER BY id LIMIT ?`)
        .all(...params) as { data: string; state: string | null }[];
      return rows.map(fromRow);
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
    async instances(channelId, { workflowId, state, after, limit }) {
      const params: (string | number)[] = [channelId];
      let where = 'channel_id = ?';
      if (workflowId !== undefined) {
        where += ' AND workflow_id = ?';
        params.push(workflowId);
      }
      if (state !== undefined) {
        where += ' AND state = ?';
        params.push(state);
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
    async commandAwait(correlationId) {
      const row = db
        .prepare('SELECT data FROM command_awaits WHERE correlation_id = ?')
        .get(correlationId) as { data: string } | undefined;
      return row ? (JSON.parse(row.data) as CommandAwait) : undefined;
    },
    async bufferedEvents(channelId, eventType, since, assetId) {
      const rows = (
        assetId === undefined
          ? db
              .prepare(
                `SELECT data FROM event_buffer
                  WHERE channel_id = ? AND event_type = ? AND occurred_at >= ?
                  ORDER BY occurred_at, message_id`,
              )
              .all(channelId, eventType, since)
          : db
              .prepare(
                `SELECT data FROM event_buffer
                  WHERE channel_id = ? AND event_type = ? AND occurred_at >= ?
                    AND (asset_id IS NULL OR asset_id = ?)
                  ORDER BY occurred_at, message_id`,
              )
              .all(channelId, eventType, since, assetId)
      ) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data) as BufferedEvent);
    },
    async bufferedEvent(messageId) {
      const row = db
        .prepare('SELECT data FROM event_buffer WHERE message_id = ?')
        .get(messageId) as { data: string } | undefined;
      return row ? (JSON.parse(row.data) as BufferedEvent) : undefined;
    },
    async eventAwaitsFor(correlationId) {
      const rows = db
        .prepare('SELECT data FROM event_awaits WHERE correlation_id = ? ORDER BY event_type')
        .all(correlationId) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data) as EventAwait);
    },
    async eventsUsedBy(instanceId) {
      const rows = db
        .prepare(
          `SELECT DISTINCT json_extract(data, '$.answeredBy') AS m FROM event_awaits
            WHERE instance_id = ? AND answered_at IS NOT NULL`,
        )
        .all(instanceId) as { m: string | null }[];
      return rows.flatMap((r) => (r.m !== null ? [r.m] : []));
    },
    async openEventAwaits(channelId, eventType, assetId) {
      const rows = (
        assetId === undefined
          ? db
              .prepare(
                `SELECT data FROM event_awaits
                  WHERE channel_id = ? AND event_type = ? AND answered_at IS NULL`,
              )
              .all(channelId, eventType)
          : db
              .prepare(
                `SELECT data FROM event_awaits
                  WHERE channel_id = ? AND event_type = ? AND answered_at IS NULL
                    AND (asset_id IS NULL OR asset_id = ?)`,
              )
              .all(channelId, eventType, assetId)
      ) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data) as EventAwait);
    },
    async close() {
      db.close();
    },
  };
}
