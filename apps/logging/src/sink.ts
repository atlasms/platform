// The sink: every message on the bus, appended once.
//
// One message is one unit of work — claim the id, extend the channel's chain, append, and for an
// `audit.recorded` event project the history row — and all of it commits or none of it does. That
// is what makes "consumed at least once" become "appended exactly once": the claim and the append
// share a transaction (EP-03.3), so a crash between them rolls both back and JetStream redelivers.
//
// Malformed input is THROWN, not skipped. A message that is not an envelope, or an audit record
// that does not match its schema, will never become valid; throwing lets the broker retry and then
// dead-letter it, where `scripts/dlq.mjs` can show it to a person. Skipping it would ack a message
// the audit log then silently lacks — for a sink, the one outcome worse than a poison message.

import {
  envelopeShapeErrors,
  validatePayload,
  type Envelope,
  type EventPayloads,
} from '@atlas/contracts';
import type { Broker, Message, Subscription } from '@atlas/messaging';
import { ValidationError } from '@atlas/service-kit';
import {
  chainHash,
  GENESIS,
  historyOf,
  type AuditEvent,
  type AuditStore,
  type AuditTx,
} from './store.ts';

export type Outcome = 'appended' | 'duplicate';

export async function ingest(store: AuditStore, msg: Message): Promise<Outcome> {
  const shape = envelopeShapeErrors(msg.body);
  if (!shape.valid) {
    throw new ValidationError(
      `message ${msg.id} on ${msg.subject} is not an envelope: ${shape.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
    );
  }
  const envelope = msg.body as Envelope;

  return store.transaction(async (tx) => {
    // The broker's id, not the envelope's: it is what JetStream deduplicates on and what a
    // redelivery carries. They are the same for every producer on this platform, but the claim
    // must be keyed on the thing that comes back.
    if (!(await tx.markSeen(msg.id))) return 'duplicate';
    await appendEnvelope(tx, envelope);
    return 'appended';
  });
}

/**
 * Extend the channel's chain with one envelope and, for an `audit.recorded`, project its history
 * row — inside the caller's transaction. The sink's own path, and the one this service's OWN
 * mutations take (a retention policy, EP-19.4): the record of what the audit log's keeper changed
 * goes into the audit log directly, in the same transaction as the change, rather than out to the
 * broker and back in.
 */
export async function appendEnvelope(tx: AuditTx, envelope: Envelope): Promise<void> {
  const head = await tx.head(envelope.channelId);
  const seq = (head?.seq ?? 0) + 1;
  const prevHash = head?.hash ?? GENESIS;
  const content: Omit<AuditEvent, 'prevHash' | 'hash'> = {
    messageId: envelope.messageId,
    channelId: envelope.channelId,
    type: envelope.type,
    occurredAt: envelope.occurredAt,
    ...(envelope.actor ? { actorKind: envelope.actor.kind, actorId: envelope.actor.id } : {}),
    ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}),
    payload: envelope.payload,
    seq,
  };
  await tx.append({ ...content, prevHash, hash: chainHash(prevHash, content) });

  if (envelope.type === 'audit.recorded') {
    const check = validatePayload('audit.recorded', envelope.payload);
    if (!check.valid) {
      throw new ValidationError(
        `audit.recorded ${envelope.messageId} does not match its schema: ${check.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
      );
    }
    // Validated against its schema just above, so the narrowing is earned rather than assumed.
    await tx.appendHistory(
      historyOf(envelope as unknown as Envelope<EventPayloads['audit.recorded']>),
    );
  }
}

export interface SinkOptions {
  broker: Broker;
  store: AuditStore;
  /** Subjects to sink. Everything under the Atlas namespace by default — it is the audit sink. */
  patterns?: string[];
  /** Delivery attempts before the broker dead-letters a message this sink keeps refusing. */
  maxAttempts?: number;
  onAppended?: (subject: string) => void;
  onDuplicate?: (subject: string) => void;
  onError?: (err: unknown, msg: Message) => void;
}

export const DEFAULT_SINK_PATTERNS = ['atlas.>'];

/**
 * Subscribe the store to the broker.
 *
 * `user.>` — the private per-user streams — is deliberately NOT in the default: those carry
 * notifications addressed to a person, and the design's "essentially all events" is the domain
 * bus. Adding it is one pattern; deciding it is a privacy question.
 */
export function startSink(options: SinkOptions): Subscription[] {
  return (options.patterns ?? DEFAULT_SINK_PATTERNS).map((pattern) =>
    options.broker.subscribe(
      pattern,
      async (msg) => {
        try {
          const outcome = await ingest(options.store, msg);
          if (outcome === 'appended') options.onAppended?.(msg.subject);
          else options.onDuplicate?.(msg.subject);
        } catch (err) {
          options.onError?.(err, msg);
          throw err; // the broker's retry, then its dead-letter queue
        }
      },
      { maxAttempts: options.maxAttempts ?? 5 },
    ),
  );
}
