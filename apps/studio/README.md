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
**EP-11.4** — the WebSocket client: desired-set subscriptions (queued until the socket opens),
exponential-backoff reconnect, re-subscribe on open. **The `/ws` endpoint now exists** (EP-13.2). It
is not behind the gateway — `fetch` cannot upgrade a protocol — so production routes `/ws` to the
WebSocket service by ingress path rule while everything else goes to the gateway, and
[`proxy.conf.json`](proxy.conf.json) does the same for `npm start` by forwarding it to the dev
NodePort with `"ws": true`. Either way the app sees one origin, which is why none of this reaches
`websocket.service.ts`.
**EP-11.5** — generated API types checked against the IAM and MAM OpenAPI contracts.
**EP-11.6** — i18n/RTL: runtime locale files (en/ar), a `LocaleService` that flips `<html dir>`,
and the design-token theme (light/dark via `prefers-color-scheme`). See
[i18n is RUNTIME, not Angular's build-time `$localize`](#i18n-is-runtime-not-angulars-build-time-localize)
and [Every colour is a token, and every token is declared](#every-colour-is-a-token-and-every-token-is-declared).
**EP-11.7** — `can()` integration: permission-driven rendering.
**EP-20.1** — the Media panel: real recent/search/tag-filter reads from MAM.
**EP-20.2** — the asset editor: real Basic-info reads and minimal PATCHes,
dirty-state tracking, independent `core`/`taxonomy`/`rights` field-group rendering, and the Files
rendition-readiness view. Per-file rows await the MAM FileRef projection (EP-17.8).
**EP-20.3** — the Ingest panel: queue, quarantine accept/reject — **built but not routed**: RIM
(EP-15) does not exist and the gateway has no `/api/v1/ingest` route, so the panel is
`available: false` until the service lands. Upload is the same story one level down: the button is
rendered **disabled**, because EP-15.1's chunked-upload endpoint has nothing to POST to.
**EP-20.4** — the Search panel: simple query against MAM search, results open in the asset editor.
**EP-20.6** — the dashboard: an editor tab opened as the default landing view — system-state
counts and what's-new against real MAM, live-refreshed. State counts page the channel with a
1000-asset cap; a real counts endpoint is a follow-up.
**EP-20.9** — live updates: panels and the asset editor subscribe to `atlas.<channel>.asset.>`
and reconcile by refetch; a live event never clobbers a dirty form.

**Not built:** Schedule and later editor types remain placeholders until their owning services
exist.

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

Asset tabs render the real [`asset-editor.ts`](src/app/editors/asset-editor.ts). Every tab pane stays
mounted while another tab is active; otherwise switching tabs would destroy unsaved form state
while the tab continued to display its dirty dot. Saves send only changed fields and clear the dot
only after MAM returns successfully. A failed save leaves the edits and dirty state intact.

The Basic-info form asks `PermissionService` separately for `core`, `taxonomy`, and `rights`, so a
role can edit a title without also changing expiry or classification. These checks are affordances;
MAM repeats them server-side with strict resource context. The Files tab shows the core record's
container and rendition readiness today. Individual checksums, storage tiers and technical rows
wait for the FileRef mirror (EP-17.8) rather than being synthesized in Studio.

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

## API types come from the contract (EP-11.5)

`src/app/core/generated/*.types.ts` is generated from `docs/architecture/openapi/*.yaml` and checked
in, so a type change shows up as a reviewable diff in a pull request rather than materialising
during a build.

```sh
npm run api:types    # regenerate
npm run api:check    # fail if the checked-in output is stale — runs in CI
```

**It found drift on the first run.** `iam.yaml` called the permission version `permissionVersion`
while [FR-IAM-14](../../docs/requirements/05-functional-requirements.md#iam), the JWT claim, the
`x-atlas-perm-version` header and every line of code called it `permVersion` — and the contract
omitted `expiresIn` entirely. Nothing had ever compared the two, because until now the OpenAPI stubs
were documentation only: referenced in comments, parsed by nothing. The contract was corrected.

`api:check` is a **separate CI step**, not part of `nx test`. Nx skips unaffected projects, and
editing `docs/architecture/openapi/*.yaml` touches no project — so the one change that can cause
drift is exactly the one an affected-only run would ignore.

The generator formats its output with the repo's prettier config before writing _or_ comparing.
Otherwise `api:check` and `format:check` contradict each other, and two required checks that cannot
both pass is a build nobody can fix.

It handles a deliberately narrow subset of JSON Schema and **throws** on anything else, rather than
emitting `unknown` — a generator that quietly degrades puts the drift back one field at a time.

**A file in `generated/` must be in the generator's `SPECS` list.** `rim.types.ts` shipped with the
`GENERATED FROM … — DO NOT EDIT` banner on it while `SPECS` named only `iam.yaml` and `mam.yaml`, so
`api:check` never looked at it — and it had already drifted: `channelId`, `source` and `sizeBytes`
were typed **required** where `rim.yaml` leaves them optional. That is how the Ingest panel came to
render `NaN GB` for a response the contract explicitly allows, with a green build and a banner
telling the next reader not to touch the file. The banner is a promise; the list is what keeps it.
Adding a service's client means adding its contract here in the same change.

## i18n is RUNTIME, not Angular's build-time `$localize`

`LocaleService` fetches `/locales/<locale>.json` and `t('a.b.c')` walks the dot path, so switching
language is a signal write — no reload, no second bundle. Angular's own i18n is the opposite: an
`i18n` block in `angular.json` compiles **one bundle per locale** from `$localize`-marked messages
in XLIFF/XLB/ARB at build time.

The two are unrelated, and `angular.json` briefly carried both. Its `i18n.locales.ar` pointed at
`src/locales/ar.json` — the runtime translation map, which is not a translation file in any format
Angular's loader accepts. It was inert only because nothing passes `--localize`; the first person to
try would have got a build error from a file that looked deliberate. It is gone. What actually makes
translations work is the **assets** entry that copies `src/locales` to `locales/` in the output:

```jsonc
{ "glob": "**/*", "input": "src/locales", "output": "locales" }
```

Without it, every `t()` call silently returns its own key — which is a UI full of `mediaPanel.search`
rather than a visible failure. A new locale is a JSON file plus an entry in the status-bar selector.

**Keys, not literals, for anything a user reads.** The activity bar rendered a hard-coded English
panel name while `workbench.panels.*` sat unused in both locale files, so the one navigation control
in the shell stayed English in Arabic. `PanelDefinition` carries a `titleKey`, never a `title`.

**RTL is more than `dir`.** The workbench is a CSS grid and grid tracks run along the **inline**
axis, so `dir="rtl"` moves the activity bar and side bar to the right of the screen. Anything that
measures in physical pixels has to flip with it: the side-bar divider's drag arithmetic and arrow
keys multiply by `locale.direction() === 'rtl' ? -1 : 1`, or the side bar shrinks when you drag it
open. Prefer logical CSS properties (`inline-size`, `margin-inline-start`, `border-inline-end`); for
the few that have no logical form — `box-shadow`, notably — add a `[dir='rtl']` rule.

## Every colour is a token, and every token is declared

Components read design tokens and never a literal colour, so a theme is a token set rather than a
restyle ([studio-frontend.md §5](../../docs/architecture/studio-frontend.md#5-theming)). The set
lives in [`src/styles.scss`](src/styles.scss), declared twice: `:root` for light and a `dark-tokens`
mixin applied under both `prefers-color-scheme: dark` and an explicit `[data-theme='dark']`.

**A token a component reads must exist in both palettes.** An undefined custom property is invalid
at computed-value time, so `var(--nope)` does not fail — it quietly falls back to the inherited
value. Three panels shipped reading fourteen tokens that were never declared (`--color-text-muted`,
`--color-surface`, `--color-primary`, the whole status set), which made the ingest accept/reject
buttons white-on-transparent and error text the same colour as body text. Lint, typecheck and the
whole test suite were green throughout: CSS has no "no such token" error.

Two rules that follow from the palette inverting between themes:

- `--color-<status>` is a **foreground** and `--color-<status>-bg` is the tint it is legible on.
  They are not interchangeable.
- **Never fill a control with a status colour and write on it in `white`.** The light palette's
  danger is dark and the dark palette's is bright, so one hard-coded foreground fails WCAG in one of
  the two. Status buttons are outlined in `currentColor`.

## Toolchain divergence, on purpose

Studio is the one project that **emits**, and it ships its own toolchain:

- **TypeScript 6.0** (Angular 22 requires it) while the libraries are on **5.9**. npm keeps it
  nested under `apps/studio/node_modules`. Do not try to unify them — the libraries' `tsc` is
  unaffected.
- **vitest**, not `node:test`, because component tests need a DOM. **All spec files share that
  DOM**: the builder defaults `isolate: false`, so `localStorage` carries between files, and
  `EditorStore` persists the workspace there. `src/test-setup.ts` clears storage before every test
  — the leak it closes passed on every PR and failed on `main`, depending on which files shared a
  worker.
- **Its own `tsconfig.json`**, not `tsconfig.base.json`: Angular needs `module: preserve` and its
  own compiler options. The workspace's _strictness_ is reproduced explicitly there instead, so
  Studio is held to the same bar.
- **`rewriteRelativeImportExtensions`** rather than `allowImportingTsExtensions` alone — the
  `@atlas/*` libraries have no build step and their imports carry `.ts` extensions, but this
  project emits, and the bare flag is illegal when emitting.
