# Event Payload Schemas

> Machine-readable **JSON Schema** (draft 2020-12) contracts for the messages on the Atlas
> broker. These make the [Event Catalog](../04-messaging-and-data.md#3-event-catalog-core)
> executable: producers validate what they emit, consumers validate what they receive, and CI
> can diff contracts across versions.
>
> Parent: [Messaging & Data Model](../04-messaging-and-data.md). Sync API contracts live in
> [../openapi/](../openapi/).

## Layout

```
schemas/
  envelope.schema.json        # the wrapper every message shares
  common.schema.json          # reusable $defs (Ulid, Checksum, Tier, Rendition, …)
  workflow-definition.schema.json   # domain contract (not an event): the BMS workflow graph
  events/
    <domain>.<entity>.<action>.payload.schema.json   # one payload contract per event
```

**Non-event domain contracts** (stored/served, not broker messages):

- [`workflow-definition.schema.json`](workflow-definition.schema.json) — the versioned,
  BPMN-2.0-convertible graph the Studio designer edits and the BMS engine executes. Design:
  [BMS Workflow DSL, Designer, Engine & BPMN Converter](../bms-workflow-dsl-and-designer.md).
- [`policy-rule.schema.json`](policy-rule.schema.json) — the atomic authorization **grant**
  (permissions + scope + field groups), evaluated by the shared evaluator on **both** the server and
  Studio. Design: [Authorization Model](../authorization-model.md).
- [`file.schema.json`](file.schema.json) — a physical **file** with its technical info, integrity
  checksum, storage location/tier/status and provenance; belongs to **exactly one** asset.
  Design: [Data Model §1.5](../data-model.md#15-files).
- [`setting-descriptor.schema.json`](setting-descriptor.schema.json) — declares an **admin-editable
  runtime setting** (type, bounds, default, scope, sensitivity). The descriptor ships with the code
  that reads it; only the **value** is stored. Studio generates the admin UI from these. Design:
  [Configuration & Reference Data §2.4](../configuration-and-reference-data.md#24-tier-3--settings-descriptor-in-code-value-in-data).
- [`vocabulary-term.schema.json`](vocabulary-term.schema.json) — one entry in an operator-managed
  **controlled vocabulary** (classification, subject, structure, tag, cast role, …). Stable `id`,
  mutable labels, deprecate-never-delete. Design:
  [Configuration & Reference Data §2.3](../configuration-and-reference-data.md#23-tier-2--vocabularies-pure-data).

- **A whole message** = the [envelope](envelope.schema.json) with `type` set to the event name
  and `payload` conforming to the matching `events/*.payload.schema.json`.
- The payload files describe **only the `payload`** — exactly "the event payloads". The
  envelope fields (`messageId`, `correlationId`, `channelId`, `occurredAt`, `schemaVersion`, …)
  are validated once by the envelope schema.
- `$ref`s resolve by `$id`: payload files reference `../common.schema.json#/$defs/...`.

## Conventions

- **Draft 2020-12**; each file has a stable `$id` under `https://atlas.example/schemas/`
  (swap the host for your registry).
- **`additionalProperties: false`** on payloads makes each file a *precise producer contract*
  for its current `schemaVersion`. Runtime **consumers stay tolerant readers** — they ignore
  unknown fields ([Messaging §1.3](../04-messaging-and-data.md#13-message-envelope)); additive
  fields bump `schemaVersion` rather than breaking consumers.
- **Ids** are ULIDs (`common.schema.json#/$defs/Ulid`); enums (`Tier`, `RenditionKind`) live in
  `common` so they can't drift between events.
- **`enum` is reserved for values code branches on** — "Tier 0" in
  [Configuration & Reference Data](../configuration-and-reference-data.md#2-the-four-tiers). A
  **operator-editable** list (classifications, subjects, media types, transcode profiles, …) is
  **never** an `enum` here, or every admin edit becomes a contract change and a redeploy. Model it as
  `{ "type": "string", "x-atlas-vocabulary": "<name>" }` and validate against the cached reference
  snapshot at runtime.
- **Commands** (e.g. `transcode.job.create`) use the same envelope + payload pattern; they are
  point-to-point rather than broadcast ([Messaging §1](../04-messaging-and-data.md#1-messaging-model)).

## Index

| Event / command | Emitter | Payload schema |
|-----------------|---------|----------------|
| `ingest.detected` | RIM | [ingest.detected](events/ingest.detected.payload.schema.json) |
| `ingest.accepted` | RIM | [ingest.accepted](events/ingest.accepted.payload.schema.json) |
| `ingest.rejected` | RIM | [ingest.rejected](events/ingest.rejected.payload.schema.json) |
| `recording.segment.completed` | RIM | [recording.segment.completed](events/recording.segment.completed.payload.schema.json) |
| `transcode.job.create` *(cmd)* | BMS/RIM | [transcode.job.create](events/transcode.job.create.payload.schema.json) |
| `transcode.started` | MTS | [transcode.started](events/transcode.started.payload.schema.json) |
| `transcode.progress` | MTS | [transcode.progress](events/transcode.progress.payload.schema.json) |
| `transcode.completed` | MTS | [transcode.completed](events/transcode.completed.payload.schema.json) |
| `transcode.failed` | MTS | [transcode.failed](events/transcode.failed.payload.schema.json) |
| `asset.created` | MAM | [asset.created](events/asset.created.payload.schema.json) |
| `asset.updated` | MAM | [asset.updated](events/asset.updated.payload.schema.json) |
| `asset.ready` | MAM | [asset.ready](events/asset.ready.payload.schema.json) |
| `asset.approved` | MAM | [asset.approved](events/asset.approved.payload.schema.json) |
| `asset.rejected` | MAM | [asset.rejected](events/asset.rejected.payload.schema.json) |
| `asset.expired` | MAM | [asset.expired](events/asset.expired.payload.schema.json) |
| `asset.replaced` | MAM | [asset.replaced](events/asset.replaced.payload.schema.json) |
| `asset.deleted` | MAM | [asset.deleted](events/asset.deleted.payload.schema.json) |
| `person.created` | MAM | [person.created](events/person.created.payload.schema.json) |
| `person.linked` | MAM | [person.linked](events/person.linked.payload.schema.json) |
| `taxonomy.updated` | MAM | [taxonomy.updated](events/taxonomy.updated.payload.schema.json) |
| `ai.suggestion.raised` | AI | [ai.suggestion.raised](events/ai.suggestion.raised.payload.schema.json) |
| `file.placed` | HSM | [file.placed](events/file.placed.payload.schema.json) |
| `file.moved` | HSM | [file.moved](events/file.moved.payload.schema.json) |
| `restore.completed` | HSM | [restore.completed](events/restore.completed.payload.schema.json) |
| `checksum.verified` | HSM | [checksum.verified](events/checksum.verified.payload.schema.json) |
| `checksum.mismatch` | HSM | [checksum.mismatch](events/checksum.mismatch.payload.schema.json) |
| `playout.export.completed` | HSM | [playout.export.completed](events/playout.export.completed.payload.schema.json) |
| `workflow.step.requested` | BMS | [workflow.step.requested](events/workflow.step.requested.payload.schema.json) |
| `workflow.task.created` | BMS | [workflow.task.created](events/workflow.task.created.payload.schema.json) |
| `workflow.completed` | BMS | [workflow.completed](events/workflow.completed.payload.schema.json) |
| `editor.render.requested` *(cmd)* | Studio/BFF | [editor.render.requested](events/editor.render.requested.payload.schema.json) |
| `schedule.updated` | Scheduling | [schedule.updated](events/schedule.updated.payload.schema.json) |
| `schedule.validated` | Scheduling | [schedule.validated](events/schedule.validated.payload.schema.json) |
| `schedule.sent-to-air` | Scheduling | [schedule.sent-to-air](events/schedule.sent-to-air.payload.schema.json) |
| `user.created` | IAM | [user.created](events/user.created.payload.schema.json) |
| `user.updated` | IAM | [user.updated](events/user.updated.payload.schema.json) |
| `group.membership.changed` | IAM | [group.membership.changed](events/group.membership.changed.payload.schema.json) |
| `permissions.changed` | IAM | [permissions.changed](events/permissions.changed.payload.schema.json) |
| `config.changed` | any owning service | [config.changed](events/config.changed.payload.schema.json) |
| `message.sent` | Notifications | [message.sent](events/message.sent.payload.schema.json) |
| `notification.raised` | Notifications | [notification.raised](events/notification.raised.payload.schema.json) |
| `task.created` | Notifications | [task.created](events/task.created.payload.schema.json) |
| `task.updated` | Notifications | [task.updated](events/task.updated.payload.schema.json) |
| `feed.item.received` | Integration | [feed.item.received](events/feed.item.received.payload.schema.json) |
| `publish.completed` | Integration | [publish.completed](events/publish.completed.payload.schema.json) |
| `publish.failed` | Integration | [publish.failed](events/publish.failed.payload.schema.json) |
| `story.updated` | Newsroom | [story.updated](events/story.updated.payload.schema.json) |
| `rundown.updated` | Newsroom | [rundown.updated](events/rundown.updated.payload.schema.json) |
| `rundown.ready` | Newsroom | [rundown.ready](events/rundown.ready.payload.schema.json) |
| `ai.enrichment.completed` | AI | [ai.enrichment.completed](events/ai.enrichment.completed.payload.schema.json) |
| `ai.enrichment.failed` | AI | [ai.enrichment.failed](events/ai.enrichment.failed.payload.schema.json) |
| `alert.raised` | Logging | [alert.raised](events/alert.raised.payload.schema.json) |
| `gateway.access.logged` | API Gateway | [gateway.access.logged](events/gateway.access.logged.payload.schema.json) |

> Every event named in a [service spec](../services/) now has a payload schema here. New events
> follow the same envelope + payload pattern and are added to this table when introduced.

## Tooling

- Validate with any 2020-12 validator — e.g. **Ajv** (`ajv-cli`) in Node:
  `ajv validate -s events/ingest.accepted.payload.schema.json -d sample.json --spec=draft2020`.
- Load `common.schema.json` + `envelope.schema.json` as referenced schemas so `$ref`s resolve.
- These schemas are the source of truth for generated TypeScript types (e.g.
  `json-schema-to-typescript`) shared across services and Studio
  ([A2](../../README.md#assumptions-register)).

---
_Back to [Messaging & Data Model](../04-messaging-and-data.md) ·
[documentation index](../../README.md)._
