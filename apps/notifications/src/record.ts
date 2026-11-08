// One outbox record: a validated payload in an envelope, addressed to its subject. Every write
// Notifications makes goes out this way, in the transaction of the change (AGENTS.md §5.4).
import { buildEnvelope, subjectFor, validatePayload, type Envelope } from '@atlas/contracts';
import type { OutboxRecord } from '@atlas/messaging';
import { ValidationError } from '@atlas/service-kit';

export interface RecordOptions {
  actor: { kind: 'user' | 'service'; id: string };
  correlationId?: string;
  /** The message this write answers (EP-03.5's follow()). */
  causationId?: string;
}

export function outboxRecord(
  type: string,
  channelId: string,
  payload: object,
  options: RecordOptions,
): OutboxRecord {
  const check = validatePayload(type, payload);
  if (!check.valid) {
    throw new ValidationError(
      `${type} payload does not match its schema: ${check.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
    );
  }
  const envelope: Envelope = buildEnvelope({
    type,
    channelId,
    payload: payload as Record<string, unknown>,
    actor: options.actor,
    ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
    ...(options.causationId !== undefined ? { causationId: options.causationId } : {}),
  });
  return {
    id: envelope.messageId,
    message: { id: envelope.messageId, subject: subjectFor(channelId, type), body: envelope },
  };
}

/**
 * `inbox.changed` for each PERSON whose inbox a change touched (EP-25.7) — one record per distinct,
 * non-empty user id, in the change's own transaction. The WebSocket service delivers each only to
 * that user's connections (a personal domain, websocket.md §5); it carries what changed, never its
 * content, so the client re-reads through the API, which enforces who may read what. A recipient
 * reached through a group or a role is not resolved here: those rows reach their readers by polling.
 */
export function inboxChanged(
  channelId: string,
  recipients: readonly (string | undefined)[],
  change: { kind: 'task' | 'message' | 'notification'; id: string; at: string },
  options: RecordOptions,
): OutboxRecord[] {
  const people = [
    ...new Set(recipients.filter((r): r is string => typeof r === 'string' && r !== '')),
  ];
  return people.map((recipientUserId) =>
    outboxRecord('inbox.changed', channelId, { recipientUserId, ...change }, options),
  );
}
