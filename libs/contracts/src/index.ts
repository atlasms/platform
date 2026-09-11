export { ulid, isUlid, ULID_RE } from './ulid.ts';
export {
  EVENT_TYPES,
  isEventType,
  validatePayload,
  envelopeShapeErrors,
  type CheckResult,
} from './registry.ts';
export {
  buildEnvelope,
  follow,
  validateMessage,
  subjectFor,
  type Envelope,
  type BuildEnvelopeInput,
} from './envelope.ts';
// EP-02.3 — every event payload as a type, generated from the same schemas the validators load.
// `EventPayloads['asset.created']` is the payload of that event; `EventType` is the closed set.
export type * from './generated/events.ts';
