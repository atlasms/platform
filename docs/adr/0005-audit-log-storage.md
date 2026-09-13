# ADR-0005 — The audit log: Postgres as the record, OpenSearch as the index

**Status:** Accepted · **Date:** 2026-09-13 · **Epic:** EP-07.4, EP-19

## Context

[logging-analytics.md](../architecture/services/logging-analytics.md) §3 gives the audit log two
homes in one line: _"Search index (hot) + cold"_. §3 also requires it to be **append-only and
tamper-evident** (hash-chained per channel), and [AGENTS.md](../../AGENTS.md) §5 requires every
consumer to be **idempotent** — the sink's dedup mark must commit with the row it guards
([EP-03.3](../roadmap/21-epic-breakdown.md)).

EP-19.1 built the sink on **Postgres behind a port**, with the note that OpenSearch was EP-07.4
and "an adapter when it arrives". When it arrived, the question was whether OpenSearch replaces
Postgres as the audit store or sits beside it.

## Options

1. **OpenSearch as the only store.** The design's literal reading. One system, one write path.
2. **Postgres as the system of record, OpenSearch as a derived hot index.** Two systems; the log is
   written once, in Postgres, and copied into the index by a projector.
3. **Postgres only, index later.** Defer; the browse is a `SELECT` with an index on `(channel_id, seq)`.

## Evidence

- **What OpenSearch cannot enforce.** The append-only guarantee is a database trigger
  (`apps/logging/src/store-pg.ts`); the conformance suite proves it by issuing a raw `UPDATE`
  around the port and watching it refused. OpenSearch has no equivalent: any client with write
  access can overwrite or delete a document. The hash chain would still _detect_ tampering, but
  the record could no longer _refuse_ it.
- **What OpenSearch cannot join.** The seen-mark and the append commit together, or roll back
  together — that is the whole of EP-03.3 and the reason a crash mid-handler cannot lose or
  double a message. There is no transaction spanning a Postgres seen table and an OpenSearch
  document, and moving the seen table into OpenSearch too gives up the atomic `INSERT … ON
  CONFLICT` claim.
- **What Postgres cannot do well, eventually.** The browse (EP-19.3) is a filtered, sorted page
  over a log that only grows. At the volume a broadcaster produces it is fine for a long time on
  a B-tree; it is not what a relational store is for, and every filter combination wants its own
  index. A search engine answers exactly that query shape by construction.
- **The projector needs no bookkeeping.** `seq` is gapless per channel and N+1 is computed from a
  committed N, so the index's own `max(seq)` per channel is a correct resume point. A global serial
  would not be — a later id can commit first and a cursor that passed it would never look back.
  Measured on the conformance suite: a restarted projector indexes exactly the rows appended since;
  a dropped index is rebuilt in full on the next tick.

## Decision

**Option 2.** Postgres is the audit log — append-only by trigger, hash-chained, the seen-mark in
the append's transaction. OpenSearch holds a **derived view** of it, written by a projector in
chain order, every document keyed by `messageId` so a re-index is an overwrite. `GET /logs` reads
the index when `ATLAS_OPENSEARCH_URL` is set and Postgres otherwise; the history and the ingest
always use Postgres. One conformance suite runs the browse cases against **both** readers.

## Consequences

- The browse is **eventually consistent**: the projector's interval (1 s) plus the bulk refresh.
  The smoke suite's browse test polls, as any client of an index should.
- With the engine down the service stays **ready** — writes and history reads work — and a browse
  is a `503 UNAVAILABLE`, a new member of the error taxonomy: retryable, and distinct from a 500 so
  an outage of a dependency is not logged as a crash.
- **"Delete the index" is an operation, not an incident.** A mapping change is a new index and a
  rebuild; there is no migration story for the index and there does not need to be one.
- Two data stores to run, in-cluster ([FR-PLat-7](../requirements/05-functional-requirements.md#platform)).
  A ~1 GB image and a JVM: the dev cluster and the smoke run pay ~1 GB of memory and a minute of
  startup for it.
- Redis and Mongo — the rest of EP-07.4's title — are **not** built. Nothing uses them; a client
  with no consumer has been tested against nothing.

## Revisit when

- A regulator or customer requires the **audit browse itself** to be served from the tamper-evident
  store. Then the index is a cache in front of a Postgres read, not a substitute for it.
- Retention (EP-19.4) needs the index to age documents out while Postgres keeps them — the index
  becomes the _hot_ window and Postgres the cold one, which §6.3 describes and this design permits.
- A second projection wants the same projector — MAM's search — and the pattern moves into a lib.
