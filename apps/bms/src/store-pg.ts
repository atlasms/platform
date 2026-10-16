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
import type { CommandAwait, HistoryEntry, Instance } from './instance.ts';
import type { WorkflowStore, WorkflowTx } from './store.ts';
import { withState, type Workflow, type WorkflowVersion } from './workflow.ts';

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
  // EP-22.11: a workflow's lifecycle state, as a column the catalog and the list filter on. A header
  // written before it is backfilled as its reader would interpret it (withState): published once →
  // active, never → draft.
  {
    id: 'bms_workflow_state',
    up: `ALTER TABLE workflows ADD COLUMN state text;
         UPDATE workflows SET state = CASE WHEN (data->>'latestVersion')::int > 0 THEN 'active' ELSE 'draft' END WHERE state IS NULL;
         CREATE INDEX IF NOT EXISTS workflows_state_idx ON workflows (channel_id, state, id);`,
  },
  // EP-22.4: the commands command steps issued, by the correlation id their answers carry back.
  {
    id: 'bms_command_awaits',
    up: `CREATE TABLE IF NOT EXISTS command_awaits (
           correlation_id text PRIMARY KEY,
           channel_id     text NOT NULL,
           instance_id    text NOT NULL,
           answered_at    timestamptz,
           data           jsonb NOT NULL
         );
         CREATE INDEX IF NOT EXISTS command_awaits_instance_idx ON command_awaits (channel_id, instance_id);`,
  },
];

/** The row's `state` column is the truth for the filter, so it is the truth on the record too. */
const fromRow = (r: { data: Workflow; state: string | null }): Workflow =>
  r.state !== null ? { ...r.data, state: r.state as Workflow['state'] } : withState(r.data);

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
                    `INSERT INTO workflows (id, channel_id, revision, state, data) VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (id) DO NOTHING`,
                    [w.id, w.channelId, w.revision, w.state, data],
                  )
                : await client.query(
                    `UPDATE workflows SET revision = $1, state = $2, data = $3 WHERE id = $4 AND revision = $5`,
                    [w.revision, w.state, data, w.id, ifRevision],
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
          async workflowForUpdate(id) {
            const { rows } = await client.query<{ data: Workflow; state: string | null }>(
              'SELECT data, state FROM workflows WHERE id = $1 FOR UPDATE',
              [id],
            );
            return rows[0] ? fromRow(rows[0]) : undefined;
          },
          async liveInstances(workflowId) {
            const { rows } = await client.query<{ n: string }>(
              `SELECT count(*) AS n FROM workflow_instances
               WHERE workflow_id = $1 AND state NOT IN ('completed', 'failed')`,
              [workflowId],
            );
            return Number(rows[0]?.n ?? 0);
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
          async insertAwait(a) {
            const result = await client.query(
              `INSERT INTO command_awaits (correlation_id, channel_id, instance_id, data)
               VALUES ($1, $2, $3, $4) ON CONFLICT (correlation_id) DO NOTHING`,
              [a.correlationId, a.channelId, a.instanceId, JSON.stringify(a)],
            );
            return result.rowCount === 1;
          },
          async answerAwait(correlationId, answeredAt, answeredBy) {
            const result = await client.query(
              `UPDATE command_awaits
                  SET answered_at = $1,
                      data = data || jsonb_build_object('answeredAt', $2::text, 'answeredBy', $3::text)
                WHERE correlation_id = $4 AND answered_at IS NULL`,
              [answeredAt, answeredAt, answeredBy, correlationId],
            );
            return result.rowCount === 1;
          },
        };
        return fn(tx);
      });
    },
    async get(id) {
      const { rows } = await pool.query<{ data: Workflow; state: string | null }>(
        'SELECT data, state FROM workflows WHERE id = $1',
        [id],
      );
      return rows[0] ? fromRow(rows[0]) : undefined;
    },
    async list(channelId, { state, after, limit }) {
      const params: (string | number)[] = [channelId];
      let where = 'channel_id = $1';
      if (state !== undefined) {
        params.push(state);
        where += ` AND state = $${params.length}`;
      }
      if (after !== undefined) {
        params.push(after);
        where += ` AND id > $${params.length}`;
      }
      params.push(limit);
      const { rows } = await pool.query<{ data: Workflow; state: string | null }>(
        `SELECT data, state FROM workflows WHERE ${where} ORDER BY id LIMIT $${params.length}`,
        params,
      );
      return rows.map(fromRow);
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
    async commandAwait(correlationId) {
      const { rows } = await pool.query<{ data: CommandAwait }>(
        'SELECT data FROM command_awaits WHERE correlation_id = $1',
        [correlationId],
      );
      return rows[0]?.data;
    },
    async close() {
      // The pool is main.ts's to end.
    },
  };
}
