# `@atlas/mam`

The media asset catalogue — the first real domain service. Owns the asset aggregate, its lifecycle,
and the events every other service reacts to
([mam.md](../../docs/architecture/services/mam.md)).

## What is built

**EP-17.1** asset core + lifecycle states · **EP-17.5** the mandatory-metadata gate ·
**EP-17.6** lifecycle events through the outbox.

**Not built:** `AssetExtended` document store and FieldSchema (17.2), tags (17.3), search (17.4),
read cache (17.7), FileRef mirror of the HSM ledger (17.8). The service is deliberately narrow and
correct rather than broad and provisional.

## The lifecycle is the point

`created → processing → ready → approved`, with time-bounded validity. It lives in
[`lifecycle.ts`](src/lifecycle.ts) as pure functions over plain data, so the rules that decide
**whether media may reach air** are testable without a database or an HTTP request.

Two properties matter more than the rest, and both are asserted exhaustively:

**Every transition not in the table is refused.** A lifecycle bug is almost always a missing
refusal rather than a broken success path, and an asset that reaches `approved` without review is
an asset that can reach air without review. The test enumerates all six states × six actions and
requires a refusal for every pair the design does not name.

**`approved` alone does not mean schedulable.** An approved asset past its `expiresAt` is unusable
even before the expiry sweep runs. Reading the stored state on its own would let lapsed media air
during that window — so `isSchedulable()` checks the clock, not just the field.

The state diagram also shows `Replaced` and `Purged`, but the `state` enum in the data model has
six values and excludes them. They are modelled as what they actually are: replacement mints a new
asset id (`replacesId`), purging deletes the record. Neither is a state an asset sits in.

## Two things the wire cannot do

**Set `state`.** Lifecycle moves only through explicit transition endpoints, each with its own
guard, permission and event. `PATCH` runs through an **allowlist** of updatable fields — not the
caller's object, and not a denylist. `UpdateAssetInput` omits `state`, but a TypeScript type is
erased at runtime and the body arrives as JSON; a test posts `{"state":"approved"}` and asserts it
is ignored.

**Cross a channel.** Every read is filtered and every authorization carries the caller's
`channelId`. An asset in another tenant reads as **404, not 403** — "you may not see this"
confirms the asset exists, which is itself the leak.

Approving is a **separate permission** from writing: someone who may edit metadata is not thereby
entitled to sign an asset off for air.

## Events

Emitted through the transactional outbox, in the same transaction as the state change — so the
record and its announcement commit together or neither does.

Payloads are validated against the **shipped schemas** before they are stored, not on the way out:
an invalid payload sitting in the outbox is a poison message that fails every drain forever, long
after the transaction that could have rejected it committed.

That validation earned its keep immediately — the contracts require more than an asset id. An
approval names its **approver**, a rejection states its **reason**, an expiry records **when**.
Those are the events a compliance record is reconstructed from, and _"asset 42 was rejected"_ with
no author and no cause is not a record of anything. Rejecting without a reason is now a 422.
