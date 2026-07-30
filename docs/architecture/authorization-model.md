# Authorization Model — users, groups, roles & policy

> How Atlas decides *who may do what to which resource*, in a form that the **backend enforces** and
> the **front-end renders from** — one declarative policy, one shared evaluator, no drift.
> Identity entities: [Data Model §4](data-model.md#4-the-identity-aggregate) · Service:
> [IAM](services/iam.md) · Requirements: [FR-IAM](../requirements/05-functional-requirements.md#iam).

## 1. Principles

1. **One policy, two consumers.** The *same* compiled policy and the *same* pure evaluator run in the
   service (to **enforce**) and in Studio (to **render**). A permission question has one answer everywhere.
2. **The server is the authority.** Client-side evaluation is **UX only** — it hides, disables, or
   read-onlys controls. Every request is re-checked server-side; a tampered client gains nothing.
3. **Least privilege, additive grants.** `effective(U) = rules(U) ∪ rules(groups(U))`
   ([FR-IAM-4](../requirements/05-functional-requirements.md#iam)) — grants only, no deny in the base
   model (deny is an optional extension, §7).
4. **Scope is part of the grant.** A permission is never global by accident: it carries channel,
   category-subtree, ownership and state scope ([FR-IAM-7](../requirements/05-functional-requirements.md#iam)).
5. **Field-level where it matters.** A write grant may name **field groups**, so "edit metadata but not
   rights" is expressible ([FR-UI-13](../requirements/05-functional-requirements.md#studio)).
6. **Pure & fast.** Evaluation is a pure function over data — no I/O, no DB call per check — so it is
   safe to run per-render in the UI and per-request on the server.

## 2. Model

```
User ──< Membership >── Group
 │                        │
 ├── Assignment ──────────┤        Assignment → Role | Rule
 │                        │
 └────────► Role ──< Rule (grant) >──► scope + fieldGroups
```

- **Rule (grant)** — the atomic unit: *these permissions, within this scope, on these field groups*.
- **Role** — a named, reusable bundle of rules ("Editor", "Scheduler").
- **Assignment** — attaches a role or a rule to a **user** or a **group**.
- **Effective policy** — the flattened union of everything reachable from the user (§4).

## 3. Permissions

A permission is `resource:action` — flat, greppable, and stable.

| Resource | Actions |
|----------|---------|
| `asset` | `read`, `write`, `approve`, `delete`, `restore` |
| `schedule` | `read`, `write`, `send`, `admin` |
| `workflow` | `read`, `act`, `admin` |
| `taxonomy` | `read`, `admin` (categories, structures, classifications, subjects, tags) |
| `people` | `read`, `admin` |
| `metadata` | `admin` (field schemas) |
| `feed` | `read`, `admin` |
| `user` | `read`, `admin` |
| `config` | `read`, `admin` (registries + settings — scoped by level; see [Configuration & Reference Data §8](configuration-and-reference-data.md#8-permissions)) |
| `logs` | `read` · `analytics` | `read` · `ops` | `read` |
| `storage` | `admin` · `compliance` | `admin` |

`*` is allowed as an action or resource wildcard (`asset:*`, `*:read`) — use sparingly.

### 3.1 Field groups (for `write`-type actions)

Writes can be narrowed to **field groups** rather than whole records:

| Resource | Field groups |
|----------|--------------|
| `asset` | `core` (title/description/…), `taxonomy` (category/structure/classification/subjects/tags), `cast`, `rights` (allowed count, recommended window, expiry), `shotlist`, `files`, `web` |
| `category` | `core`, `defaults`, `policies` (keep-duration, review-needed, media-addable), `epg`, `web` |
| `schedule` | `core`, `items`, `rights` |

A rule with **no** `fieldGroups` grants **all** groups for that permission.

## 4. Rule shape (the contract)

Machine contract: [`policy-rule.schema.json`](schemas/policy-rule.schema.json).

```jsonc
{
  "id": "01J9ZKQ2M8XABCDEFGHJKMNPQR",
  "effect": "allow",                       // "deny" only if the extension is enabled (§7)
  "permissions": ["asset:write"],
  "scope": {
    "channelIds": ["ch12"],                // omitted = any channel the user can see
    "categoryPaths": ["/sports/football/"],// matches this subtree (prefix on the materialized path)
    "states": ["ready"],                   // resource lifecycle states this applies to
    "ownedOnly": false                     // true = only resources created by the subject
  },
  "fieldGroups": ["core", "taxonomy"]      // omitted = all groups
}
```

**Category-subtree scoping** uses the category's **materialized `path`** ([data model §2](data-model.md#2-the-category-aggregate)),
so one grant covers a whole department/program branch by prefix — cheap on both sides, and correct for
a tree that nests ~20 deep.

## 5. Evaluation (normative)

```ts
// @atlas/policy — the SAME function on server and client.
function can(
  policy: EffectivePolicy,            // compiled grants + subjectId
  permission: string,                 // "asset:write"
  resource?: ResourceContext          // { type, channelId?, categoryPath?, ownerId?, state?, fieldGroup? }
): Decision;                          // { allowed: boolean; fieldGroups?: string[]; reason?: string }
```

A rule **matches** when **all** hold:

1. `permission` ∈ `rule.permissions` (respecting `*` wildcards);
2. every declared scope predicate is satisfied by the context — `channelIds` contains
   `resource.channelId`; some `categoryPaths` entry is a **prefix** of `resource.categoryPath`;
   `states` contains `resource.state`; `ownedOnly` ⇒ `resource.ownerId === policy.subjectId`.
   **An omitted predicate is "any"**;
3. if a `fieldGroup` was asked, it is in `rule.fieldGroups` (or the rule declares none).

**Decision:** `allowed` iff at least one `allow` rule matches (and, with the deny extension, no `deny`
rule matches). `Decision.fieldGroups` returns the **union** of groups granted by matching rules — this
is what Studio uses to decide which fields render editable vs read-only.

**Omitted context = broad question.** `can(policy, 'asset:write')` with no resource answers *"could this
user write **any** asset?"* — right for showing a nav item; the resource-specific check still runs at
the point of action and on the server.

### 5.1 Lenient vs strict — and why services must use strict {#51-lenient-vs-strict}

The "omitted predicate is any" rule has a sharp edge that surfaced while implementing the evaluator:
**an incomplete context makes a decision _more_ permissive, not less.** A rule scoped to
`channelIds: ['ch12']` matches *everywhere* when the caller supplies no `channelId`, because there is
nothing to fail the predicate against.

```ts
can(policy, 'asset:write', { categoryPath: '/news/' })              // ← channelId forgotten
// allowed: true  — a ch12-scoped rights grant matched outside ch12
```

That is correct for Studio, which deliberately asks broad questions. It is **wrong for enforcement**,
where forgetting a field must never widen a grant. So the evaluator has two modes:

| Mode | Call | Unsatisfiable predicate | Use |
|------|------|------------------------|-----|
| **Lenient** (default) | `can(policy, perm, ctx?)` | treated as "any" — matches | **Studio only** — show/hide/enable |
| **Strict** | `canEnforce(policy, perm, ctx)` or `can(…, { strict: true })` | **cannot match** | **Every service**, at the point of mutation |

**Normative:** a service enforcing a decision SHALL use `canEnforce` (or `strict: true`) and SHALL
pass the full resource context it holds. Lenient mode SHALL NOT be used as the security boundary.

Both modes agree whenever the context is complete — that equivalence is itself a test.

## 6. Delivery & caching

- **JWT stays small**: it carries `sub`, `channelId`, `permVersion` — **not** the rules.
- Studio (and each service, if it caches) fetches the compiled policy from
  **`GET /users/me/effective-permissions`** ([IAM](services/iam.md)) and caches it keyed by
  **`permVersion`**.
- Any grant/membership change **bumps `permVersion`** and emits [`permissions.changed`](schemas/events/permissions.changed.payload.schema.json);
  holders of a stale version are refused and refresh — revocation lands within one access-token TTL
  ([FR-IAM-8](../requirements/05-functional-requirements.md#iam)).
- Compilation (user + groups + roles → flat grants) happens **once per `permVersion`**, not per request.

## 7. Optional extension — explicit deny

Base model is additive ([FR-IAM-11](../requirements/05-functional-requirements.md#iam) keeps deny
Post-v1.0). If enabled, semantics are fixed: **deny overrides allow**, evaluated after all allows, with
the same scope matching. Deny is powerful and hard to reason about at scale — prefer narrowing scope.

## 8. Where each layer enforces

| Layer | Responsibility |
|-------|----------------|
| **API Gateway** | Authenticates (JWT via JWKS), rejects stale `permVersion`; does **not** make resource decisions. |
| **Owning service** | **The authority** — calls `can()` with the real resource context before mutating; also filters query results to permitted scope. |
| **Studio** | Calls the same `can()` to show/hide/disable/read-only. **Never** the security boundary. |

## 9. Starter roles

Ship these as defaults; operators clone and adjust ([FR-IAM-1](../requirements/05-functional-requirements.md#iam)).

| Role | Grants (sketch) |
|------|-----------------|
| **Viewer** | `asset:read`, `schedule:read`, `taxonomy:read` |
| **Journalist / Editor** | Viewer + `asset:write` (`core`,`taxonomy`,`cast`,`shotlist`), `workflow:act` |
| **Approver** | Editor + `asset:approve` (scoped to a category subtree) |
| **Scheduler** | Viewer + `schedule:write`; `schedule:send` usually a **separate** role (privileged, audited) |
| **Librarian** | `asset:write` (`files`,`rights`), `asset:restore`, `taxonomy:admin` |
| **Ops** | `ops:read`, `logs:read`, `storage:admin` |
| **Administrator** | `user:admin`, `metadata:admin`, `workflow:admin`, `feed:admin`, `compliance:admin`, `config:admin` |

## 10. Packaging — keep policy separate from IAM

**Recommendation: separate.** `@atlas/policy` is a **library**; IAM is a **service**. They are
different artifacts with different consumers, dependencies and release cadence.

```
@atlas/contracts   ── rule schema + generated types
        ▲
@atlas/policy      ── pure evaluator: can(), compile(), zero runtime deps, browser-safe
        ▲                    ▲                     ▲
   IAM service         other services            Studio
 (identity, tokens,   (enforce decisions)     (render decisions)
  compiles policy)
```

Why not merge them:

1. **Evaluation must be local.** Every service and every UI render calls `can()`; folding it into IAM
   invites a network call per check — the opposite of the "validate locally, never call IAM per
   request" design (§6).
2. **Browser safety.** Studio needs the evaluator but must not pull IAM's server dependencies (DB
   driver, password hashing, IdP/SAML libs). A pure library keeps the bundle clean.
3. **Dependency direction stays acyclic.** Everything depends on `policy`; `policy` depends on nothing
   (bar contract types). IAM depends on `policy` to validate/compile rules — merging inverts this and
   makes IAM a build-time dependency of the whole estate, including the front-end.
4. **Different cadence and scrutiny.** The decision function changes rarely and warrants security
   review; IAM's surface (SSO, MFA, user CRUD) changes often. Separate packages keep the audited core small.
5. **Testability.** A pure, dependency-free evaluator is trivially unit- and property-testable, and the
   cross-target contract tests (§11) need it importable in both a Node and a browser build.

**What lives where:** the **rule/permission schema + generated types** in `contracts`; the
**evaluator + policy compilation helpers** in `policy`; **identity, credentials, tokens, membership,
and serving the compiled effective policy** in the **IAM service**.

## 11. Consistency & testing

- The evaluator lives in **one shared package** (`@atlas/policy`) imported by every service **and**
  Studio — a second implementation is the bug.
- **Contract tests** run a table of (policy, permission, context) → expected decision on both build
  targets, so client and server can never disagree.
- Every authorization **denial is audited** ([FR-AUD-1](../requirements/05-functional-requirements.md#audit));
  access to raw logs is itself audited.

---
_Related: [IAM spec](services/iam.md) · [Identity data model](data-model.md#4-the-identity-aggregate) ·
[Studio field permissioning](studio-frontend.md) · [FR-IAM](../requirements/05-functional-requirements.md#iam)._
