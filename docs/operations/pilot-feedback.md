# Pilot feedback & defect triage

> **Status:** the working agreement for the MVP pilot ([EP-21.5](../roadmap/21-epic-breakdown.md)).
> Parent: [Delivery process](../roadmap/20-delivery-process.md) (§5 work-item types, §10 metrics) ·
> [Operations runbook](17-operations-runbook.md) (incidents, rollback, restore).

The pilot is where the platform meets the people it is for. This page is how what they run into
reaches the team, how fast it is handled, and how we know whether the Definition of Done is real.

## 1. The loop

```
someone at the pilot ──► Pilot feedback issue ──► daily triage ──► Bug / Story / answered / won't fix
     (Studio shows an          (labels from the        (owner, type,          │
      "error ref" to copy)       form, automatically)    severity confirmed)   ▼
                                                                      fixed → released → told
```

1. **Report.** Anyone at the pilot opens a **Pilot feedback** issue (the form asks plain questions;
   no one has to decide whether it is a bug). Engineers use the **Bug** form. When Studio refused or
   failed a request, its status bar shows **`error ref <status> · <id>`** — click to copy, paste
   into the form. That id is the request's correlation id: it is on every log line, trace span and
   audit record the request produced, in every service, so one search finds the whole flow.
2. **Label — automatic.** `.github/workflows/triage.yml` reads the form and keeps the labels in step
   with its answers: one `severity:*`; `integrity-or-authz` when data was lost or changed or
   someone could see or do what they should not (and severity at least **high**, whatever was
   chosen); `escaped-defect` when an engineer ticks it. New reports carry `triage`.
3. **Triage — a person, daily.** The triager of the day takes everything labelled `triage`, oldest
   first, and for each: confirms or corrects the severity, reproduces it or asks the reporter, sets
   the type (Bug, Story, or a reply), links it to its epic, names an owner, and removes `triage`.
   A report that is really a feature request becomes a Story; one that is working as designed is
   answered and closed with the reason — the reporter is always told what happened.
4. **Fix and close the loop.** A fix ships through the ordinary Definition of Done, with a test that
   fails without it. When it is released, the reporter is told, in the issue.

## 2. Severity and clocks

The clock starts when the issue is opened. `npm run triage` (and the weekly job) marks what is past it.

| Severity | Means | Acknowledged | Resolved (fixed, rolled back, or a workaround in place) |
|---|---|---|---|
| **critical** | The media path is blocked: ingest, approval, scheduling or send-to-air stops; or data lost; or an authorization breach | within **2 hours** of pilot hours | within **1 day** — a rollback ([runbook §4.3](17-operations-runbook.md)) is a resolution |
| **high** | A task cannot be done, but there is a way around it; anything involving data integrity or authorization | same day | within the **current iteration** (14 days) |
| **medium** | It works, but slower or harder than it should | at the next triage | the **next iteration** (28 days) |
| **low** | Cosmetic: wording, layout, translation | at the next triage | when convenient — no clock |

- **Untriaged** reports wait at most **1 day**; the report flags any older.
- **Data integrity or authorization raises severity** — never below high. A lost edit is not
  cosmetic because the screen still looks fine (#385 was exactly that).
- A **critical** item is also an **incident**: follow the runbook (correlation id → logs/traces →
  roll back if the cause is a release), then fix forward. The restore drill
  ([runbook §5](17-operations-runbook.md)) is the last resort, not the first.

## 3. The rhythm

| When | What | Who |
|---|---|---|
| **Daily**, 15 min, pilot weeks | Triage everything labelled `triage`; look at anything past its clock | the triager of the day (rotates weekly) |
| **Weekly**, 30 min | The triage report (Monday's job summary, or `npm run triage`): waiting, late, escaped; walk the pilot's open items with their lead | the team + the pilot's lead |
| **Each iteration** (retro) | Escaped defects: for each, which part of the Definition of Done should have caught it — and change that part, or add the check | the team |

The triager is not the fixer: their job is that nothing waits unseen, and that every item has an
owner, a severity and a reply.

## 4. Escaped defects — the metric

An **escaped defect** is a bug in work that had already passed the Definition of Done
([delivery process §10](../roadmap/20-delivery-process.md#10-metrics-we-track-and-ones-we-dont)).
Count them per phase (`escaped-defect`; the report shows the total and how many are open); trend
them by iteration. What matters is not the number but the answer in the retro — every escaped
defect is a hole in a check, and the fix includes the check. The EP-21 hardening work is the
pattern: the MVP journey found an unrouted search, a lost-update race and a 500 under load, and each
fix shipped with the test or rule that would have caught it (`routes.test.ts`, the CAS conformance
race, the chain-lock race).

## 5. Where things are

| Thing | Where |
|---|---|
| Report forms | `.github/ISSUE_TEMPLATE/pilot-feedback.yml`, `bug.yml` |
| Labelling from the form | `scripts/triage-labels.mjs` (`--self-test`), `.github/workflows/triage.yml` |
| The report | `npm run triage` (`scripts/triage-report.mjs`); weekly in the workflow's job summary |
| The error reference in Studio | `apps/studio/src/app/core/error-reference.ts`, shown in the workbench status bar |
| Labels | `severity:critical/high/medium/low`, `pilot`, `triage`, `integrity-or-authz`, `escaped-defect` |

The clocks live in two places — §2 above and `SLA_DAYS` in `scripts/triage-report.mjs`. Change
them together.
