import { ulid } from './ulid.ts';
import { envelopeShapeErrors, validatePayload, type CheckResult } from './registry.ts';

export interface Envelope<P = Record<string, unknown>> {
  messageId: string;
  correlationId?: string;
  causationId?: string;
  type: string;               // <domain>.<action>, matches a events/<type>.payload.schema.json
  channelId: string;
  actor?: { kind: 'service' | 'user'; id: string };
  occurredAt: string;         // ISO date-time
  schemaVersion: number;
  payload: P;
}

export interface BuildEnvelopeInput<P> {
  type: string;
  channelId: string;
  payload: P;
  correlationId?: string;
  causationId?: string;
  actor?: { kind: 'service' | 'user'; id: string };
  schemaVersion?: number;
}

/** Build a fully-formed envelope (fresh messageId + occurredAt). Does not validate; call validateMessage. */
export function buildEnvelope<P extends Record<string, unknown>>(input: BuildEnvelopeInput<P>): Envelope<P> {
  return {
    messageId: ulid(),
    type: input.type,
    channelId: input.channelId,
    occurredAt: new Date().toISOString(),
    schemaVersion: input.schemaVersion ?? 1,
    payload: input.payload,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.causationId ? { causationId: input.causationId } : {}),
    ...(input.actor ? { actor: input.actor } : {}),
  };
}

/** A caused-by envelope: threads correlationId (or opens one) and sets causationId to the cause. */
export function follow<P extends Record<string, unknown>>(cause: Envelope, input: BuildEnvelopeInput<P>): Envelope<P> {
  return buildEnvelope({
    ...input,
    correlationId: input.correlationId ?? cause.correlationId ?? cause.messageId,
    causationId: cause.messageId,
  });
}

/** Full validation: envelope shape AND the payload against the type's schema. */
export function validateMessage(msg: Envelope): CheckResult {
  const shape = envelopeShapeErrors(msg);
  if (!shape.valid) return shape;
  return validatePayload(msg.type, msg.payload);
}

/** Broker subject for a message: atlas.<channel>.<type> (e.g. atlas.ch12.asset.approved). */
export const subjectFor = (channelId: string, type: string): string => `atlas.${channelId}.${type}`;
