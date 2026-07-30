# @atlas/mam-service — an assembled service (reference)

A thin **MAM vertical slice** that proves the foundation libraries compose into a working,
event-driven service — running the very asset/review lifecycle designed across the docs.

## What it does

```
ingest.accepted  ──▶  MAM creates the asset (processing)     ──▶ asset.created
transcode.completed ─▶ MAM attaches renditions → Ready       ──▶ asset.ready
approve() / reject() ─▶ MAM sets state + expiry/retention     ──▶ asset.approved / asset.rejected
```

Built entirely from the foundation libs — no new infrastructure:

- **[@atlas/service-kit](../service-kit/README.md)** — structured logger + correlation context; the
  error taxonomy (`Conflict` on a bad transition, `NotFound` on a missing asset).
- **[@atlas/contracts](../contracts/README.md)** — `buildEnvelope`/`follow` to construct events and
  `validateMessage` to **validate every outgoing event against its schema before it can be committed**.
- **[@atlas/messaging](../messaging/README.md)** — `idempotent` consumers, and the **transactional
  outbox**: [`store.ts`](src/store.ts) writes the asset change and the outgoing events together, then
  a relay drains the outbox to the broker (no dual-write).

## Run

```bash
# from reference/ (the shared dep root): npm install once, then:
cd mam-service && node --import tsx --test test/mam-service.test.ts   # 7 tests
```

## Tests prove (the whole stack, end to end)

- `ingest.accepted` → asset created (state `processing`), core fields **derived** from the ingest
  payload (title from path, resolution from technical metadata); `asset.created` emitted and valid;
- `transcode.completed` → renditions attached, state **Ready**, `asset.ready` emitted;
- `approve()` → **Approved** with an `expiresAt`; `asset.approved` carries the approver + actor and validates;
- `reject()` → **Rejected** with `retainUntil`; `asset.rejected` validates;
- a **redelivered** ingest is handled once (idempotent consumer);
- **correlation threads end-to-end** — `asset.created`/`asset.ready` carry the ingest's correlation id;
- **every emitted event validates against its contract** (the service enforces this on the way out).

## What this is / isn't

A **reference of composition**, not the real MAM: state is in-memory (no Postgres/search), metadata
is trimmed, and the HTTP edge is omitted (approve/reject are called directly). It shows exactly how a
real service wires the libraries together and where the transactional-outbox + idempotency seams go.
