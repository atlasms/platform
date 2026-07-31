# @atlas/reference — admin-editable runtime configuration

Declare a setting **in code**; store only its **value**. That is what makes the admin UI
generatable, the validation identical on server and client, and the change auditable.

Design: [Configuration & Reference Data](../../docs/architecture/configuration-and-reference-data.md) ·
contract: [`setting-descriptor.schema.json`](../../docs/architecture/schemas/setting-descriptor.schema.json).

**Zero runtime dependencies, no Node built-ins** — Studio imports this, and a test enforces both.

> Not to be confused with the top-level [`reference/`](../../reference/) directory, which is the
> frozen prototype being lifted into `libs/`. This is the config library.

## Declare

```ts
export const hsmSettings = defineSettings('hsm', {
  'restore.concurrency': { type: 'int', default: 4, min: 1, max: 64, scope: 'channel' },
  'checksum.algorithm': {
    type: 'oneOf', default: 'sha256',
    options: [{ value: 'sha256' }, { value: 'xxh3' }],
    scope: 'deployment', restart: true,
  },
});
```

Malformed declarations throw **at module load**, not at first use — a typo in a setting should
stop the service starting, not surface as a mysterious validation failure weeks later.

## Validate and resolve

```ts
validateWrite(descriptor, 8, 'channel');       // bounds + level in one place
resolveSetting(descriptor, rows, { channel: 'ch12' });
// -> { value: 16, origin: 'channel', scopeId: 'ch12', overridable: false }
```

Resolution is **nearest-wins** along `default → deployment → channel → category → user`, and
returns the **origin** so Studio can render *"inherited from channel"* with a **Reset to
inherited** action.

## Two guards that are tests, not conventions

**A row deeper than the descriptor's `scope` is ignored, not honoured.** A deployment-scoped knob
such as `checksum.algorithm` cannot be silently overridden per user because a stale row exists.

**A registry entry whose `kind` the running code does not declare is refused.** This is the whole
Tier-1 safety property: it stops an admin creating `mediaType: "hologram"`, for which MTS has no
profile, HSM no tier policy and Studio no player — a failure that would otherwise appear far away
and long after the edit.

## Snapshot client

```ts
const client = new SnapshotClient({ url: '/api/v1/reference' });
await client.refresh();                       // ETag-revalidated
client.hasVocabularyTerm('classification', 'news');   // in-memory, no I/O
await client.onConfigChanged({ configVersion });      // only refetches for a NEWER version
```

Reference data is read from a **versioned snapshot**, never row-by-row per request. A failed
refresh **keeps the previous snapshot** — an unreachable config endpoint must not take a service
down, and an air-gapped site runs from stale local state
([FR-PLat-7](../../docs/requirements/05-functional-requirements.md#platform)).

## Not implemented yet

**EP-06.6, the seed loader.** It reads version-controlled seed files, which makes it Node-only —
it cannot live in this browser-safe entry point. It belongs beside the migration runner in
[`@atlas/data`](../data/), or behind a `@atlas/reference/seed` subpath export. Deliberately
deferred rather than compromising the browser-safety guarantee.

## Tests

```bash
npx nx test @atlas/reference   # 17 tests
```
