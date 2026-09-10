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

## Seed-as-code (EP-06.6)

`@atlas/reference/seed` — a **separate entry point**, because it reads files and this one is
browser-safe. That was the option this README already named, and it beat putting it in
`@atlas/data`: the loader is almost entirely about descriptors and validation, which live here.

```ts
import { readSeedDirectory, applySeed } from '@atlas/reference/seed';

const { entries, problems } = await readSeedDirectory('seed/reference');
const result = await applySeed(registry, entries, existingRows, (rows) => store.put(rows));
```

A seed file is an array of `{ key, level?, scopeId?, value }`, or `{ "settings": [...] }`. **Keys
are fully qualified** — `hsm.restore.concurrency`, not `restore.concurrency` — and that is
load-bearing, not style. See below.

**It never overwrites.** [§6](../../docs/architecture/configuration-and-reference-data.md#6-seed-as-code--environment-promotion)
says import is "additive and idempotent … never a destructive replace", and that one sentence is
most of the design. A row that exists with a different value is an operator's deliberate edit, made
through the admin UI this whole subsystem exists to provide; a loader that restored defaults over it
on every boot would be a factory reset that runs at each restart — at the moment nobody is watching.
Those rows come back as `preserved`, so a boot log and the drift report of §6 have something to say.

**Nothing is written if anything is invalid.** A seed file is reviewed and applied as a unit, and a
partial apply is the worst available outcome: half the defaults present, no error state to notice,
and a rerun reporting "unchanged" for exactly the half that landed.

**Ambiguous keys are refused.** A stored `SettingRow` carries the **bare** key and `resolveSetting`
matches on it, while the registry is keyed `area.key`. So if two areas both declare
`restore.concurrency`, one row satisfies both descriptors and seeding either would silently set the
other. The loader is the first thing that writes a row from a qualified name, which makes it where
this becomes visible — and it refuses rather than picking one. Renaming one of the two is the fix;
a `SettingRow` that recorded its area would be the deeper one.

**No caller yet.** Nothing stores settings rows — there is no settings table in any service — so the
loader is complete, tested, and unwired. It is deliberately shaped to be wired later: the writer is
injected, so a service at boot and a CLI can share it, and `planSeed` is pure so `--dry-run` and the
drift report come for free.

## Tests

```bash
npx nx test @atlas/reference   # 33 tests
```
