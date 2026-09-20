// The index's test double: an AuditIndex in a Map, with the same "keyed by messageId", "heads"
// and "trim below the head" semantics as the OpenSearch adapter — the way the sqlite store is
// the double for Postgres. The projector's and the retention's tests drive it; the OpenSearch
// adapter's own test (index-opensearch.test.ts) holds the real engine to the same cases.

import type { AuditIndex } from './index-opensearch.ts';
import type { AuditEvent } from './store.ts';

export function memoryAuditIndex(opts: { failNext?: () => boolean } = {}): {
  index: AuditIndex;
  docs: Map<string, AuditEvent>;
  bulks: () => number;
} {
  const docs = new Map<string, AuditEvent>();
  let bulks = 0;
  const index: AuditIndex = {
    ready: async () => undefined,
    heads: async () => {
      const heads = new Map<string, number>();
      for (const e of docs.values())
        heads.set(e.channelId, Math.max(heads.get(e.channelId) ?? 0, e.seq));
      return [...heads].map(([channelId, seq]) => ({ channelId, seq }));
    },
    index: async (events) => {
      bulks += 1;
      if (opts.failNext?.()) throw new Error('bulk refused');
      for (const e of events) docs.set(e.messageId, e);
    },
    browse: async (channelId, filter) =>
      [...docs.values()]
        .filter(
          (e) =>
            e.channelId === channelId &&
            (filter.before === undefined || e.seq < filter.before) &&
            (filter.types === undefined || filter.types.includes(e.type)) &&
            (filter.from === undefined || e.occurredAt >= filter.from) &&
            (filter.to === undefined || e.occurredAt <= filter.to),
        )
        .sort((a, b) => b.seq - a.seq)
        .slice(0, filter.limit),
    drop: async () => docs.clear(),
    trim: async (channelId, before, belowSeq) => {
      let n = 0;
      for (const [id, e] of docs) {
        if (e.channelId === channelId && e.occurredAt < before && e.seq < belowSeq) {
          docs.delete(id);
          n += 1;
        }
      }
      return n;
    },
  };
  return { index, docs, bulks: () => bulks };
}
