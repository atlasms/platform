// The hot query index (EP-07.4): OpenSearch, holding a projection of `audit_events`.
//
// The system of record stays Postgres — append-only by trigger, hash-chained, the seen-mark in the
// append's own transaction (store.ts). None of that survives a move into a search engine, which
// can enforce none of it. So the index is a DERIVED VIEW: the projector (projector.ts) copies
// committed rows in chain order, every document is keyed by the record's messageId so a re-index
// is an overwrite, and the index can be deleted and rebuilt from the log at any time. What the
// engine is for is the browse — a filtered, sorted page over a log that grows without bound — and
// that is the one method this file serves.
//
// A browse answered here and one answered by the store must be the same page. `browseConformance`
// (store-conformance.ts) runs the browse cases against both, which is what lets main.ts pick one
// by configuration.

import { ensureIndex, type OpenSearchClient } from '@atlas/data-opensearch';
import { Unavailable } from '@atlas/service-kit';
import type { AuditEvent, ChainHead, LogBrowser, LogFilter } from './store.ts';

export const DEFAULT_AUDIT_INDEX = 'atlas-audit';

/**
 * Explicit mapping. `keyword` on everything the browse filters or sorts on — exact matches, no
 * analysis — and `payload` NOT indexed: it is heterogeneous across event types, and letting the
 * engine map every field of every payload is how an index grows a thousand fields and a wrong type
 * on one of them refuses every later document that disagrees. The browse never filters on it.
 */
export const AUDIT_INDEX_MAPPINGS = {
  dynamic: 'strict',
  properties: {
    message_id: { type: 'keyword' },
    channel_id: { type: 'keyword' },
    seq: { type: 'long' },
    type: { type: 'keyword' },
    occurred_at: { type: 'date' },
    actor_kind: { type: 'keyword' },
    actor_id: { type: 'keyword' },
    correlation_id: { type: 'keyword' },
    payload: { type: 'object', enabled: false },
    prev_hash: { type: 'keyword', index: false },
    hash: { type: 'keyword', index: false },
  },
} as const;

/** The document. Snake case like the table, so a row and its document read alike in either tool. */
interface AuditDoc {
  message_id: string;
  channel_id: string;
  seq: number;
  type: string;
  occurred_at: string;
  actor_kind?: 'service' | 'user';
  actor_id?: string;
  correlation_id?: string;
  payload: unknown;
  prev_hash: string;
  hash: string;
}

export interface AuditIndex extends LogBrowser {
  /** Create the index if needed. Idempotent; the projector calls it until it succeeds. */
  ready(): Promise<void>;
  /** The last seq this index holds per channel — the projector's starting point after a restart. */
  heads(): Promise<Pick<ChainHead, 'channelId' | 'seq'>[]>;
  /** Index a batch, by messageId. Visible to `browse` when this resolves. */
  index(events: readonly AuditEvent[]): Promise<void>;
  /** Drop the whole index. The rebuild is the projector's next tick. */
  drop(): Promise<void>;
}

