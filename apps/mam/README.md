# `@atlas/mam`

The media asset catalogue — the first real domain service. Owns the asset aggregate, its lifecycle,
and the events every other service reacts to
([mam.md](../../docs/architecture/services/mam.md)).

## What is built

**EP-17.1** asset core + lifecycle states · **EP-17.2** extensible metadata (AssetExtended +
FieldSchema) · **EP-17.3** free-form tags · **EP-17.4** simple search · **EP-17.5** the
mandatory-metadata gate · **EP-17.6** lifecycle events through the outbox.

**Not built:** read cache (17.7), FileRef mirror of the HSM ledger (17.8), and the _faceted_ half
of search. The service is deliberately narrow and correct rather than broad and provisional.

## Extensible metadata

The core `Asset` holds what **every** asset has. Anything that depends on what _kind_ of thing it
is — a match's competition, a documentary's rights window — is defined by operators as a
[FieldSchema](src/field-schema.ts) and stored per asset as a document.

Field **types** are a closed set and that is deliberate: the validator and the form renderer each
switch on them, so they are Tier 0 — adding one is a pull request, not an operator edit
([configuration-and-reference-data.md §2.1](../../docs/architecture/configuration-and-reference-data.md)).
Everything else about a field is operator-managed. A `vocabulary` field names a controlled list
rather than enumerating its terms, because enumerating them would make every admin edit a contract
change and a redeploy.

Schemas **merge**, keyed by `mediaType` and optionally narrowed by a category **prefix**, with the
more specific one winning a name collision — so a branch can tighten an inherited field without
restating everything above it. Prefix matching is segment-safe: `/sports/foot` does not match
`/sports/football/`, the same hazard the policy evaluator has.

**Required extended fields block `markReady`.** This is where FR-MAM-2 meets FR-MAM-5 — without it,
"required" is a label on a form and an asset reaches air missing metadata someone declared
mandatory. Extended names are namespaced (`extended.title`) in the gate, because an operator may
legitimately define a field called `title` and the core one must not be allowed to satisfy it.

Three failure modes are handled the way that is safe rather than the way that is convenient:

- **An unknown field is refused, not stored.** A typo that silently becomes data is a value nothing
  renders, nothing searches, and nobody discovers until they ask where their input went.
- **A vocabulary whose terms are not loaded makes its fields unwritable.** Accepting a term nobody
  could check defeats the point of the list being controlled, and the value would sit in the
  document looking validated.
- **Removing a field orphans its data rather than destroying it.** An operator dropping a field is
  usually reorganising, and there is no undo. Validation is therefore _partial_ — only what is being
  written is checked — because validating the whole stored document would make an asset unsavable
  the moment a field it still holds a value for disappears.

## Free-form tags

