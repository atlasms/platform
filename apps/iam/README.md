# @atlas/iam — identity and access

Login, refresh-token families, lockout, the compiled effective policy, the starter roles, a store
that persists (EP-10.4), the administration of users, groups, roles and grants, and — at last —
the events a grant produces (EP-10.6). Design: [iam.md](../../docs/architecture/services/iam.md) ·
authorization: [authorization-model.md](../../docs/architecture/authorization-model.md) ·
contract: [`iam.yaml`](../../docs/architecture/openapi/iam.yaml).

## The store is a port, with two adapters and one suite

`IamStore` — `sqliteIamStore` for tests and the walking skeleton, `pgIamStore` in production —
held to `iamStoreConformance`, run against **both** in CI. Driven through the service, because
the properties that matter are properties of the unit of work, and they are the ones only a store
can get wrong:

| Property                                      | How the suite proves it                                                                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| A username is taken exactly once              | the second `createUser('jo')` is a `Conflict` decided by the store, and nothing is half-written                                         |
| A login is one unit of work                   | the record (lock lift, run cleared, last login), the rehash, the event and the refresh token commit together                            |
| A refresh token rotates **exactly once**      | two CONCURRENT refreshes with one token: the database lets one through; the other is a **reuse** and the family is revoked              |
| Logout is idempotent, and can be everywhere   | twice revokes nothing more; `allSessions` revokes every family                                                                          |
| Lockout is persisted state                    | the run, the lock and its lift all reach the store; the transition is in the trail                                                      |
| The trail is **append-only, in the database** | a raw `UPDATE` on `login_events` is refused by a trigger (sqlite and Postgres alike)                                                    |
| The seed is idempotent                        | starter roles seed once and never overwrite an operator's edit; the bootstrap user and grant are found, not recreated, on every restart |

**The claim is the database's.** `revokeTokens(ids, at)` is `UPDATE … SET revoked_at WHERE
revoked_at IS NULL` and returns how many rows it touched. `refresh` revokes the presented token
first and only mints a pair if that count was 1; a 0 means someone else rotated it in the same
instant, which is exactly the reuse the family mechanism exists for. The in-memory version could
not race; the Postgres version can, and this is what decides it.

The sqlite double serializes async transactions per connection (`@atlas/data`'s
`withTransactionAsync`): one connection is one queue, and a second transaction runs after the
first commits — which is what makes the double honest about the race above without a second
connection.

## What is stored

`users` (columns for what is queried — `username` unique, `state`, `perm_version`, `channel_id` —
and the record as JSON), `credentials` (argon2id PHC strings, never plaintext), `refresh_tokens`
(the hash, the family, `revoked_at`, `rotated_from`; the token itself is never stored),
`login_events` (append-only), `roles`, `groups`, `memberships`, `assignments` (addressable, so a
grant can be revoked by id), and the `outbox` for EP-10.6.

A **group holds roles by id**: a role edited once is edited for every group that carries it,
which is what a named bundle is for. `channel_id` is **nullable** on roles and groups — NULL is
platform-wide (the starter roles ship that way for an operator to narrow) — the one exception to
the every-row rule, recorded in iam.md §13.

## Administration (EP-10.4 part 2)

`IamAdmin` (`admin.ts`) is the surface behind `/api/v1/users`, `/groups` and `/roles` in
[`iam.yaml`](../../docs/architecture/openapi/iam.yaml). Every operation requires **`user:admin` in
the channel of the row it touches**, checked with `canEnforce` and the full resource context:

- A channel admin administers their channel. Another channel's user, group or role is **404**, not
  403 — a 403 would confirm it exists.
- A **platform-wide** row (no channel: the starter roles, a platform group) needs an **unscoped**
  `user:admin`. A strict check with no channel to match cannot be satisfied by a channel-scoped
  rule, and that is the point: narrowing the platform's roles is a platform operator's act.
- A rule an admin writes — into a role, a group or a direct assignment — **cannot reach beyond
  what they administer**: a channel admin can write neither a rule for another channel nor an
  unscoped one, which would be every channel.
- A group takes the platform's roles and its own channel's, never another channel's; a channel
  group takes the channel's users.
- Deleting a role that is still granted, directly or through a group, is **409**: revoke first, so
  no permission disappears without being named in a request.

Group ids are ULIDs (they travel in `group.membership.changed`, whose schema says so); role ids are
kebab-case names (`editor`), minted as a ULID when not given. Adding a member twice is one
membership and no second event; removing an absent one is a no-op.

## What a grant emits (EP-10.6)

Every mutation writes its rows, its `audit.recorded` delta (AGENTS.md §5.6) and its domain events
in **one transaction** through the outbox; IAM runs a relay now (`ATLAS_NATS_URL`; not a readiness
dependency — with the broker down, login keeps working and the events wait).

Whenever what a user MAY DO changes, their `permVersion` is bumped and **`permissions.changed`**
carries the new value — one per affected user: a grant or revocation, a membership, an account
disabled or re-enabled, and a **role or group whose rules changed**, which reaches every holder
directly or through a group. That number is what lets the gateway refuse the old token and the
WebSocket service drop the old subscriptions within one access-token TTL (FR-IAM-8); the
consumers were built long before this producer, and the smoke suite now watches a grant's three
envelopes cross the spine into the audit log. Memberships also emit `group.membership.changed`.
The credential is never in a delta: the audit says a password changed, not what to.

The logging sink reads IAM's trail — `user`, `group`, `role`, `permissions` — under `user:admin`
(`apps/logging/src/visibility.ts`); the model defines no `user:read`, and the trail is read there,
not streamed to browsers.

## Not yet

- Signing keys are generated per process; a multi-replica IAM needs them from a secret.
- `holdersOf` a role walks the users; fine at the size of a channel, an index when it is not.

## Run

```sh
npx nx test @atlas/iam                                                          # sqlite double
ATLAS_PG_URL=postgres://atlas:atlas@localhost:55432/atlas npx nx test @atlas/iam   # + Postgres
```

| Variable                                         | Default                            |                                            |
| ------------------------------------------------ | ---------------------------------- | ------------------------------------------ |
| `ATLAS_PG_URL`                                   | `postgres://…@postgres:5432/atlas` | waited for at startup, within 120 s        |
| `ATLAS_NATS_URL`                                 | `nats://nats:4222`                 | the outbox relay; retried, never readiness |
| `ATLAS_SEED_USERNAME` / `_PASSWORD` / `_CHANNEL` | unset                              | dev bootstrap; idempotent across restarts  |
| `ATLAS_LOCKOUT_*`                                | 10 / 15 min / 15 min               | see `lockout.ts`                           |
