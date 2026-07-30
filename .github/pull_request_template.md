<!--
  Keep PRs small (~400 changed lines). If this one is larger, say why below.
  Working agreement: docs/roadmap/20-delivery-process.md
-->

Closes #

## What & why

<!-- One paragraph. The "why" matters more than the "what" — the diff shows the what. -->

## Definition of Done

<!-- Tick what applies; strike through with ~~text~~ what genuinely does not, rather than deleting. -->

- [ ] Acceptance criteria demonstrably met
- [ ] **Contracts merged first or with this change** — OpenAPI stub / event payload schema updated, types regenerated
- [ ] Contract tests pass; CI ran **all consumers** of any changed shared library
- [ ] Unit + integration tests for the new path; coverage of touched code not reduced
- [ ] Writes go through the **outbox**; consumers **idempotent**
- [ ] `channelId` on every row/message; authorization enforced **server-side** via `can()`
- [ ] Mutating actions emit an **audit event with a field-level delta**
- [ ] Metrics/logs/traces for the new path
- [ ] **Docs updated in this PR** — specs, plans and code ship together

## Correctness-critical?

- [ ] This touches **HSM file operations, send-to-air export, or the authorization evaluator**

If ticked: **2 reviewers + pairing required**, and it is **not** AI-fast-tracked.

## Verification

<!-- How you proved it works. Paste real output — a passing test name, a trace id, a screenshot. -->
