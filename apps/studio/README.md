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
**EP-11.4 / EP-09.4** — the WebSocket client: desired-set subscriptions (queued until the socket
opens), jittered exponential-backoff reconnect, re-subscribe on open, a client heartbeat, and the
**re-sync / polling fallback** (NFR-AVAIL-7) — see below. **The `/ws` endpoint now exists** (EP-13.2). It
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
tab: the asset's **file rows** from MAM's FileRef mirror (EP-17.8), and its **transcode jobs** from
MTS (EP-16) — see [The Files tab](#the-files-tab-file-rows-and-transcode-jobs).
**EP-20.3** — the Ingest panel: **upload**, queue, quarantine accept/reject, against RIM through
the gateway (EP-15.1/15.3/15.4/15.6). Upload hands each picked file to the uploader
([`upload.service.ts`](src/app/core/upload.service.ts)); when its job has a verdict, the row joins
the queue at the top. **EP-20.8** — the transfer tray
([`transfer-tray.ts`](src/app/workbench/transfer-tray.ts)): bottom corner of the frame,
minimizable, grouped progress and per-transfer cancel/retry/dismiss. See below.
**EP-20.4** — the Search panel: simple query against MAM search, results open in the asset editor.
**EP-20.7** — user management (basic): the **Admin** panel's first view, Users, revealed by
`user:admin` — the keyset list, a new user, and each user as an **editor tab**
([`user-editor.ts`](src/app/editors/user-editor.ts)): the display name (the one dirty field),
disable/enable/unlock with the consequence on the button (disabling signs the user out
everywhere), a new password, and the direct grants — a role from the channel's and the starter
roles, or an inline rule (permissions, scoped to the user's channel, a ULID minted in the
browser) — each its own request against IAM (EP-10.4/10.6), because each is its own audited
mutation there. Disabling yourself is refused in Studio before IAM refuses it.
The panel's **Groups** and **Roles** views follow the same shape
([`panels/admin/`](src/app/panels/admin/)): a list, a create form, and the item as an editor
tab. A group ([`group-editor.ts`](src/app/editors/group-editor.ts)) has its profile (the dirty
pair), its members — added and removed by IAM's member calls, offered from the users not yet in
it — and its grants (roles and inline rules, PATCHed as the whole set, the page saying a change
reaches every member at once); deleting it closes the tab. A role
([`role-editor.ts`](src/app/editors/role-editor.ts)) has its profile and its rules, PATCHed the
same way; a **platform-wide** role (the starter roles, no `channelId`) is shown, not offered for
editing, since IAM would refuse; deleting a role something still holds is IAM's 409, shown as
such. It also shows **who holds it** — the groups that carry it and every person it reaches,
each listed once with the groups they come through — because a rule change above reaches all of
them at once. A role is granted and revoked from here too: one select offers both users and
groups, a group is a PATCH of its roles and a user is a grant, and only a **direct** grant is
revocable here (someone the role reaches through a group is unpicked at the group row, which is
where that fact lives). The holders are re-read after each write rather than patched in the
browser: the answer is IAM's join across assignments, groups and memberships, and reproducing it
client-side would be a second implementation of the thing on screen. A platform-wide role's
holders span every channel, so IAM answers only an unscoped `user:admin` — the page says that
instead of showing an error. Field schemas and theme are the panel's later views.
**EP-20.6** — the dashboard: an editor tab opened as the default landing view — system-state
counts and what's-new against real MAM, live-refreshed. State counts page the channel with a
1000-asset cap; a real counts endpoint is a follow-up.
**EP-20.9** — live updates: panels and the asset editor subscribe to `atlas.<channel>.asset.>`
and reconcile by refetch; a live event never clobbers a dirty form.

**EP-20.5** — the schedule editor v0: the Schedule panel (pick a broadcast day, open or create
its program table) and the reel editor tab — add, move, resize, remove, and one save. See
[The schedule editor owns reel correctness](#the-schedule-editor-owns-reel-correctness-ep-205).

**Not built:** Newsroom and later editor types remain placeholders until their owning services
exist.

## The uploader obeys the server, and resume is just another attempt (EP-20.3, EP-20.8)

RIM's upload is chunked and resumable ([apps/rim/README.md](../rim/README.md)), and **the
server sizes the parts**: `POST /uploads` answers `partSizeBytes` and `partCount`, and the file is
sliced exactly that way — every part but the last exactly that long, a part of any other length is
a 422. Parts go one at a time as `application/octet-stream` with the request's upload progress
counted into the bar, so it moves inside an 8 MiB part and not only between them.

A part that fails on the way — a dropped connection, a 502 — is sent again up to three times with
a growing pause. A part the server **refuses** (4xx) is not: the same bytes would be refused the
same way, and the transfer fails with the problem document's message. A failed transfer keeps its
`uploadId`, and **Retry** in the tray is one more attempt: `GET /uploads/{id}` says which parts the
server already holds, and only the rest are sent. An upload swept meanwhile (past RIM's TTL) is
started over rather than retried forever. **Cancel** aborts the request in flight and abandons the
upload server-side.

Completion is a hand-off: `POST /complete` answers the job at `detected`, and the verdict — the
probe, the acceptance rules — follows on the server, so the transfer polls `GET /ingest/{id}` until
the state settles and shows _that_ as its result: accepted, quarantined (with the reason),
rejected. The tray is in the workbench frame, not in the panel, because an upload must outlive the
panel that started it — navigating away from Ingest does not abort a 4 GB master. What a reload
loses is the tray's list, not the parts: they are on the server, and the next attempt at the same
file resumes them. [`upload.service.spec.ts`](src/app/core/upload.service.spec.ts) asserts every
request of every path above by method and URL against a fake gateway.

## Signing in

Studio starts **anonymous**. There is no seeded session any more, so everything downstream renders
from the policy IAM actually returns rather than from grants we wrote for ourselves.

**Nothing is reachable without a session.** `/signin` is a full-screen, top-level route — not a
panel in the side bar — and the workbench is the guarded parent of every panel route
([`app.routes.ts`](src/app/app.routes.ts)): a signed-out caller at any URL is sent to `/signin`
with a `returnUrl` to come back to, and the frame (activity bar, status bar, editor area) is never
constructed for them. A caller who already has a session is sent off `/signin` the same way.
[`app.routes.spec.ts`](src/app/app.routes.spec.ts) builds the Router from the real table and
walks both directions; the dev cluster's seed account is `dev` / `dev-password`.

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
MAM repeats them server-side with strict resource context.

### The Files tab: file rows and transcode jobs

The **rows** are MAM's FileRef mirror (EP-17.8) — kind, tier, status, size, checksum, path — read on
entering the tab and again on a live event for the asset. Under them, the asset's **transcode jobs**
([`transcode-jobs.ts`](src/app/editors/transcode-jobs.ts)) from MTS (EP-16): queued, running with a
progress bar, waiting to retry with the reason and the retry time, given up with the reason, or done
with its rendition count, newest first.

- **The bar moves live; the state is polled.** MTS announces progress on
  `live.<channel>.transcode.progress` (EP-16.4) — kept by nothing, so the tab applies each frame to
  the job it names (forward only: frames are at most once and may arrive late) and shows FFmpeg's
  realtime factor beside it; a frame for a job the view has not seen reads the list at once. The
  poll reports STATE (queued → running → completed) — every 2 s while the socket is down, every
  10 s while it is live — only while a job is moving, skipping a tick while the page is hidden, and
  dies with the tab. A tab opened after the ticks went by reads `percent` from the job row.
- **A completion is followed through to MAM.** When a job the view watched completes, the editor
  re-reads the rows until they carry the job's rendition **checksums** — not its kinds, because a
  row of the same kind may be a previous transcode's — once a second, fifteen times at most. MTS's
  completion and MAM's mirror are two consumers of one event with a broker between them, so the
  first read after it may still be the old rows.
- **Read-only.** Starting a transcode needs an input path in MTS's work area, which nothing in the
  browser knows until HSM (EP-14) resolves inputs. A caller without `asset:read` on `files` does not
  see the section at all (a 403 hides it).

Workspace persistence ([FR-UI-3](../../docs/requirements/05-functional-requirements.md#studio)) is
localStorage for now; the requirement is server-side, which needs an endpoint that does not exist
yet. It sits behind the store API, so swapping it is a change in one file. **Dirty state is
deliberately not persisted** — unsaved edits do not survive a reload, so restoring a tab still
marked dirty would promise changes that are gone. Restored data is validated rather than trusted:
localStorage is user-writable and survives deploys, and booting into a crash because someone edited
devtools is not acceptable.

## The schedule editor owns reel correctness (EP-20.5)

The scheduling service's write path is **thin** — it stores the starts it is given and refuses
nothing about their arrangement ([data-model §3.4](../../docs/architecture/data-model.md),
FR-SCH-9) — so the arrangement is decided here, in
[`editors/reel.model.ts`](src/app/editors/reel.model.ts): plain data and pure functions, like the
editor area's model, tested without rendering anything (18 cases). Three rules:

1. **Reflow.** A non-fixed item starts where the previous one ends; a `fixed` item is a time-locked
   anchor whose start is what the user typed, and the items after it flow from it. Add, move,
   resize or remove, and every start after the change is recomputed up to the next anchor.
2. **Overlaps are refused at save.** Reflow cannot create one between non-fixed items, but an anchor
   can sit inside the item before it. The row is marked, the message says how many, and **Save is
   disabled** until the user shortens, moves or unfixes.
3. **Gaps are flagged, never blocked.** Dead air before an anchor is legitimate; a dashed row says
   how much.

A live item's sub-schedule travels with it — move or remove the live item and its children move or
go, shifted by exactly what the parent moved. Editing _inside_ a sub-schedule is v1.

**One save.** `PUT /schedules/{id}/items` with the whole reel: `seq` is the row's position, ids are
kept for rows that had them and minted by the service for rows that did not; `end` is never sent
(the service computes it). The stored reel comes back and replaces the rows, so the tab shows
exactly what the next reader gets. A failed save keeps the edits and the dirty dot. Times are
entered and shown as **wall clock in the schedule's zone**, converted with `Intl` (offset measured
twice, so a DST boundary is right); the browser's zone never enters into it.

Live updates: `atlas.<channel>.schedule.>`, reconciled by refetch — and never while the reel is
dirty, the EP-20.9 rule.

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

## API types AND URLs come from the contract (EP-11.5, EP-02.4)

`src/app/core/generated/*.types.ts` and `*.operations.ts` are generated from
`docs/architecture/openapi/*.yaml` and checked in, so a type or path change shows up as a reviewable
diff in a pull request rather than materialising during a build.

```sh
npm run api:types    # regenerate
npm run api:check    # fail if the checked-in output is stale — runs in CI
```

**It found drift on the first run.** `iam.yaml` called the permission version `permissionVersion`
while [FR-IAM-14](../../docs/requirements/05-functional-requirements.md#iam), the JWT claim, the
`x-atlas-perm-version` header and every line of code called it `permVersion` — and the contract
omitted `expiresIn` entirely. Nothing had ever compared the two, because until now the OpenAPI stubs
were documentation only: referenced in comments, parsed by nothing. The contract was corrected.

**No service spells a URL (EP-02.4).** `*.operations.ts` is the operations table — for every
`operationId`, the verb, the path _as the gateway serves it_ and the names of its path parameters:

```ts
this.api.call(ops.getAsset, { params: { id } }).as<Asset>();
this.api.call(ops.listAssets, { query: { limit, cursor } }).as<Page<Asset>>();
```

`ApiClient` (`core/api-client.ts`) builds the request from the entry, so a service cannot spell a
path the contract does not have, cannot use the wrong verb, and cannot forget a path parameter:
`{ id }` is **required by the type** when the path has `{id}` and refused when it does not, and the
value is percent-encoded on the way in. Rename a path in the contract, regenerate, and every caller
stops compiling — that is the loop `api:check` closes. The response type stays with the caller
(`.as<T>()`, two steps because TypeScript infers all type arguments or none): the stubs declare
responses unevenly, and a generated return type that is `unknown` half the time teaches callers to
cast.

Generating the table found a second round of drift. `iam.yaml` put `/auth/*` and the JWKS under
`/api/v1` — nothing on the platform served them there; the gateway's public route, the smoke suite
and this app all use the root — and said the login body was `{ login, password }` where IAM reads
`username`. `mam.yaml` had `POST /field-schemas` where MAM serves `PUT`, and no
`/assets/{id}/extended` at all. The contracts were corrected; a path item's own `servers` is how
OpenAPI records "at the root", and the generator reads it.

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

## Live updates degrade to polling; a reconnect is a re-sync (EP-09.4)

There is no replay of a gap — `resume` needs a Redis window that is not built — so the client does
not pretend there is. `WebSocketService.resync$` fires **`reconnected`** once on every open after a
drop (after the subscriptions are re-sent, so a refetch cannot race a gap it is still in) and
**`poll`** every 30 s while the socket is down, as long as some panel is subscribed and the tab is
visible. Every live consumer answers both the same way: **refetch what is on screen** — the media
panel re-runs its recent list or its active search, the dashboard its widgets, the editors their
record, and the editors keep the rule they apply to a live event: never over unsaved edits. The
status bar shows `● live` or `○ polling` (`ws.degraded()`).

Reconnects back off exponentially with **equal jitter** — `[cap/2, cap)`, 1 s doubling to 30 s —
so a restarted server is not hit by every open Studio at the same second, forever. A re-attempt
stays `reconnecting` (a browser can sit in CONNECTING for tens of seconds, and the panels must not
stop polling for it), and a `connect()` while a reconnect is pending takes over from the timer
rather than opening a second socket.

The client **heartbeats**: a `ping` frame every 30 s, and a period with no frame at all — no pong,
no event — closes the socket and starts the reconnect. The server pings too, but the browser answers
that without telling the page, so page script has no other way to notice a server that died with
the TCP connection still "open". A constructor that throws is a failed attempt like any other and
reconnects; it used to leave the state at `connecting` with no timer. All of it is under fake timers
in `websocket.service.spec.ts`, with the tuning (`WEBSOCKET_TUNING`) pinned.

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
