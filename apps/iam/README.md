# @atlas/iam — identity and access

Login, refresh-token families, lockout, the compiled effective policy, the starter roles — and,
since EP-10.4, a store that persists. Design: [iam.md](../../docs/architecture/services/iam.md) ·
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

## Not yet

- **10.4 (part 2)** — the admin API: groups, roles, assignments, memberships over HTTP, with
  `user:admin` enforced by `canEnforce`.
- **10.6** — `permissions.changed` and `group.membership.changed` through the outbox, in the
  grant's own transaction. The consumers exist (gateway, websocket, Studio); the producer is this.
- Signing keys are generated per process; a multi-replica IAM needs them from a secret.

## Run

```sh
npx nx test @atlas/iam                                                          # sqlite double
ATLAS_PG_URL=postgres://atlas:atlas@localhost:55432/atlas npx nx test @atlas/iam   # + Postgres
```

| Variable                                         | Default                            |                                           |
| ------------------------------------------------ | ---------------------------------- | ----------------------------------------- |
| `ATLAS_PG_URL`                                   | `postgres://…@postgres:5432/atlas` | waited for at startup, within 120 s       |
| `ATLAS_SEED_USERNAME` / `_PASSWORD` / `_CHANNEL` | unset                              | dev bootstrap; idempotent across restarts |
| `ATLAS_LOCKOUT_*`                                | 10 / 15 min / 15 min               | see `lockout.ts`                          |