Tags are the one classification axis with no controlled vocabulary behind it: an editor types a
keyword and it exists ([FR-TAX-1](../../docs/requirements/05-functional-requirements.md#classification)).
That is the point of them, and it is also the entire difficulty — the only thing between "ad-hoc
labelling" and an unusable cloud of near-duplicates is how a typed string is folded into an
identity. [`tag.ts`](src/tag.ts) is where that happens, and it is pure: no adapter normalizes
anything, so the two stores cannot disagree about what "the same tag" means.

A tag has a **label** (as first typed, and what Studio displays) and a **normalized** form (what
decides sameness within a channel). Folding is NFC → strip invisible formatting → collapse
whitespace → lowercase, and each step earns its place:

- **NFC**, because `é` composed and `e` + combining acute are one word to a human and two strings to
  a database, arriving from different keyboards and different paste sources.
- **Invisible characters are stripped** — ZWSP, the bidi marks, isolates and BOM. They survive
  copy-paste out of an RTL document, are impossible to see in an input box, and would otherwise make
  two identical-looking tags into two rows.
- **U+200C ZWNJ and U+200D ZWJ are deliberately kept.** ZWNJ is a letter-joining control in Persian,
  where `می‌رود` and `میرود` are different words; ZWJ holds an emoji sequence together. Folding
  either away would merge genuinely distinct terms, which is worse than the duplicate it avoids.
- **`toLowerCase()`, not `toLocaleLowerCase()`** — the locale-sensitive form maps Turkish `I` to `ı`,
  so a channel's tag identity would depend on the locale of whichever pod served the request.

**The first spelling wins.** `(channelId, normalized)` is a unique index, and the upsert writes the
existing label back to itself on conflict, so a later `football` does not rewrite everyone's
`Football`. Mint-or-reuse happens inside the transaction, because two editors tagging different
assets `football` at the same moment is the ordinary case and a read-then-insert would race.

**Re-submitting the same set does nothing** — no version bump, no `asset.updated`. A tag input that
PUTs on every change submits the unchanged set constantly, and bumping the version each time would
fabricate a change history and wake every consumer for nothing. Comparison is on the normalized
form, so `FOOTBALL` over an existing `football` is correctly nothing.

**Untagging leaves the term in the channel's vocabulary.** The cloud is the channel's keyword list,
not a reference count; deleting a term the moment its last asset drops it would erase an operator's
vocabulary as a side effect of an edit, and would race with anyone typing it at that instant.

Tagging is authorized as `asset:write` on the **`taxonomy`** field group. That is the first place
MAM asks for a field group at all, and it is a genuine narrowing: asking without one means any group
satisfies the check, so before this a Librarian's files-and-rights grant reached an asset's
keywords. Core and file writes still do not name theirs — a gap, not a decision.

Reading the cloud is `taxonomy:read`, not the `taxonomy:admin` the service catalogue lists against
`GET /tags`. That table describes the _management_ surface; gating the read behind admin would make
autocomplete an administrator-only feature and defeat free-form tagging for every editor it exists
for.

## Simple search

The target architecture puts faceted search on OpenSearch, fed by the outbox as a rebuildable read
model ([mam.md §6.2](../../docs/architecture/services/mam.md)). That is Beta work. What MVP needs is
that an editor can type a word and find their asset, so the index is a **term table in the same
database**, written in the same transaction as the row it describes.

Two consequences, both stated because they are why this is the right MVP _and_ why it will not be
the answer forever:

- **It cannot drift.** A separate store has to be reconciled — the outbox exists precisely because
  dual writes desynchronise. An index that commits with its row has no such window at all, which is
  strictly stronger than the projection it stands in for.
- **It does not stem, and it does not rank the way a search engine does.** `running` will not find
  `run`. Relevance is how many of the query's terms an asset matched, and nothing more.

Tokenizing happens in [`search.ts`](src/search.ts), in pure domain code, never in SQL — the same
reasoning as tags, and it shares the [same folding](src/text.ts) so that a tag stored under one
definition and a query tokenized under another can never disagree. Word characters are `\p{L}`,
`\p{N}` and `\p{M}` rather than `\w`, which is ASCII-only and would reduce every Persian or Arabic
title to a single empty token.

Keeping the tokenizer out of the database also sidesteps a specific trap. **Postgres ships no
`persian` text-search configuration** — arabic yes, persian no, checked against the Postgres 17 this
project runs — so `to_tsvector` on Persian content silently falls back to no stemming while _looking_
language-aware. An explicit token index treats Persian and English alike: worse than a real Persian
analyser, much better than one that pretends. (OpenSearch does have a Lucene `persian` analyser,
which is a genuine argument for the eventual move rather than a restatement of the plan.)

**The last term is a prefix, the rest are exact.** Someone typing `foot` means "football"; someone
who typed `foot ` finished the word. That difference is the whole of search-as-you-type, and the
trailing separator is what carries it. Matching is **AND** — OR semantics would return the whole
library for any two-word query.

The two adapters reach the index by different routes and are held to one behaviour by the
conformance suite: sqlite uses a `>= p AND < bound` range, Postgres uses `LIKE 'p%'` against a
`text_pattern_ops` index. Both are index scans; a plain `LIKE` on Postgres would fall back to a
sequential scan in any database whose collation is not C, on exactly the query editors type most.

**Every hit is authorized individually.** A read grant scoped to a category subtree makes "may this
user see it" a per-asset question, and answering it once for the channel would turn the index into a
way to enumerate titles the caller cannot open. The channel-wide pre-check is deliberately the
_lenient_ `can()` and is only an early-out: asking strictly there would refuse a Journalist scoped
to `/news/` outright, because a grant naming a category cannot satisfy a check that names none.
Enforcement is the strict per-asset check that follows.

The index cannot drift, but it can go **stale** in a different sense — changing the tokenizer changes
what the same text indexes to. So `POST /search/reindex` rebuilds a channel from the assets
themselves, which is the rebuildable read model the design asks for. It is `taxonomy:admin`, because
on a large channel it is expensive.

## Persistence is a port with two adapters

The service talks to [`AssetStore`](src/store.ts), never to a driver.
[Postgres](src/store-pg.ts) is what deploys; [`node:sqlite`](src/store-sqlite.ts) is what tests and
single-node dev run on. Both pass the same [conformance suite](src/store-conformance.ts), because
the two properties MAM's safety argument rests on — tenant isolation and outbox atomicity — are
properties of the **adapter**, so asserting them against sqlite proves nothing about production.

Everything is async. A synchronous driver can satisfy an async contract; the reverse is impossible,
and the deployed store is Postgres.

The interface has no `put`. Writes exist only inside `transaction()`, so a write that skips the
unit of work — and therefore the outbox's atomicity — cannot be expressed. `listByChannel` takes the
tenant as a parameter rather than leaving the caller to filter, because a filter applied after
loading is one that can be forgotten, and forgetting it means one channel reading another's
catalogue.

One divergence the suite deliberately does **not** paper over: on sqlite an uncommitted write is
visible to the same connection, on Postgres it is not visible outside the transaction's own client.
So the service reads nothing back inside a transaction — that would pass in tests and return stale
data in production.

```bash
npm test -w @atlas/mam                    # sqlite; the Postgres suite skips
docker compose -f infra/docker-compose.dev.yml up -d postgres
ATLAS_PG_URL=postgres://atlas:atlas@localhost:55432/atlas npm test -w @atlas/mam
```

## Where permissions come from

IAM owns grants; MAM enforces them. [`PolicyClient`](src/policy-client.ts) fetches the caller's
compiled policy from IAM and caches it briefly — one authorization round trip per request would put
IAM on the critical path of every read.

That TTL is a **revocation window**, not a performance knob: a permission removed in IAM stays live
here until the entry expires. Every failure mode resolves to "no policy", which the HTTP layer turns
into 401 — an unreachable IAM, a 500, a body that is not a policy. The convenient alternatives are
both unsafe. Serving a stale entry makes a revoked permission outlive its revocation for as long as
IAM is down; treating an unparseable response as "no rules" is a guess about authorization dressed
up as a 403.

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

## Running in a cluster

[`main.ts`](src/main.ts) is the container entrypoint: Postgres pool, migrations, policy client,
health checks and the outbox relay, which drains to NATS on an interval.

**The broker is deliberately not a readiness check.** With NATS down, writes still commit and their
events accumulate in the outbox until it returns — that is exactly what the outbox is for. Failing
readiness there would take the catalogue out of service to protect an announcement about it.

**Migrations retry within a budget.** On a fresh install every service starts at once and Postgres
is not up yet; exiting immediately hands the problem to Kubernetes' restart backoff, which grows to
five minutes. Measured on the first deploy, that was **7 restarts and 16 minutes** to reach ready,
long after the database was serving. The budget matters as much as the retry — a wrong password is
a permanent failure, and a service that retries one forever never tells anyone it is misconfigured.

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
