# Delivery Process — the working agreement

> **How the team actually works**: cadence, board, work-item taxonomy, Definition of Ready/Done,
> and how all of it is represented in **GitHub**. The companion doc is the
> [Epic Breakdown](21-epic-breakdown.md) (*what* gets built, in what order); this one is *how*.
>
> Parents: [Delivery Roadmap](08-roadmap.md) (phases & milestones) ·
> [System Implementation Plan](16-system-implementation-plan.md) (engineering standards) ·
> [Resourcing](09-resourcing-estimates.md) (team shape).

## 1. The method: Scrumban + XP practices

**Not textbook Scrum, not pure Kanban.** With a [Core team of ~5–6](../README.md#assumptions-register)
([A7](../README.md#assumptions-register)) building on a phased roadmap:

- **From Kanban:** a pull-based board with **WIP limits**, no fixed sprint commitment. This is what
  lets spiky infrastructure work (broker choice, Temporal adapter, HSM byte-movement profiling)
  coexist with feature delivery without "breaking a commitment" every time a spike expands.
- **From Scrum:** a **2-week heartbeat** for demo, retro and planning — the rhythm the phased
  roadmap and a pilot customer need.
- **From XP:** the engineering discipline that actually protects quality —
  **contracts-first**, trunk-based development, CI across all consumers, and selective pairing on
  correctness-critical code.

**Why this and not Scrum:** dedicated Scrum Master + Product Owner roles cost two of six people;
fixed two-week commitments fight the research-heavy foundation phases. **Why not pure Kanban:**
no natural checkpoint for stakeholder demos or the MVP→Beta→v1.0→GA milestones.

> **AI-assisted development ([A12](../README.md#assumptions-register)) changes the bottleneck.**
> When authoring code is faster, the constraint moves to **review, integration and verification**.
> That is precisely what WIP limits and a strict Definition of Done control — so they matter *more*
> here, not less. Resist raising WIP because "tasks finish quickly"; finished ≠ merged ≠ verified.

## 2. Cadence

| Rhythm | What happens | Timebox |
|--------|--------------|---------|
| **Daily** | Async written stand-up in a team channel (blockers + WIP). No meeting. | — |
| **Iteration** (2 weeks) | The heartbeat. Numbered `S01…S31` across the 62-week plan. | — |
| **Iteration planning** | Top-up the *Ready* column; agree the iteration goal (one sentence). Not a commitment ritual. | 45 min |
| **Demo / review** | Working software against the phase's exit criteria. Stakeholders invited. | 45 min |
| **Retro** | What to change; **one** action item, owned. | 30 min |
| **Backlog refinement** | Continuous, not a ceremony — refine the next ~1.5 iterations of work. | ~1 h/wk |
| **Phase boundary** | Bigger demo + exit-criteria review + go/no-go on the milestone. | ½ day |

**Iteration map** — 2-week iterations against [roadmap](08-roadmap.md) weeks:

| Phase | Weeks | Iterations | Exit milestone |
|-------|:-----:|:----------:|----------------|
| 0 — Foundations | T0–T6 | **S01–S03** | Walking skeleton |
| 1 — Ingest-to-Schedule | T6–T22 | **S04–S11** | **MVP** |
| 2 — Workflow & collaboration | T22–T38 | **S12–S19** | **Beta** |
| 3 — Full-feature & HA | T38–T56 | **S20–S28** | **v1.0 feature-complete** |
| GA — Hardening | T56–T62 | **S29–S31** | **v1.0 GA** |

## 3. Roles (no dedicated SM/PO)

| Role | Who | Responsibility |
|------|-----|----------------|
| **Tech lead** | 1 (also builds) | Architecture coherence, contract sign-off, unblocks |
| **Product owner** *(part-time)* | stakeholder or tech lead | Priority order of the backlog. **One** person decides priority. |
| **Facilitator** | **rotates each iteration** | Runs the three ceremonies; keeps the board honest |
| **Everyone** | the team | Refinement, review, testing. Collective code ownership. |

Rotating facilitation is deliberate: it distributes process ownership instead of creating a
process specialist the team can't afford.

## 4. The board

Columns, with **WIP limits** — the number is per *team*, not per person:

| Column | WIP | Meaning |
|--------|:---:|---------|
| **Backlog** | ∞ | Everything not yet refined |
| **Ready** | 12 | Meets the Definition of Ready; pull from here |
| **In progress** | **5** | Actively being built (≈ team size) |
| **In review** | **4** | PR open, awaiting review — *the usual bottleneck* |
| **Verifying** | 3 | Merged; contract/integration/smoke checks running or manual QA |
| **Done** | — | Meets the Definition of Done |
| **Blocked** | — | Flagged, with a reason and an owner. Reviewed at every stand-up. |

**Rules that make the limits real:**
1. **Hitting a limit is a signal to help, not to start something new.** If *In review* is full,
   review something before you open another PR.
2. **Blocked is not a parking lot.** An item blocked > 2 days is escalated in the stand-up.
3. GitHub does not enforce WIP limits ([§8.6](#86-known-limits--workarounds)) — the counts are
   visible on the board and the facilitator calls them out.

## 5. Work-item taxonomy

| Type | Meaning | Sizing | GitHub |
|------|---------|--------|--------|
| **Epic** | A capability spanning iterations; maps to a service version or cross-service feature | not estimated | Issue, type `Epic` |
| **Story** | User- or system-visible increment, deliverable **within one iteration** | 1/2/3/5/8 | Sub-issue of an epic, type `Story` |
| **Task** | Sub-unit of a story; a single PR's worth | ≤ 1 day | Sub-issue of a story, type `Task` |
| **Spike** | Time-boxed research answering a specific question | timebox, not points | Issue, type `Spike` |
| **Bug** | Defect in delivered work | 1/2/3 | Issue, type `Bug` |
| **Chore** | Necessary non-feature work (dependency bumps, CI upkeep) | 1/2/3 | Issue, type `Chore` |

**Rules:**
- A story **larger than 8** must be split — it will not finish in an iteration.
- A **spike always produces a written artifact** (a doc update or an ADR), never just "we looked
  into it". Spikes are how the [engineering risk register](16-system-implementation-plan.md#9-risk-register-engineering)
  gets retired.
- Tasks are optional. Use them when a story needs division of labour; skip them for small stories.

## 6. Definition of Ready (to pull a story)

- [ ] Written as an outcome, with **acceptance criteria** someone else could verify
- [ ] Traced to a **requirement ID** (`FR-*` / `NFR-*`) or explicitly marked *enabler*
- [ ] **Contracts identified** — the OpenAPI paths and event payload schemas it touches
- [ ] Dependencies known and either met or explicitly stubbed
- [ ] Estimated (≤ 8) and small enough for one iteration
- [ ] Test approach agreed (unit / contract / integration / manual)

## 7. Definition of Done

Applies to **every** story. This is the quality gate that AI-assisted authoring makes essential.

- [ ] Acceptance criteria demonstrably met
- [ ] **Contract-first honoured** — OpenAPI stub and/or event payload schema updated *and merged*
      before or with the implementation; generated types regenerated
- [ ] **Contract tests pass**, and CI ran **all consumers** of any changed shared library
- [ ] Unit + integration tests for the new path; no reduction in coverage of touched code
- [ ] **Every write emits through the outbox**; consumers idempotent
      ([standards](16-system-implementation-plan.md#6-cross-cutting-engineering-standards))
- [ ] `channelId` on every row/message; authorization enforced **server-side** via `can()`
- [ ] **Audited** — mutating actions emit an audit event with a field-level delta
      ([FR-AUD](../requirements/05-functional-requirements.md#audit))
- [ ] Observability: metrics/logs/traces for the new path
- [ ] Docs updated in the same PR (spec, plan, or runbook) — **docs and code ship together**
- [ ] Reviewed and merged to trunk; **smoke suite green**
      ([runbook §8](../operations/17-operations-runbook.md#8-smoke--health-verification))

**Extra gate — correctness-critical code.** HSM file operations, send-to-air export, and the
authorization evaluator require **two reviewers and pairing**, and are explicitly **not**
AI-fast-tracked ([HSM §10](../architecture/services/hsm.md)).

**Phase Definition of Done:** the phase's exit criteria in [roadmap](08-roadmap.md) are
demonstrated end-to-end, and the [runbook](../operations/17-operations-runbook.md) procedures
touched by that phase have been rehearsed at least once.

## 8. How this lives in GitHub

### 8.1 One org-level project

**The project is created at the `atlasms` **organization** level — never inside a single repo.**
Projects are owned by an org or a user, never by a repository, and an org-owned project can be linked
to **several** repos with issues from all of them flowing onto one board. Today that is
`atlasms/platform`; if the estate ever splits (a separate deployment or infrastructure repo), the
board absorbs it without migration. Full commands: [§9](#9-github-setup-commands).

### 8.2 Hierarchy

Epic → Story → Task uses **native sub-issues** (8 levels deep, 100 children per parent), so the
tree is real GitHub data, not a label convention. Turn on **`Show hierarchy`** in the project's
View menu to see it in the table.

### 8.3 Fields

| Field | Type | Values |
|-------|------|--------|
| **Status** | single-select | Backlog, Ready, In Progress, In Review, Verifying, Done, Blocked |
| **Iteration** | iteration | 2 weeks, `S01…S31` |
| **Phase** | single-select | Phase 0, Phase 1 (MVP), Phase 2 (Beta), Phase 3 (v1.0), GA, v2.0 |
| **Estimate** | number | 1, 2, 3, 5, 8 |
| **Service** | single-select | mam, hsm, mts, rim, iam, scheduling, bms, notifications, newsroom, integration, ai, logging, gateway, websocket, studio, shared |
| **Requirement** | text | `FR-MAM-6`, `NFR-PERF-7`, … |

**Use `Phase`, not milestones.** GitHub milestones are **per-repository**, so a "MVP" milestone
would fragment across the docs repo and the code repo. A project field filters and groups across
both.

### 8.4 Views to create

| View | Layout | Config |
|------|--------|--------|
| **Board** | board | Group by *Status*; filter `iteration:@current` |
| **Iteration** | table | Filter `iteration:@current`; show hierarchy |
| **Epics** | table | Filter `type:"Epic"` (the quoted form is what GitHub documents); group by *Phase* |
| **Roadmap** | roadmap | Marker: *Iteration*; group by *Phase* |
| **Blocked** | table | Filter `status:Blocked` — reviewed daily |

### 8.5 Automation (free, built-in)

Enable in **Project → ⚙ → Workflows**: *Item added to project* → set Status **Backlog**;
*Item closed* → Status **Done**; *Pull request merged* → Status **Verifying**;
*Auto-add* items from the linked repos.

### 8.6 Known limits & workarounds {#86-known-limits--workarounds}

| Limit | Workaround |
|-------|-----------|
| **No native WIP-limit enforcement** | Column counts are visible; the facilitator polices them. Optionally a GitHub Action that comments when a column exceeds its limit. |
| **No preset sprint burndown** | Project **Insights** supports configurable charts (burn-up works). Track **cycle time and WIP** instead — see §10. |
| **`gh project field-create` has no `ITERATION` type** | Not actually a blocker: the **GraphQL** `updateProjectV2Field` mutation accepts `iterationConfiguration`, so `scripts/setup-github-project.ps1` creates the field *and* generates S01–S31. Only the field's initial creation needs the UI (or the setup script's GraphQL path). |
| **Views can't be created by `gh project` subcommands** | Also GraphQL — `createProjectV2View` / `updateProjectV2View` set name, layout and filter. **Grouping is not exposed** by the API (`configuration` only accepts `visibleFieldIds`), so *group by* is the one genuine UI click per view. |
| **Workflow *actions* are not readable or writable via API** | `ProjectV2Workflow` exposes only `name`/`enabled` — not which Status an action sets. Verify the targets once in the UI; there is no way to assert them from a script. |
| **Hierarchy view is in public preview** | Nested items also show as standalone rows, filters don't apply to nested sub-issues, and expand state resets on reload. Usable, but don't build reporting on it yet. |
| **Issue types are org-wide and need org-admin** | Define once at `atlasms` org settings → Planning → Issue types. |
| Sub-issues: 100 per parent, 8 levels | Far above what an epic should ever hold — if you hit it, the epic is too big. |

### 8.7 Repos & branching

- **Trunk-based**: short-lived branches off `main`, small PRs, merge daily. Branch naming
  `<type>/<issue-number>-<slug>` (e.g. `feat/142-outbox-publisher`).
- **`Closes #<issue>`** in the PR body so merge closes the issue and the automation moves it.
- Branch protection on `main`: PR required, CI green, ≥1 review (**2** for correctness-critical
  paths).
- **One repo: `atlasms/platform`** — the Nx/Turborepo monorepo ([EP-01](21-epic-breakdown.md#ep-01--monorepo-cicd--environments))
  holding `docs/`, `libs/`, `apps/` and `scripts/` together. Docs ship in the same PR as the code
  they describe ([§11](#11-working-agreements)), which only works if they share a repo.

## 9. GitHub setup commands {#9-github-setup-commands}

Run once. Requires `gh` ≥ 2.60 authenticated with the **`project`** scope.

```bash
# 0. Authenticate with the scopes Projects needs (interactive, browser)
gh auth login -s project,read:org
#    (already logged in? add the scopes instead:)
gh auth refresh -s project,read:org

# 1. CREATE THE PROJECT AT THE ORG LEVEL  ← --owner is the ORG, not @me, not a repo
gh project create --owner atlasms --title "Atlas Delivery"

# 2. Note the project NUMBER it prints (used below as <N>)
gh project list --owner atlasms

# 3. Link the repos that will feed it
gh project link <N> --owner atlasms --repo platform
#    …and any additional repos later:
# gh project link <N> --owner atlasms --repo infra

# 4. Iteration field: create it in the UI (⚙ → + New field → Iteration, 2 weeks), then let
#    the setup script rename/generate S01…S31 via GraphQL — see scripts/setup-github-project.ps1.
#    `gh project field-create` has no ITERATION type, but updateProjectV2Field does.

# 5. The scriptable fields
gh project field-create <N> --owner atlasms --name "Phase" --data-type SINGLE_SELECT \
  --single-select-options "Phase 0,Phase 1 (MVP),Phase 2 (Beta),Phase 3 (v1.0),GA,v2.0"

gh project field-create <N> --owner atlasms --name "Estimate" --data-type NUMBER

gh project field-create <N> --owner atlasms --name "Service" --data-type SINGLE_SELECT \
  --single-select-options "mam,hsm,mts,rim,iam,scheduling,bms,notifications,newsroom,integration,ai,logging,gateway,websocket,studio,shared"

gh project field-create <N> --owner atlasms --name "Requirement" --data-type TEXT

# 6. Verify
gh project field-list <N> --owner atlasms
```

**Status column values** — the default `Status` field ships with Todo/In Progress/Done. Edit it in
the UI to the seven values in [§8.3](#83-fields) (the default field can't be recreated by CLI).

**Issue types** (org-admin, one time, web UI):
`https://github.com/organizations/atlasms/settings/issue-types` → add **Epic**, **Story**,
**Spike**, **Chore** alongside the default Bug/Task/Feature.

> The **backlog itself** — epics, stories and their bodies — is generated from
> [21-epic-breakdown.md](21-epic-breakdown.md); a seed script creates the issues and links them as
> sub-issues.

## 10. Metrics we track (and ones we don't)

**Track:**

| Metric | Why |
|--------|-----|
| **Cycle time** (Ready → Done, p50/p85) | The honest speed signal; drives forecasting |
| **WIP** | Leading indicator — rising WIP predicts falling throughput |
| **Throughput** (stories/iteration) | Forecasting input, more stable than points |
| **Blocked age** | Surfaces dependency pain early |
| **Escaped defects** per phase | Whether the Definition of Done is real |
| **DLQ depth, failed CI on trunk** | Engineering health ([observability baseline](16-system-implementation-plan.md#36-observability-baseline)) |

**Don't track: velocity as a performance target.** At 5–6 people it is statistical noise and
invites point inflation. Estimates exist to *split work* and spot oversized stories — not to
measure people. Forecast from **throughput and cycle time**.

## 11. Working agreements

1. **Contracts before code.** A service's OpenAPI/event schemas are merged before its
   implementation stories are pulled.
2. **Docs ship with code** — same PR. The docs set is the product's design memory.
3. **Small PRs.** If a PR exceeds ~400 changed lines, justify it in the description.
4. **Review is the top priority** — reviewing unblocks someone else; writing more code does not.
5. **Trunk is always releasable.** A red trunk is the whole team's problem, fixed before new work.
6. **Spikes are time-boxed and produce writing.**
7. **AI-assisted output is reviewed to the same standard as hand-written code**, and is not used at
   all on correctness-critical paths without pairing.

---
_Related: [Epic Breakdown](21-epic-breakdown.md) · [Delivery Roadmap](08-roadmap.md) ·
[System Implementation Plan](16-system-implementation-plan.md) ·
[Operations Runbook](../operations/17-operations-runbook.md) ·
[Resourcing](09-resourcing-estimates.md)._