export function openSearchAuditIndex(
  client: OpenSearchClient,
  options: { index?: string } = {},
): AuditIndex {
  const index = options.index ?? DEFAULT_AUDIT_INDEX;

  /** A dependency that is down is a 503, not a 500: the request is fine, retry it later. */
  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      const status = (err as { meta?: { statusCode?: number | null } }).meta?.statusCode;
      // A status means the engine ANSWERED — a bad query is our bug, and stays a 500 that gets
      // logged. No status (the client sets null on a connection error) means it could not be
      // reached.
      if (typeof status === 'number') throw err;
      throw new Unavailable(`audit index unavailable: ${(err as Error).message}`);
    }
  };

  return {
    ready: () =>
      guard(async () => {
        await ensureIndex(client, { name: index, mappings: AUDIT_INDEX_MAPPINGS });
      }),

    async heads() {
      const { body } = await guard(() =>
        client.search({
          index,
          body: {
            size: 0,
            aggs: {
              // Channels number in the tens or hundreds; a composite aggregation is the change if
              // a deployment ever has more than this page.
              channels: {
                terms: { field: 'channel_id', size: 10_000 },
                aggs: { head: { max: { field: 'seq' } } },
              },
            },
          },
        }),
      );
      const buckets =
        (
          body.aggregations?.['channels'] as
            { buckets: { key: string; head: { value: number | null } }[] } | undefined
        )?.buckets ?? [];
      return buckets
        .filter((b) => b.head.value !== null)
        .map((b) => ({ channelId: b.key, seq: b.head.value as number }));
    },

    async index(events) {
      if (events.length === 0) return;
      const { body } = await guard(() =>
        client.bulk({
          // `refresh: true` makes the batch searchable before this resolves, so the projector's
          // "indexed up to seq N" is true for a reader the moment it is said. It costs a segment
          // flush per batch, which at an audit log's rate is nothing; `wait_for` is the knob if
          // that ever changes.
          refresh: true,
          body: events.flatMap((e) => [{ index: { _index: index, _id: e.messageId } }, toDoc(e)]),
        }),
      );
      if (body.errors) {
        const first = (body.items as { index?: { error?: { reason?: string } } }[]).find(
          (i) => i.index?.error,
        );
        throw new Error(`audit index bulk failed: ${first?.index?.error?.reason ?? 'unknown'}`);
      }
    },

    async browse(channelId, filter) {
      const { body } = await guard(() =>
        client.search({
          index,
          body: {
            size: filter.limit,
            // Newest first, keyset on seq — the same page the store's `ORDER BY seq DESC` gives.
            sort: [{ seq: 'desc' }],
            query: { bool: { filter: filterClauses(channelId, filter) } },
            track_total_hits: false,
          },
        }),
      );
      // The client types `_source` with an undeclared type variable, so the cast goes via unknown;
      // the mapping is `dynamic: strict`, which is what makes the document's shape ours.
      const hits = body.hits.hits as unknown as { _source?: AuditDoc }[];
      return hits.flatMap((h) => (h._source ? [toEvent(h._source)] : []));
    },

    drop: () =>
      guard(async () => {
        await client.indices.delete({ index, ignore_unavailable: true });
      }),
  };
}

/**
 * The browse filter as bool `filter` clauses — the same predicates as `browseClauses` in store.ts,
 * in the engine's dialect. Exact terms, inclusive date bounds, strict `before`.
 */
function filterClauses(channelId: string, filter: LogFilter): Record<string, unknown>[] {
  const clauses: Record<string, unknown>[] = [{ term: { channel_id: channelId } }];
  if (filter.types && filter.types.length > 0) clauses.push({ terms: { type: filter.types } });
  if (filter.correlationId !== undefined)
    clauses.push({ term: { correlation_id: filter.correlationId } });
  if (filter.actorId !== undefined) clauses.push({ term: { actor_id: filter.actorId } });
  if (filter.from !== undefined || filter.to !== undefined) {
    clauses.push({
      range: {
        occurred_at: {
          ...(filter.from !== undefined ? { gte: filter.from } : {}),
          ...(filter.to !== undefined ? { lte: filter.to } : {}),
        },
      },
    });
  }
  if (filter.before !== undefined) clauses.push({ range: { seq: { lt: filter.before } } });
  return clauses;
}

function toDoc(e: AuditEvent): AuditDoc {
  return {
    message_id: e.messageId,
    channel_id: e.channelId,
    seq: e.seq,
    type: e.type,
    occurred_at: e.occurredAt,
    ...(e.actorKind !== undefined ? { actor_kind: e.actorKind } : {}),
    ...(e.actorId !== undefined ? { actor_id: e.actorId } : {}),
    ...(e.correlationId !== undefined ? { correlation_id: e.correlationId } : {}),
    payload: e.payload,
    prev_hash: e.prevHash,
    hash: e.hash,
  };
}

function toEvent(d: AuditDoc): AuditEvent {
  return {
    messageId: d.message_id,
    channelId: d.channel_id,
    seq: d.seq,
    type: d.type,
    occurredAt: d.occurred_at,
    ...(d.actor_kind !== undefined ? { actorKind: d.actor_kind } : {}),
    ...(d.actor_id !== undefined ? { actorId: d.actor_id } : {}),
    ...(d.correlation_id !== undefined ? { correlationId: d.correlation_id } : {}),
    payload: d.payload,
    prevHash: d.prev_hash,
    hash: d.hash,
  };
}
