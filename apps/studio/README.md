# `@atlas/studio`

Studio is Atlas' **only** user-facing interface ([studio-frontend.md](../../docs/architecture/studio-frontend.md)):
an Angular SPA shaped as a VS Code-style workbench.

```sh
npm start -w @atlas/studio     # dev server
npm run build -w @atlas/studio
npm test -w @atlas/studio
```

## What is built

**EP-11.1** — app skeleton, permission-matched lazy routing, build pipeline.
**EP-11.7** — `can()` integration: permission-driven rendering.

**Not built:** the interactive workbench (**EP-11.3**) — tabbed and splittable editor groups,
drag between groups, resizable/reorderable views, workspace persistence. The editor area is
currently one router outlet. Also outstanding: the real auth flow (**EP-11.2** — a dev session is
seeded in `app.config.ts` so the shell is exercisable), the WebSocket client (**EP-11.4**),
generated API clients (**EP-11.5**), and the full token system with i18n/RTL (**EP-11.6**).

## Authorization: Studio decides what to SHOW

Every check here is UX. The owning service re-checks each request with `canEnforce()`, so a wrong
answer in the browser is a cosmetic bug, not a security hole
([authorization-model.md §1](../../docs/architecture/authorization-model.md)).

That asymmetry is what makes the default correct: **`PermissionService` uses lenient `can()`, and
that is deliberate.** Lenient evaluation answers the broad question — _"could this user edit any
asset?"_ — which is what showing a nav item actually asks. The failure modes are not symmetric:

- hiding a control the user _could_ have used is a real failure — the feature is undiscoverable and
  the app looks broken;
- showing one they cannot use costs a rejected request and an error message.

**Do not "fix" this to `canEnforce()`.** It would hide legitimate UI whenever a check runs before
the resource has loaded, which is most of them. `canStrict()` exists for the rare case where the
full context is known and a false affordance would be actively harmful — a destructive action.

Checks are automatically scoped to the signed-in channel, because under lenient evaluation an
omitted `channelId` means _any_ channel, which would light up controls for tenants the user cannot
reach.

```html
<button *atlasIfCan="'asset:write'">New asset</button>
<button *atlasIfCan="'asset:delete'; strict: true; resource: ctx">Delete</button>
<div *atlasIfCan="'schedule:read'; else noAccess">…</div>
```

Panels are permission-matched with `canMatch`, not `canActivate`: a route the user cannot open
never matches, so the router falls through to the catch-all rather than navigating then bouncing —
and the panel's chunk is never fetched.

## Toolchain divergence, on purpose

Studio is the one project that **emits**, and it ships its own toolchain:

- **TypeScript 6.0** (Angular 22 requires it) while the libraries are on **5.9**. npm keeps it
  nested under `apps/studio/node_modules`. Do not try to unify them — the libraries' `tsc` is
  unaffected.
- **vitest**, not `node:test`, because component tests need a DOM.
- **Its own `tsconfig.json`**, not `tsconfig.base.json`: Angular needs `module: preserve` and its
  own compiler options. The workspace's _strictness_ is reproduced explicitly there instead, so
  Studio is held to the same bar.
- **`rewriteRelativeImportExtensions`** rather than `allowImportingTsExtensions` alone — the
  `@atlas/*` libraries have no build step and their imports carry `.ts` extensions, but this
  project emits, and the bare flag is illegal when emitting.
