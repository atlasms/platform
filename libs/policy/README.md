# @atlas/policy — the authorization evaluator

The **same** decision function runs in every service (to **enforce**) and in Studio (to **render**).
A second implementation would be the bug. Design:
[Authorization Model](../../docs/architecture/authorization-model.md) · grant contract:
[`policy-rule.schema.json`](../../docs/architecture/schemas/policy-rule.schema.json).

**Zero runtime dependencies, no Node built-ins** — Studio imports this, and a test enforces both.

## API

```ts
import { can, canEnforce, compile } from '@atlas/policy';

// Once per permVersion, not per request:
const policy = compile({ subjectId, permVersion, rules, roles, groups });

// In a service — STRICT. Pass the full context you hold.
canEnforce(policy, 'asset:write', {
  channelId: 'ch12',
  categoryPath: '/sports/football/',
  state: 'ready',
  ownerId: asset.createdBy,
  fieldGroup: 'rights',
}); // -> { allowed, fieldGroups?, reason? }

// In Studio — lenient is fine, the question is broad.
can(policy, 'asset:write'); // "could I write any asset?" -> show the nav item
```

## ⚠️ Use `canEnforce` in services

Lenient mode treats a predicate it cannot check as "any", so **an incomplete context yields a
_wider_ answer**:

```ts
can(policy, 'asset:write', { categoryPath: '/news/' }); // channelId forgotten
// -> allowed: true, via a rule scoped to a channel you never named
```

`canEnforce` refuses instead: a declared predicate with nothing to check against cannot be
satisfied. Both modes agree once the context is complete —
[§5.1](../../docs/architecture/authorization-model.md#51-lenient-vs-strict) is normative, and the
equivalence is a test.

## Semantics worth knowing

- **Additive.** `allowed` iff at least one `allow` rule matches. `deny` (the optional extension)
  overrides and short-circuits, in any rule order.
- **`Decision.fieldGroups` is the union** of groups granted by matching rules, sorted.
  **`undefined` means _all_ groups** — some matching rule declared no `fieldGroups`. It is never an
  empty array when `allowed`.
- **Category scoping is a prefix match on the materialized path**, forced to segment boundaries:
  a grant on `/sports/football/` does **not** cover `/sports/footballing-legends/`. That guard is a
  test, not an accident.
- **Asking for a wildcard is not the same as holding one.** `can(policy, 'asset:*')` is the question
  _"may I do everything to assets?"_ and is not answered by a grant of `asset:read`.
- **Every denial carries a `reason`** — denials are audited
  ([FR-AUD-1](../../docs/requirements/05-functional-requirements.md#audit)).

## Tests

```bash
npx nx test @atlas/policy
```

[`test/decision-table.ts`](test/decision-table.ts) is the shared contract fixture: a table of
(policy, permission, context) → expected decision. It imports only types, so the **same table** can
be run from a browser build to prove client and server agree (EP-05.5) once the Studio shell exists.
