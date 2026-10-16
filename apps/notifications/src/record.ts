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
