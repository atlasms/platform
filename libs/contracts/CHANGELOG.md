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

### Breaking

- `recording.segment.completed` (EP-39; ADR-0007) now describes a recorder's FILE as it is handed
  over: `captureId`, `jobId`, `fileStart`/`fileEnd`, `part`, `partial`, `sizeBytes` and `checksum`
  are required; `index` and `path` are gone — a file is named by its grid slot and part, and the
  staging path is never on the wire. No producer existed before this change, so no consumer can
  have depended on the old shape.

### Changed

- `alert.raised` is emitted by the service watching the condition, not only Logging & Analytics:
  RIM raises `recording-missed` (critical) and `recording-partial` (warning) for a hole in a
  recording (EP-39). Description only; the payload is unchanged.

### Added

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
