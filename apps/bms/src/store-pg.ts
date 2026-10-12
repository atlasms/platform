// The Postgres adapter — production. Same port, same conformance suite.

import type { Migration } from '@atlas/data';
import {
  outboxHeadersMigration,
  outboxMigration,
  PgOutboxStore,
  PgSeenStore,
  seenMigration,
  withTransaction,
  type PgPool,
} from '@atlas/data-pg';
import type { HistoryEntry, Instance } from './instance.ts';
import type { WorkflowStore, WorkflowTx } from './store.ts';
import type { Workflow, WorkflowVersion } from './workflow.ts';

export const pgMigrations: Migration[] = [
  outboxMigration,
  outboxHeadersMigration,
  {
    id: 'bms_workflows',
    up: `CREATE TABLE IF NOT EXISTS workflows (
           id         text PRIMARY KEY,
           channel_id text NOT NULL,
           revision   integer NOT NULL,
           data       jsonb NOT NULL
         );
         CREATE INDEX IF NOT EXISTS workflows_channel_idx ON workflows (channel_id, id);
         CREATE TABLE IF NOT EXISTS workflow_versions (
           workflow_id text NOT NULL REFERENCES workflows(id),
           version     integer NOT NULL,
           channel_id  text NOT NULL,
           status      text NOT NULL CHECK (status IN ('draft', 'published')),
           data        jsonb NOT NULL,
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
           id          text PRIMARY KEY,
           channel_id  text NOT NULL,
           workflow_id text NOT NULL,
           state       text NOT NULL,
           data        jsonb NOT NULL
         );
         CREATE INDEX IF NOT EXISTS workflow_instances_channel_idx ON workflow_instances (channel_id, id);
         CREATE INDEX IF NOT EXISTS workflow_instances_workflow_idx ON workflow_instances (channel_id, workflow_id, id);
         CREATE TABLE IF NOT EXISTS workflow_step_history (
           instance_id text NOT NULL,
           seq         integer NOT NULL,
           channel_id  text NOT NULL,
           data        jsonb NOT NULL,
           PRIMARY KEY (instance_id, seq)
         );`,
  },
];

export function pgWorkflowStore(pool: PgPool): WorkflowStore {
  const outbox = new PgOutboxStore(pool);
  const seen = new PgSeenStore(pool);

  return {
    async transaction(fn) {
      return withTransaction(pool, async (client) => {
        const tx: WorkflowTx = {
          async put(w, ifRevision) {
            const data = JSON.stringify(w);
            const result =
              ifRevision === undefined
                ? await client.query(
                    `INSERT INTO workflows (id, channel_id, revision, data) VALUES ($1, $2, $3, $4)
                     ON CONFLICT (id) DO NOTHING`,
                    [w.id, w.channelId, w.revision, data],
                  )
                : await client.query(
                    `UPDATE workflows SET revision = $1, data = $2 WHERE id = $3 AND revision = $4`,
                    [w.revision, data, w.id, ifRevision],
                  );
            return result.rowCount === 1;
          },
          async putVersion(v) {
            // The WHERE on the upsert is the immutability: a published row matches nothing.
            const result = await client.query(
              `INSERT INTO workflow_versions (workflow_id, version, channel_id, status, data)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (workflow_id, version) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data
               WHERE workflow_versions.status = 'draft'`,
              [v.workflowId, v.version, v.channelId, v.status, JSON.stringify(v)],
            );
            return result.rowCount === 1;
          },
          async enqueue(record) {
            await outbox.enqueue(client, record);
          },
          async insertInstance(i) {
            const result = await client.query(
              `INSERT INTO workflow_instances (id, channel_id, workflow_id, state, data)
               VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
              [i.id, i.channelId, i.workflowId, i.state, JSON.stringify(i)],
            );
            return result.rowCount === 1;
          },
          async instanceForUpdate(id) {
            const { rows } = await client.query<{ data: Instance }>(
              'SELECT data FROM workflow_instances WHERE id = $1 FOR UPDATE',
              [id],
            );
            return rows[0]?.data;
          },
          async putInstance(i) {
            await client.query(
              'UPDATE workflow_instances SET state = $1, data = $2 WHERE id = $3',
              [i.state, JSON.stringify(i), i.id],
            );
          },
          async appendHistory(e) {
            const result = await client.query(
              `INSERT INTO workflow_step_history (instance_id, seq, channel_id, data)
               VALUES ($1, $2, $3, $4) ON CONFLICT (instance_id, seq) DO NOTHING`,
              [e.instanceId, e.seq, e.channelId, JSON.stringify(e)],
            );
            return result.rowCount === 1;
          },
          async markSeen(key) {
            return seen.mark(client, key);
          },
        };
        return fn(tx);
      });
    },
    async get(id) {
      const { rows } = await pool.query<{ data: Workflow }>(
        'SELECT data FROM workflows WHERE id = $1',
        [id],
      );
      return rows[0]?.data;
    },
    async list(channelId, { after, limit }) {
      const { rows } =
        after === undefined
          ? await pool.query<{ data: Workflow }>(
              'SELECT data FROM workflows WHERE channel_id = $1 ORDER BY id LIMIT $2',
              [channelId, limit],
            )
          : await pool.query<{ data: Workflow }>(
              'SELECT data FROM workflows WHERE channel_id = $1 AND id > $2 ORDER BY id LIMIT $3',
              [channelId, after, limit],
            );
      return rows.map((r) => r.data);
    },
    async version(workflowId, version) {
      const { rows } = await pool.query<{ data: WorkflowVersion }>(
        'SELECT data FROM workflow_versions WHERE workflow_id = $1 AND version = $2',
        [workflowId, version],
      );
      return rows[0]?.data;
    },
    async published(workflowId) {
      const { rows } = await pool.query<{ data: WorkflowVersion }>(
        `SELECT data FROM workflow_versions WHERE workflow_id = $1 AND status = 'published'
         ORDER BY version DESC`,
        [workflowId],
      );
      return rows.map((r) => r.data);
    },
    async instance(id) {
      const { rows } = await pool.query<{ data: Instance }>(
        'SELECT data FROM workflow_instances WHERE id = $1',
        [id],
      );
      return rows[0]?.data;
    },
    async instances(channelId, { workflowId, after, limit }) {
      const params: (string | number)[] = [channelId];
      let where = 'channel_id = $1';
      if (workflowId !== undefined) {
        params.push(workflowId);
        where += ` AND workflow_id = $${params.length}`;
      }
      if (after !== undefined) {
        params.push(after);
        where += ` AND id < $${params.length}`;
      }
      params.push(limit);
      const { rows } = await pool.query<{ data: Instance }>(
        `SELECT data FROM workflow_instances WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`,
        params,
      );
      return rows.map((r) => r.data);
    },
    async history(instanceId) {
      const { rows } = await pool.query<{ data: HistoryEntry }>(
        'SELECT data FROM workflow_step_history WHERE instance_id = $1 ORDER BY seq',
        [instanceId],
      );
      return rows.map((r) => r.data);
    },
    async close() {
      // The pool is main.ts's to end.
    },
  };
}
