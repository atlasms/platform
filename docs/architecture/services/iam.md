# IAM — Identity & Access Management — Service Specification

> Users, groups, roles, permission rules, and authentication. Summary card:
> [Service Catalog §IAM](../03-service-catalog.md#iam--identity-and-access-management).
> Template: [services/README](README.md#spec-template).

## 1. Purpose & boundaries

IAM is the **source of truth for identity and authorization**. It manages users, groups, roles,
and permission rules; authenticates users; issues and revokes tokens; and answers "what may this
principal do?". It publishes the public keys and permission-change events that let every other
service enforce authorization **locally** without calling IAM on the hot path.

**In scope:** CRUD for users/groups/roles/rules; group membership; effective-permission
computation; password + token authentication; JWT access + refresh issuance, rotation, and
revocation; SSO federation (OIDC/SAML); MFA for privileged roles; the JWKS endpoint.

**Out of scope:** per-request enforcement at the resource level (each service does that using
IAM-issued tokens + its own resource checks); UI; audit storage (IAM emits, [Logging](logging-analytics.md)
stores); channel/tenant data (IAM records which channels a principal may act in, but domain
data is owned by the domain services).

## 2. Requirements covered

- [FR-IAM-1…11](../../requirements/05-functional-requirements.md#iam) in full — CRUD, group
  membership, additive rules on users *and* groups, the **union** effective-permission model,
  JWT access+refresh, resource/department-scoped checks, revocation within one TTL, SSO, MFA,
  and the optional explicit-deny model (Post).
- Underpins [FR-UI-5](../../requirements/05-functional-requirements.md#studio),
  [FR-LOG-2](../../requirements/05-functional-requirements.md#analytics) (permission-filtered
  log visibility), and every service's authorization.
- NFR: [NFR-SEC-2](../../requirements/06-non-functional-requirements.md#security--privacy)
  (token model), [NFR-SEC-3](../../requirements/06-non-functional-requirements.md#security--privacy)
  (defense in depth).

## 3. Domain model

> Full entity/field model: **[Data Model §4](../data-model.md#4-the-identity-aggregate)** ·
> authorization semantics: **[Authorization Model](../authorization-model.md)**.

| Entity | Key fields | Store |
|--------|-----------|-------|
| **User** | id, username, name, email?, state (active/disabled/locked/pending), channelIds[], **permVersion**, lastPasswordChange, mustChangePassword, failedLoginCount, lockedUntil?, **lastLogin, lastIp**, mfaEnrolled, idpProvider/idpSubject?, avatarRef?, audit | Relational |
| **Credential** | userId, hash (argon2id), algorithm, updatedAt — separate row; absent for pure-SSO users | Relational |
| **UserPreferences** | userId, locale, timezone, theme, workspaceLayout | Relational |
| **Group** | id, channelId?, name, description | Relational |
| **Membership** | userId, groupId | Relational (join) |
| **Role** | id, name, description (a named bundle of rules) | Relational |
| **Rule** (grant) | id, effect, permissions[], scope{channelIds, categoryPaths, states, ownedOnly}, fieldGroups[] — contract: [`policy-rule.schema.json`](../schemas/policy-rule.schema.json) | Relational |
| **Assignment** | subject (userId **or** groupId), roleId **or** ruleId | Relational |
| **RefreshToken** | id, userId, hash, familyId, expiresAt, revokedAt, rotatedFrom | Relational + cache |
| **LoginEvent** | id, userId, at, ip, userAgent, result (success/failure/mfa) — append-only; source of `lastLogin`/`lastIp` | Relational |

Credentials are stored as salted hashes (e.g. argon2id) or delegated entirely to an external
IdP; IAM never stores plaintext secrets.

### 3.1 Effective permissions (normative)
Per [FR-IAM-4](../../requirements/05-functional-requirements.md#iam): for user `U` in groups
`G1…Gn`, `effective(U) = rules(U) ∪ rules(G1) ∪ … ∪ rules(Gn)` (flattened through roles). Grants are
**additive**; the base model has **no deny** (explicit deny is the Post-v1.0
[FR-IAM-11](../../requirements/05-functional-requirements.md#iam) option). A request is authorized iff
a matching grant covers the required permission **and** every scope predicate holds for the resource
(channel, **category subtree** by path prefix, state, ownership) — and, for writes, the **field group**.

The policy is **compiled once per `permVersion`**, served by `/users/me/effective-permissions`, and
evaluated by **one shared function used by both the services and Studio**. Full semantics, the grant
contract, and the starter roles: **[Authorization Model](../authorization-model.md)**.

## 4. Public API

> **Contracts:** REST → [OpenAPI stub](../openapi/iam.yaml) · events → [payload schemas](../schemas/).

| Method | Path | Purpose | Authz |
|--------|------|---------|-------|
| `POST` | `/auth/login` | Authenticate; returns access + refresh (or triggers MFA/SSO). | Public |
| `POST` | `/auth/refresh` | Rotate refresh, mint new access. | Valid refresh |
| `POST` | `/auth/logout` | Revoke the refresh-token family. | Valid refresh |
| `GET` | `/auth/sso/{provider}` · `/auth/sso/{provider}/callback` | OIDC/SAML federation. | Public |
| `GET` | `/.well-known/jwks.json` | Public keys for local JWT validation. | Public |
| `GET/POST/PATCH/DELETE` | `/users`, `/groups`, `/roles`, `/rules` | Administration. | Admin scopes |
| `POST/DELETE` | `/groups/{id}/members` | Manage membership. | Admin scopes |
| `GET` | `/users/{id}/effective-permissions` | Resolved permission set (also used by [WebSocket](websocket.md)). | Admin / self |

## 5. Messaging

- **Emits:** `user.created`, `user.updated`, `permissions.changed` (bumps permission-version;
  consumed by the [gateway](api-gateway.md) cache and [WebSocket](websocket.md) for live
  re-check), `group.membership.changed`.
- **Consumes:** none for identity truth (IAM is the source). It may consume nothing on the
  domain bus beyond health.

No broker commands — auth is synchronous request/response.

## 6. Key flows

### 6.1 Login → token issuance

```mermaid
sequenceDiagram
    participant S as Studio
    participant IAM
    participant IdP as External IdP
    S->>IAM: POST /auth/login (credentials)
    alt SSO configured
        IAM->>IdP: OIDC/SAML
        IdP-->>IAM: assertion
    end
    IAM->>IAM: Verify; MFA if required by role
    IAM->>IAM: Mint access (5–15 min) + refresh (rotating)
    IAM-->>S: access + refresh + permissionVersion
```

### 6.2 Revocation within one TTL
Revoking a rule/role/refresh token bumps the user's **permission-version** and emits
`permissions.changed`. Access tokens carry the version claim; the gateway/services reject a
token whose version is stale on its next request — so revocation bites within one access-token
TTL ([FR-IAM-8](../../requirements/05-functional-requirements.md#iam)) without a per-request
IAM call. Refresh rotation uses a **family id** so reuse of a rotated token revokes the whole
family (theft detection).

## 7. Dependencies

- **Relational store** — identity system of record; **cache/Redis** — token + permission-
  version lookups.
- **Vault** — signing keys (asymmetric; private key never leaves IAM), credential pepper.
- **External IdP (optional)** — OIDC/SAML for SSO ([FR-IAM-9](../../requirements/05-functional-requirements.md#iam)).
- **Broker** — publish `permissions.changed`.

## 8. Scaling & performance

- **Stateless API replicas**; validation elsewhere is local (JWKS), so IAM is *not* on the
  per-request hot path — it is hit at login, refresh, and admin operations.
- Effective-permission resolution is cached and recomputed on membership/rule changes.
- Critical for availability (login gates everything) → HA at v1.0
  ([NFR-AVAIL-2](../../requirements/06-non-functional-requirements.md#availability)).

## 9. Failure modes & degradation

| Failure | Effect | Mitigation |
|---------|--------|-----------|
| IAM down | No new logins/refreshes; **existing access tokens still work** until expiry (local validation) | HA replicas; short outage tolerated because validation is decentralized. |
| JWKS unreachable | Services can't refresh keys | Long key TTL + cached keys; slow rotation. |
| External IdP down | SSO logins fail | Optional local-auth fallback for break-glass admin. |
| Cache down | Slower permission resolution | Recompute from relational; degrade latency, not correctness. |

## 10. Security & data sensitivity

- The **most security-sensitive service.** Asymmetric JWT signing (private key vault-held,
  public via JWKS); short access TTL (5–15 min) + rotating, revocable refresh with reuse
  detection; argon2id password hashing; MFA for privileged roles
  ([FR-IAM-10](../../requirements/05-functional-requirements.md#iam)).
- Login credentials and refresh tokens are **PII/secret**; audited on every change
  ([NFR-SEC-7](../../requirements/06-non-functional-requirements.md#security--privacy)).
- Per the [stack escape-hatch policy](../03-service-catalog.md#recommended-implementation-stack),
  auth-critical code gets **more** review, not AI-fast-tracked
  ([Resourcing §8](../../roadmap/09-resourcing-estimates.md#ai-assisted-development)).

## 11. Configuration

Access/refresh TTLs; password policy; MFA policy per role; SSO provider config (per tenant);
key rotation schedule; lockout/backoff thresholds; whether explicit-deny
([FR-IAM-11](../../requirements/05-functional-requirements.md#iam)) is enabled for a customer.

## 12. Observability

- **Metrics:** login success/failure rate, MFA challenges, token issue/refresh/revoke counts,
  permission-resolution latency, active refresh families.
- **Logs/audit:** every auth event and grant change (actor, subject, before/after) → the audit
  spine.
- **Alerts:** auth-failure spikes, refresh-reuse detections, unusual admin grant activity.

## 13. Implementation notes

- **Node.js + NestJS** (structured control-plane CRUD). `jose` for JWT/JWKS, `passport` +
  provider strategies for OIDC/SAML, `argon2` for hashing, `ioredis` for the token/version
  cache, Prisma/`pg` for the relational store.
- Publish JWKS with cache headers; keep two active keys during rotation.
- No CPU-bound work → no native escape hatch.

## 14. Open questions / future

- Explicit deny-rule semantics if a customer requires them ([FR-IAM-11](../../requirements/05-functional-requirements.md#iam)).
- Fine-grained attribute-based rules (ABAC) vs. the current department/resource scoping.
- SCIM provisioning from enterprise IdPs; service-account/API-key lifecycle for
  [Integration](integration-feeds.md) partners.

---
_Related: [API Gateway](api-gateway.md) · [WebSocket](websocket.md) ·
[NFR §Security](../../requirements/06-non-functional-requirements.md#security--privacy)._
