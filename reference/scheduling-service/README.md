# @atlas/scheduling-service — a second assembled service + cross-service flow

A Scheduling vertical slice that **consumes MAM's asset lifecycle** and enforces the
**approved-and-not-expired guard at send-to-air** — the FR-SCH-3/5a rule that lets the review
lifecycle actually gate air. It also carries the **two-service integration test**.

## What it does

- Projects MAM events into a *schedulable registry*: `asset.approved` → schedulable (with `expiresAt`);
  `asset.expired` → removed + items **flagged** (flag-not-drop); `asset.deleted` → references dropped;
  `asset.replaced` → references + schedulability **swapped** to the new id.
- `addItem` enforces "only approved media is schedulable" up front (`Conflict` otherwise).
- **`sendToAir` runs the guard at serialization**: an item is exported only if its asset is still
  schedulable **and** not past its expiry — catching an approval that lapsed *between scheduling and
  export*. Blocked items are excluded and **reported**, never silently on air. Emits `schedule.sent-to-air`.

Built from the same libs as [`mam-service`](../mam-service/README.md): `service-kit` (logger/errors),
`contracts` (build/validate events), `messaging` (idempotent consumers + outbox). Playlist output is a
pluggable `PlaylistSerializer` (a JSON one here; Cinegy MCRList is the first real target — FR-SCH-5).

## Run

```bash
# from reference/ (shared dep root): npm install once, then:
cd scheduling-service && node --import tsx --test test/*.test.ts   # 7 tests
```

## Tests prove

**Unit** — approve→schedulable→export; can't schedule an unapproved asset; `asset.expired` flags items
and blocks them at export; the **export-time guard** blocks an approval that lapsed after scheduling
(no `asset.expired` needed); `asset.replaced` swaps references; `asset.deleted` drops them.

**Integration** ([`integration.test.ts`](test/integration.test.ts)) — **MAM and Scheduling on one
broker**: ingest→create→ready→**approve** (MAM) makes the asset air-able (Scheduling), it exports; then
MAM's scheduler **expires** it → `asset.expired` → Scheduling pulls it → the next send-to-air exports
nothing. The review lifecycle gates air **across two services**, end to end.
