# @atlas/contracts — executable message contracts

Makes the [event schemas](../../docs/architecture/schemas) runnable: an envelope builder/validator
and a payload validator for **every** event, keyed by type. This is the single source of
cross-service truth (system plan §3.1).

## API

```ts
import { buildEnvelope, follow, validateMessage, validatePayload, subjectFor, ulid, EVENT_TYPES } from '@atlas/contracts';

const msg = buildEnvelope({ type: 'asset.approved', channelId: 'ch12',
  payload: { assetId: ulid(), approver: 'user-1', approvedAt: new Date().toISOString() } });
validateMessage(msg);                    // { valid, errors } — shape + payload vs the type's schema
subjectFor('ch12', msg.type);            // "atlas.ch12.asset.approved"
const next = follow(msg, { type: 'schedule.updated', channelId: 'ch12', payload: {/*…*/} }); // threads correlation+causation
```

- `buildEnvelope` mints `messageId` (ULID) + `occurredAt`; `follow` threads `correlationId`/`causationId`.
- `validatePayload(type, payload)` and `validateMessage(envelope)` compile from the real schema files;
  `EVENT_TYPES` is discovered from `events/*.payload.schema.json`, so new events are picked up with no code change.

## Run

```bash
npm install && npm test   # 8 tests
```

## Tests prove

- every `events/*.payload.schema.json` loads and is keyed by type; `EVENT_TYPES` is populated;
- `ulid()` output matches the schema's ULID pattern;
- `buildEnvelope → validateMessage` round-trips for a real event; a payload missing a required field
  and an unknown event type are rejected; `follow` threads correlation + causation; `subjectFor` is correct.

## Note — a schema bug this surfaced

The envelope's `type` pattern required **three** dotted tokens, but every event (`asset.approved`,
`transcode.completed`) uses **two** — it would have rejected all real messages. Fixed in
[`envelope.schema.json`](../../docs/architecture/schemas/envelope.schema.json) to accept the canonical
2-token names (matching the messaging doc's own example).
