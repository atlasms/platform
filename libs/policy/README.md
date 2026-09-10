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
(policy, permission, context) → expected decision. It imports only types, which is what lets the
**same table** be run against a browser build.

**EP-05.5 / EP-05.6 — the browser half is now checked, not asserted.**
[`test/cross-target.ts`](test/cross-target.test.ts) bundles the evaluator with esbuild exactly as a
browser would receive it, evaluates it in a `vm` context containing **nothing** — no `process`, no
`require`, no `Buffer` — and puts every case from the shared table through both targets, in both
lenient and strict mode, comparing the full `Decision` including `fieldGroups`.

That replaces a proxy with the property. The old guard scanned `src/` for `node:` imports, which
cannot see a bare `process.env` reference because there is no import to find; the empty realm throws
on one.

Two things worth knowing before editing that file:

- **`deepStrictEqual` compares prototypes across realms.** A value built inside the `vm` carries
  that realm's `Array.prototype`, so two decisions that print identically still fail. Both sides are
  round-tripped through JSON, which is lossless for a `Decision` and compares values rather than the
  realm they were born in. The first run of the test failed exactly this way.
- **There is a size budget** — 2560 B gzipped, against ~1.1 kB today. Studio ships this to every
  browser on every load, and a shared library grows one defensible convenience import at a time.
  Raising it should happen in the commit that needs it, with a reason.
