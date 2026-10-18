# Changelog — `@atlas/contracts`

The contract surface is **the package's exports AND the schemas it loads at runtime** from
[`docs/architecture/schemas/`](../../docs/architecture/schemas/) — a field renamed in a payload
schema breaks a consumer exactly as a renamed export does, so both are versioned here. The format is
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the versions are
[Semantic Versioning](https://semver.org/spec/v2.0.0.html), and while the major is `0`, a **minor**
bump is the breaking one (semver §4) — say so with a **Breaking** line.

What goes where (EP-02.6):

- **Breaking** — a field or event removed or renamed, a required field added, an enum value removed,
  an export's signature changed. Minor bump while `0.x`; major afterwards.
- **Added** — a new event, field, `$def`, export. Minor bump.
- **Changed / Fixed** — a description, a looser constraint, a bug in a validator. Patch bump.

CI refuses a pull request that touches `libs/contracts/src/` or a `*.schema.json` without touching
this file (`scripts/check-changelog.mjs`). The version in `package.json` moves when
`[Unreleased]` becomes a release — the consumers pin nothing yet (`"*"` in the workspace), so a
release is a statement of what changed, not a deploy step.

## [Unreleased]

### Added

- `asset.approved`, `asset.rejected` and `asset.expired` carry `createdBy` and `categoryPath`, and
  `transcode.failed` carries `requestedBy` (EP-25.5): who Notifications tells, and what that person
  must be able to read to be told. **Breaking** in deployment order: those payloads are
  `additionalProperties: false` and every consumer validates them, so a consumer still on the
  previous contracts (Scheduling, logging, Notifications, BMS) refuses the new events until it is
  upgraded — roll consumers out before MAM and MTS (found on a partly-upgraded kind cluster).

- `asset.expired` is in `WORKFLOW_TRIGGERS` (EP-22.10): a workflow may start on an approval lapsing —
  the `re-review-on-expiry` preset does.

- `workflow.task.resolved` gains `state` (`done` | `cancelled`; absent = done) and `reason` (EP-22.9):
  BMS cancels a workflow's task when its step times out or its run fails. `outcome` is no longer
  required — a cancellation has none. **Breaking** for a consumer that read `outcome` unconditionally.
- `validateDefinition` refuses `retry` on a step that is not a command (`RETRY_NOT_COMMAND`), and
  counts an `onError.transitionTo` target and a `compensation` handler as reachable — an error path
  was called unreachable before.

- `WORKFLOW_TRIGGERS` in `@atlas/contracts/workflow` (EP-22.7): the closed list of events that may
  start a workflow — `ingest.accepted`. `validateDefinition` refuses any other (`UNKNOWN_TRIGGER`).
  **Breaking** for a draft whose start triggers on another event: it no longer publishes.
- `StartConfig.trigger.output` (the workflow-definition schema): maps the triggering event into vars.

- `WORKFLOW_EVENTS` and `REVIEW_VERDICTS` in `@atlas/contracts/workflow` (EP-22.6): the closed list of
  events a wait-event step may wait for, and the two verdict events that resolve a review step.
- `@atlas/contracts/workflow-correlate` (`correlationKeys`): a wait-event's `correlate` read as
  equality keys — a subpath that loads in Temporal's workflow sandbox (FEEL's parser only).
- `validateDefinition` refuses `UNKNOWN_EVENT`, `CORRELATE_SHAPE`, `CORRELATE_FIELD`,
  `REVIEW_TASK_TYPE` and `DUP_REVIEW_POINT`. **Breaking** for a draft with a free-form `correlate`
  (e.g. `= true`) or an unlisted wait-event `event`: it no longer publishes.
