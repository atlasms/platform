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
**EP-11.2** — the sign-in flow: real tokens from IAM, refresh, sign-out.
**EP-11.3** — the workbench: tabbed and splittable editor groups, drag between groups, a resizable
side bar, workspace persistence.
**EP-11.7** — `can()` integration: permission-driven rendering.

**Not built:** the WebSocket client (**EP-11.4**), generated API clients (**EP-11.5**), and the full
token system with i18n/RTL (**EP-11.6**). Editor _contents_ are placeholders — rendering an actual
asset or schedule needs those services (EP-17 onward).

## Signing in

Studio starts **anonymous**. There is no seeded session any more, so everything downstream renders
from the policy IAM actually returns rather than from grants we wrote for ourselves.

`npm start` proxies `/auth` and `/api` to the gateway on `localhost:30080`, so the dev server talks
to a real deployed cluster ([infra/k8s](../../infra/k8s/)) — `npm run k8s:up` first.

**Tokens live in memory, and only in memory.** Not `localStorage`, not `sessionStorage`: both are
readable by any script on the origin, so persisting the **refresh** token hands a long-lived
credential to a single XSS. The cost is deliberate — a page reload signs you out. The fix is not a
safer-looking storage key, it is for IAM to set an **httpOnly, SameSite=Strict cookie** so the
browser can present the refresh token without Studio ever holding it. That needs a server change,
and it is the follow-up [`auth.service.ts`](src/app/core/auth.service.ts) is waiting for.

**Refresh is single-flight, and that is correctness rather than efficiency.** IAM rotates refresh
tokens and treats a reused one as a breach signal — it revokes the whole token family, signing the
user out everywhere. Two requests refreshing concurrently is the _normal_ case when a token expires
while a screen is loading, so a refresh in progress is shared rather than started twice.

The interceptor retries a 401 **exactly once**. A second 401 is a real answer — the grant was
revoked, or the session is over — and retrying again would loop against a server that has said no.

## The editor area

The interesting behaviour is a state machine, so it lives in [`editor.model.ts`](src/app/workbench/editor.model.ts)
as plain data and pure functions, with the Angular store a thin wrapper. That is what let it be
tested exhaustively without rendering anything — 24 tests covering the cases editors usually get
subtly wrong:

- **Opening an already-open item focuses it**, wherever it lives, rather than creating a second tab.
  Two tabs over one resource would each accumulate unsaved edits and whichever saved last would
  silently win.
- **Closing moves focus right, or left when the closed tab was last** — what every editor has
  trained people to expect.
- **An emptied group is removed** and focus falls to a survivor, whether it emptied by closing or by
  dragging the last tab out. A stranded empty pane is the classic bug here.
- **Pinned tabs survive "close others" and "close all"** — that is what pinning is for.
- **Splitting a single-tab group is refused**, since it would empty the source and achieve nothing.

Workspace persistence ([FR-UI-3](../../docs/requirements/05-functional-requirements.md#studio)) is
localStorage for now; the requirement is server-side, which needs an endpoint that does not exist
yet. It sits behind the store API, so swapping it is a change in one file. **Dirty state is
deliberately not persisted** — unsaved edits do not survive a reload, so restoring a tab still
marked dirty would promise changes that are gone. Restored data is validated rather than trusted:
localStorage is user-writable and survives deploys, and booting into a crash because someone edited
devtools is not acceptable.

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
