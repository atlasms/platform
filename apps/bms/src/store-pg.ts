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
  // EP-22.6: the steps waiting for an event, by its keys — the open ones of a type are what the
  // router reads for every event of it, so they are indexed by type and asset, open only.
  {
    id: 'bms_event_awaits',
    up: `CREATE TABLE IF NOT EXISTS event_awaits (
           correlation_id text NOT NULL,
           event_type     text NOT NULL,
           channel_id     text NOT NULL,
           instance_id    text NOT NULL,
           asset_id       text,
           answered_at    timestamptz,
           data           jsonb NOT NULL,
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
           message_id  text PRIMARY KEY,
           channel_id  text NOT NULL,
           event_type  text NOT NULL,
           asset_id    text,
           occurred_at timestamptz NOT NULL,
           received_at timestamptz NOT NULL,
           data        jsonb NOT NULL
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
          async insertEventAwait(a) {
            const result = await client.query(
              `INSERT INTO event_awaits (correlation_id, event_type, channel_id, instance_id, asset_id, data)
               VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (correlation_id, event_type) DO NOTHING`,
              [
                a.correlationId,
                a.eventType,
                a.channelId,
                a.instanceId,
                assetKey(a),
                JSON.stringify(a),
              ],
            );
            return result.rowCount === 1;
          },
          async answerEventAwaits(correlationId, answeredAt, answeredBy) {
            const result = await client.query(
              `UPDATE event_awaits
                  SET answered_at = $1,
                      data = data || jsonb_build_object('answeredAt', $2::text, 'answeredBy', $3::text)
                WHERE correlation_id = $4 AND answered_at IS NULL`,
              [answeredAt, answeredAt, answeredBy, correlationId],
            );
            return (result.rowCount ?? 0) > 0;
          },
          async bufferEvent(e) {
            const result = await client.query(
              `INSERT INTO event_buffer (message_id, channel_id, event_type, asset_id, occurred_at, received_at, data)
               VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (message_id) DO NOTHING`,
              [
                e.messageId,
                e.channelId,
                e.eventType,
                e.assetId ?? null,
                e.occurredAt,
                e.receivedAt,
                JSON.stringify(e),
              ],
            );
            return result.rowCount === 1;
          },
          async pruneEventBuffer(before) {
            const result = await client.query('DELETE FROM event_buffer WHERE received_at < $1', [
              before,
            ]);
            return result.rowCount ?? 0;
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
    async instances(channelId, { workflowId, state, after, limit }) {
      const params: (string | number)[] = [channelId];
      let where = 'channel_id = $1';
      if (workflowId !== undefined) {
        params.push(workflowId);
        where += ` AND workflow_id = $${params.length}`;
      }
      if (state !== undefined) {
        params.push(state);
        where += ` AND state = $${params.length}`;
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
    async bufferedEvents(channelId, eventType, since, assetId) {
      const { rows } = await pool.query<{ data: BufferedEvent }>(
        assetId === undefined
          ? `SELECT data FROM event_buffer
              WHERE channel_id = $1 AND event_type = $2 AND occurred_at >= $3
              ORDER BY occurred_at, message_id`
          : `SELECT data FROM event_buffer
              WHERE channel_id = $1 AND event_type = $2 AND occurred_at >= $3
                AND (asset_id IS NULL OR asset_id = $4)
              ORDER BY occurred_at, message_id`,
        assetId === undefined
          ? [channelId, eventType, since]
          : [channelId, eventType, since, assetId],
      );
      return rows.map((r) => r.data);
    },
    async bufferedEvent(messageId) {
      const { rows } = await pool.query<{ data: BufferedEvent }>(
        'SELECT data FROM event_buffer WHERE message_id = $1',
        [messageId],
      );
      return rows[0]?.data;
    },
    async eventAwaitsFor(correlationId) {
      const { rows } = await pool.query<{ data: EventAwait }>(
        'SELECT data FROM event_awaits WHERE correlation_id = $1 ORDER BY event_type',
        [correlationId],
      );
      return rows.map((r) => r.data);
    },
    async eventsUsedBy(instanceId) {
      const { rows } = await pool.query<{ m: string | null }>(
        `SELECT DISTINCT data->>'answeredBy' AS m FROM event_awaits
          WHERE instance_id = $1 AND answered_at IS NOT NULL`,
        [instanceId],
      );
      return rows.flatMap((r) => (r.m !== null ? [r.m] : []));
    },
    async openEventAwaits(channelId, eventType, assetId) {
      const { rows } = await pool.query<{ data: EventAwait }>(
        assetId === undefined
          ? `SELECT data FROM event_awaits
              WHERE channel_id = $1 AND event_type = $2 AND answered_at IS NULL`
          : `SELECT data FROM event_awaits
              WHERE channel_id = $1 AND event_type = $2 AND answered_at IS NULL
                AND (asset_id IS NULL OR asset_id = $3)`,
        assetId === undefined ? [channelId, eventType] : [channelId, eventType, assetId],
      );
      return rows.map((r) => r.data);
    },
    async close() {
      // The pool is main.ts's to end.
    },
  };
}