- `workflow.task.created.reviewPointId` — a review step's task names its point.
- `workflow.task.resolved` — BMS closes a workflow's task that something other than its completion
  ended (a review's verdict); Notifications consumes it.

- `PrincipalKind` gains `role` (EP-25.1, decided 2026-10-16): a workflow's human step offers a task to
  everyone holding a role, resolved to people when an inbox is read. A consumer that switched on
  `user | group` must handle it.
- `workflow.task.created.assigneeKind` — what `assignee` names (user, group or role). Absent means a
  user, which is what BMS sent before it said.
- `WORKFLOW_COMMANDS` and `commandAnswers()` in `@atlas/contracts/workflow` (EP-22.4): the closed list
  of commands a workflow's command step may issue, each with the events that complete and fail it,
  and `requires` — the authority it exercises, which whoever publishes or activates the workflow must
  hold (a command step carries its publisher's authority, decided 2026-10-16).
- `payloadShape(type)`: an event payload's top-level fields and its required ones.
- `transcode.job.create` takes `inputFile` (`{ kind, variant? }`, the asset's file in HSM) as the
  alternative to `inputPath`, and its description says how it is answered.
- `@atlas/contracts/workflow-types` (EP-22.11): the workflow DSL's TYPES alone (`src/workflow/types.ts`),
  a browser-safe subpath — `@atlas/contracts/workflow` brings the validator, ajv and `node:fs` with
  it. Studio's generated BMS types import `WorkflowDefinition` from it rather than re-deriving the
  domain schema the contract references.
- `workflow.changed` (EP-22.11): BMS emits it whenever the channel's workflow catalog changes —
  `change` (published / activated / deactivated / archived), the `state` after it, `latestVersion`,
  `revision`. Every user's client refreshes its copy of the catalog on it. Both enums are Tier 0.

### Fixed

- The generated payload types read an object schema with no `additionalProperties` keyword as
  CLOSED (`Record<string, never>`); JSON Schema's default is open. `workflow.step.requested`'s
  free-form `params` — the one such field — is now `Record<string, unknown>`, so a producer can put
  something in it (EP-22.3, BMS's first emitter). Only an explicit `additionalProperties: false`
  closes an object. Types only; no schema changed.

### Breaking

- `validateDefinition` (EP-22.4) refuses a command step that issues anything but a command in
  `WORKFLOW_COMMANDS` (`UNKNOWN_COMMAND`), names an input that is not a field of the command or omits a
  required one (`COMMAND_INPUT`), awaits an event that does not answer it (`AWAIT_EVENT`), or sets
  `await.correlate` (`CORRELATE_UNSUPPORTED`). A definition that published before can be refused now —
  BMS checks at publish, so what is already published keeps running. The presets moved with it:
  `simple-approval` no longer has a publish step, and `post-approval-distribution` is refused until
  EP-37 adds the publishing commands.
- `recording.segment.completed` (EP-39; ADR-0007) now describes a recorder's FILE as it is handed
  over: `captureId`, `jobId`, `fileStart`/`fileEnd`, `part`, `partial`, `sizeBytes` and `checksum`
  are required; `index` and `path` are gone — a file is named by its grid slot and part, and the
  staging path is never on the wire. No producer existed before this change, so no consumer can
  have depended on the old shape.

### Changed

- `person.created` (EP-28.5): the description says what is sent — a name and whether there is an
  image; a person has no role of their own (roles are per asset, on its cast), so `roleInMedia` is
  not sent. The field stays optional; the payload is unchanged.
- `schedule.validated` (EP-31): the `availability` issue kind is now produced — the rendition an
  item airs is not online, intact and the channel's in HSM; the description says what `rights` and
  `availability` mean instead of what they waited for.
- `alert.raised` is emitted by the service watching the condition, not only Logging & Analytics:
  RIM raises `recording-missed` (critical) and `recording-partial` (warning) for a hole in a
  recording (EP-39). Description only; the payload is unchanged.

### Added

- `@atlas/contracts/workflow` (EP-22.2) — a subpath export, so FEEL's parser loads only where
  workflows are read: the workflow DSL's types (`WorkflowDefinition`, `Step`, the step configs),
  `validateDefinition` (the `workflow-definition` schema, the graph rules of the DSL doc §6, and
  every expression held to the **restricted FEEL subset** decided for EP-23.6 — `FEEL_SUBSET` names
  the refused construct), `feelProblem`, `referencedVars`, `FEEL_ROOTS`, `FEEL_FUNCTIONS`. Lifted
  from `reference/bms-workflow`; new dependency `feelin`.
- `asset.approved` (EP-28.7): optional `automatic` — MAM approved the asset itself, its category
  chain saying `reviewNeeded: false`; the approver is then `mam` and the envelope's actor a service.
- `RoleClass` (EP-28.5): a shared Tier-0 `$def` — `on-screen` | `crew` — exported with the other
  shared types; `vocabulary-term` carries it as `roleClass`, for `cast-role` terms only.
- `taxonomy.updated` (EP-28.3): `kind` takes the flat vocabularies MAM now manages — `genre`,
  `supply-type`, `production-group`, `cast-role` — beside the existing ones.
- `vocabulary-term` (EP-28.3): `version`, for the compare-and-set on update and merge; `createdBy`
  is a user id as text, not a ULID (IAM's ids are not all ULIDs).
- `taxonomy.updated` carries an optional `path` (#260): for a category, its materialized path after
  the change — a consumer that keys anything by category path learns a move without a fetch.
- `ingest.detected` carries `ingestJobId` (EP-21.1): the job the detection created. Without it a
  live view of the ingest queue could not tell which row a detection was — the MVP acceptance
  journey waited for its upload's detection on the socket and had nothing to match it by.
- `ingest.accepted` carries what MAM needs to create the asset and what MTS needs to choose its
  first renditions (EP-15.5): `ingestJobId`, `sourceKind`, `filename`, `sizeBytes`, `title`,
  `mediaType`, `fileType`, `createdBy`. Optional; RIM is its first producer. Its description now says
  when it is emitted: once the original is in HSM, in the transaction that marks the job registered.
- `file.placed` carries `fileId`, `variant` and `sizeBytes`, and `file.moved` carries `fileId` and
  `variant` (EP-14; ADR-0009) — the ledger row and what tells two files of one kind apart, so MAM's
  mirror lands a placement or a move on the right row. Optional; HSM is their first producer.
- `asset.updated` carries `expiresAt` (a date-time, or null when cleared) exactly when
  `changedFields` names it — the one lifecycle value a metadata edit changes, so Scheduling's record
  of approvals (EP-31) never has to read it back from MAM. Optional; nothing else changes.
- `schedule.validated` gains the `approval` issue kind (the media is not approved in the channel)
  and an optional `version` (the schedule version validated). The kinds are reordered by what each
  validator reads; no value was removed.
- `liveSubjectFor(channelId, type)` → `live.<channelId>.<type>`: the subject of a PROGRESS message,
  outside the durable stream's `atlas.>` so it is never stored, replayed or audited (messaging §1.1,
  EP-16.4). First user: `transcode.progress`.

## [0.2.0] — 2026-09-13

### Breaking

- `permissions.changed` — `permissionVersion` renamed to **`permVersion`**, the name FR-IAM-14, the
  JWT claim, the internal header and every consumer already used (EP-02.3). The event had no
  producer at the time; it has one since EP-10.6.
- `config.changed` and the other events whose enums were inlined now `$ref` the shared `$defs` in
  `common.schema.json` (EP-02.5). Same values — `SettingScope`, `Tier`, task kinds — one definition;
  a consumer that imported the inline enum type imports the shared one.

### Added

- **`audit.recorded`** event: `{ entityType, entityId, revision, action, origin: { service }, delta }`
  — every mutation's field-level before/after, in the write's own transaction (EP-19.2).
- **`delta(before, after)`** and the `Delta` type — the diff every producer of `audit.recorded`
  uses, moved here from MAM when Scheduling became the second producer (EP-18).
- **Generated payload types** (`EventPayloads['asset.created']`, `EventType`) projected from the
  same schema files the validators load; `npm run api:check` fails CI on drift (EP-02.3).
- **Tier-0 enums as values**: `TierValues`, `SettingScopeValues`, … with the type derived
  (EP-02.5). Every schema `enum` is inventoried in `tier0-enums.json`; `tier0:check` holds it.
- `gateway.access.logged` — `route` (the matched prefix, bounded) and `traceId` (a W3C trace id,
  `^[0-9a-f]{32}$`) (EP-08.6).
- `setting-descriptor` — the scope enum is the shared `SettingScope` (EP-06).

## [0.1.0] — 2026-07-31

### Added

- Lifted from `reference/contracts` into the workspace as its first package (EP-02.1).
- `buildEnvelope`, `follow`, `validateMessage`, `subjectFor` — the envelope built and validated
  against `envelope.schema.json`; `validatePayload` for every one of the 53 event payloads, keyed
  by type; `validateDomain` for the domain schemas; `ulid`/`isUlid`; `EVENT_TYPES`,
  `DOMAIN_SCHEMAS`, `isEventType` (EP-02.2).

[Unreleased]: https://github.com/atlasms/platform/compare/contracts-v0.2.0...HEAD
[0.2.0]: https://github.com/atlasms/platform/compare/contracts-v0.1.0...contracts-v0.2.0
[0.1.0]: https://github.com/atlasms/platform/commit/53d8e9b
