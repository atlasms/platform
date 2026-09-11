// The audit store: a port with two adapters (node:sqlite for tests, Postgres for production), held
// to one conformance suite — the same shape as MAM's AssetStore, for the same reason.
//
// Two tables, one purpose. `audit_events` is the append-only log of EVERY envelope the sink sees,
// hash-chained per channel so the log itself is trustworthy (logging-analytics.md §3: "append-only
// and tamper-evident"). `entity_history` is the projection of `audit.recorded` events — one row per
// (entityType, entityId, revision) — that `GET /history/{entityType}/{id}` reads (§6.4).
//
// Append-only is enforced in the database, not by convention: both adapters install triggers that
// refuse UPDATE and DELETE on `audit_events`. A compliance record that the service's own code could
// rewrite is not a record.

import { createHash } from 'node:crypto';
import type { Envelope, EventPayloads } from '@atlas/contracts';

/** One envelope, as appended. `seq`, `prevHash` and `hash` are the chain. */
export interface AuditEvent {
  messageId: string;
  channelId: string;
  type: string;
  occurredAt: string;
  actorKind?: 'service' | 'user';
  actorId?: string;
  correlationId?: string;
  payload: unknown;
  /** Position in this channel's chain, 1-based and gapless. */
  seq: number;
  /** The previous record's hash in this channel; the genesis value for the first. */
  prevHash: string;
  hash: string;
}

/** One revision of one entity, projected from `audit.recorded`. */
export interface HistoryEntry {
  channelId: string;
  entityType: string;
  entityId: string;
  revision: number;
  action: string;
  actorKind?: 'service' | 'user';
  actorId?: string;
  at: string;
  correlationId?: string;
  delta: EventPayloads['audit.recorded']['delta'];
  /** The envelope this came from — a deep link back into the log. */
  messageId: string;
}

/** The last link of a channel's chain, or nothing when the channel has no records yet. */
export interface ChainHead {
  seq: number;
  hash: string;
}

export interface AuditStore {
  /** The unit of work. Everything a consumer does for one message happens inside ONE of these. */
  transaction<T>(fn: (tx: AuditTx) => Promise<T>): Promise<T>;
  history(channelId: string, entityType: string, entityId: string): Promise<HistoryEntry[]>;
  /** Every record in a channel, in chain order — what `verifyChain` walks. */
  chain(channelId: string): Promise<AuditEvent[]>;
  count(): Promise<{ events: number; history: number }>;
  close(): Promise<void>;
}

export interface AuditTx {
  /**
   * Claim the message id, IN this transaction (EP-03.3). `false` means it was already consumed and
   * the caller must do nothing. Because the claim commits with the append — or rolls back with it —
   * a crash between the two cannot lose a message or double-append one.
   */
  markSeen(messageId: string): Promise<boolean>;
  head(channelId: string): Promise<ChainHead | undefined>;
  append(event: AuditEvent): Promise<void>;
  appendHistory(entry: HistoryEntry): Promise<void>;
}

/** What the first record in a channel chains from. Fixed, so a chain is verifiable from nothing. */
export const GENESIS = 'atlas-audit-genesis';

/**
 * The link. SHA-256 over the previous hash and the record's canonical form — canonical, so the
 * same record always hashes the same whatever key order the driver returned it in.
 */
export function chainHash(prevHash: string, event: Omit<AuditEvent, 'prevHash' | 'hash'>): string {
  return createHash('sha256').update(prevHash).update('\n').update(canonical(event)).digest('hex');
}

/** JSON with keys sorted at every level. `undefined` fields are dropped, as JSON.stringify does. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}

/**
 * Walk a channel's chain and say whether it is intact.
 *
 * Every link is recomputed from its predecessor and its own content. A record altered in place, a
 * record removed, or a record inserted out of order breaks every hash after the tampering point —
 * which is what makes the log evidence rather than data.
 */
export function verifyChain(
  events: readonly AuditEvent[],
): { ok: true } | { ok: false; atSeq: number; reason: string } {
  let prev = GENESIS;
  let expectedSeq = 1;
  for (const e of events) {
    if (e.seq !== expectedSeq)
      return { ok: false, atSeq: e.seq, reason: `expected seq ${expectedSeq}` };
    if (e.prevHash !== prev)
      return { ok: false, atSeq: e.seq, reason: 'prevHash does not match the previous record' };
    const { prevHash: _p, hash: _h, ...content } = e;
    const recomputed = chainHash(prev, content);
    if (e.hash !== recomputed)
      return { ok: false, atSeq: e.seq, reason: 'hash does not match the record content' };
    prev = e.hash;
    expectedSeq++;
  }
  return { ok: true };
}

/** The projection from an `audit.recorded` envelope to a history row. */
export function historyOf(envelope: Envelope<EventPayloads['audit.recorded']>): HistoryEntry {
  const p = envelope.payload;
  return {
    channelId: envelope.channelId,
    entityType: p.entityType,
    entityId: p.entityId,
    revision: p.revision,
    action: p.action,
    ...(envelope.actor ? { actorKind: envelope.actor.kind, actorId: envelope.actor.id } : {}),
    at: envelope.occurredAt,
    ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}),
    delta: p.delta,
    messageId: envelope.messageId,
  };
}
