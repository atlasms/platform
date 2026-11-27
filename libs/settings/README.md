# @atlas/settings — Tier-3 settings, served by the service that acts on them

Design: [Configuration & Reference Data §2.4–2.5, §5, §7–8, §11](../../docs/architecture/configuration-and-reference-data.md).

`@atlas/reference` declares a setting and validates and resolves a value. `@atlas/data` and
`@atlas/data-pg` store a value at a level (the `settings` table every service is given). This
package is the part between them that each owning service would otherwise write for itself:

- **who may write a level**: `config:admin` in the caller's own channel for `channel`; an UNSCOPED
  grant for `deployment` (a channel's grant cannot reach it); a `user` value is the caller's own
  and needs no permission. A descriptor's `permission` replaces `config:admin` for its key, and
  `category` is refused until an owner of categories wires the subtree check;
- **what a reader sees**: each descriptor, what it resolves to for the caller and from which level,
  the rows behind it, and the levels the caller may write. A sensitive value is never shown;
- **what a write commits**: the row (compare-and-set on its `version`), the `audit.recorded`
  (entity `setting`, id `<area>.<key>@<level>[:<scopeId>]`, sensitive values `(changed)`), and the
  `config.changed`.

It **plans**; the service **commits**, because the service owns the transaction and the outbox.

```ts
// beside the code that reads the setting
export const mamSettings = defineSettings('mam', {
  'review.rejectedRetention': { type: 'duration', scope: 'channel' },
});
const admin = new SettingsAdmin(mamSettings);

// PUT /settings/mam/{key}?version=
const scope = admin.scopeOf(caller, body.level, body.scopeId);
const existing = await store.setting(key, scope.level, scope.scopeId); // read BEFORE the tx
const write = admin.planSet(caller, key, scope, body.value, existing, version, new Date());
await store.transaction(async (tx) => {
  const configVersion = await tx.putSetting(write.row, write.ifVersion); // bumps the snapshot
  await tx.enqueue(record('audit.recorded', write.audit));
  await tx.enqueue(record('config.changed', write.changed(configVersion)));
});
```

**A reset keeps the row** (`set: false`): the row's version is the setting's audit revision at that
level. A deleted row would restart at 1, which the audit sink already holds and would refuse.

**`SettingsCache`** holds a service's rows per channel for a TTL (10 s by default), so a setting is
never read row-by-row per request (§5). Clear it after your own write, and on every
`config.changed` for your area, subscribed in **broadcast** mode so every replica hears it.

MAM is the first owner: [`apps/mam/src/settings.ts`](../../apps/mam/src/settings.ts), mam.md §13ad.
