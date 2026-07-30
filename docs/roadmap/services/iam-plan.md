# IAM — Identity & Access Management — Implementation Plan

> Build plan for identity, tokens, and the permission model every other service trusts.
> Spec: [iam](../../architecture/services/iam.md) · Stack: **Node + NestJS** (`jose`, Passport) ·
> Ships: **Phase 0 (v0)** → **Phase 3 (SSO/MFA)**. Critical path — build first.

## 1. Scope & versions

| Version | Phase | Delivers |
|---------|-------|----------|
| v0 | 0 | Login, JWT access+refresh, JWKS, basic users/roles; the shared token-validation lib. |
| v1 | 1–2 | Full users/groups/roles/rules CRUD; **effective permissions = union** of user + group rules; permission-version claim for fast revocation. |
| v2 | 3 | SSO federation (OIDC/SAML), optional MFA; refresh-token rotation/revocation hardening. |

**Non-goals.** Resource-level authz *enforcement* lives in each service (IAM supplies identity +
effective permissions + rules; services decide per-resource). No end-user PII beyond accounts.

## 2. Build sequence

1. **Auth core (v0)** — password login, `POST /auth/login|refresh|logout`; sign **access JWTs** (short
   TTL) + **refresh tokens** (rotating, stored); publish **JWKS** for local verification by all services.
2. **Token-validation library** — the shared `service-kit` verifier: fetch/cache JWKS, validate
   signature/exp/aud, expose claims (`sub`, permissions, `permVersion`, `channelId`). **Everything
   downstream depends on this — ship it in Phase 0.**
3. **Identity CRUD (v1)** — users, groups, roles, rules; group membership (user in ≥1 group).
4. **Permission engine** — compute **effective permissions** as the union of user rules and all group
   rules ([FR-IAM](../../requirements/05-functional-requirements.md#iam)); expose
   `GET /users/{id}/effective-permissions`.
5. **Fast revocation** — a `permVersion` claim bumped on permission/membership change; services reject
   tokens with a stale version; emit `permissions.changed` / `group.membership.changed`.
6. **Federation & MFA (v2)** — OIDC/SAML via Passport strategies; map external identities to Atlas
   users/groups; optional TOTP/MFA on login.

## 3. Components / modules

- `auth` (login/refresh/logout, token mint/rotate), `jwks`, `users`, `groups`, `roles`, `rules`,
  `permissions` (union resolver), `federation` (OIDC/SAML), `mfa`, event emitters.

## 4. Data plane & migrations

- **Relational:** users, groups, roles, rules, membership; **refresh-token store** (relational + Redis
  cache for hot validation/blocklist). Additive migrations; seed a bootstrap admin + core roles.

## 5. APIs & events

- REST: [`iam.yaml`](../../architecture/openapi/iam.yaml) — `/auth/*`, `/users`, `/groups`, `/roles`,
  `/rules`, `/users/{id}/effective-permissions`.
- **Emits:** `user.created`, `user.updated`, [`permissions.changed`](../../architecture/schemas/events/permissions.changed.payload.schema.json),
  `group.membership.changed`. **Consumes:** none (source of truth for identity).

## 6. Dependencies & integration points

- **Requires first:** data plane, `service-kit`. **Consumed by:** every service (token verify +
  effective permissions) and the gateway (JWKS).

## 7. Testing focus

- Token lifecycle: expiry, refresh rotation, reuse-detection, logout/revocation.
- **Effective-permission union** correctness across overlapping user + multiple group rules.
- Revocation latency via `permVersion` (a de-permissioned user is blocked within one token TTL or on
  next request).
- Federation mapping (OIDC/SAML) and MFA flows (v2).

## 8. Scaling & deployment

- **Stateless API replicas**; validation is **local to each service** via JWKS (no per-request call to
  IAM). Redis-backed refresh store for revocation. Config: token TTLs, key rotation schedule, IdP
  connection, MFA policy.

## 9. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| A weak token model taints every service | Get v0 auth + the validation lib right first; security-review early. |
| Permission-union surprises (over/under-grant) | Exhaustive union tests; `effective-permissions` endpoint for debugging. |
| Refresh-token theft | Rotation + reuse detection + revocation; short access TTL. |
| Offline sites can't reach an IdP | Local accounts remain first-class; SSO is additive, never required ([A9](../../README.md#assumptions-register)). |
