# Notifications & Messaging — Implementation Plan

> Build plan for system notifications **and** user↔user/group messaging — unified because both are
> permission-aware delivery. Spec: [notifications](../../architecture/services/notifications.md) ·
> Stack: **Node + NestJS/Fastify**, broker-backed fan-out · Ships: **Phase 2 (v1)**. Non-critical to
> the media path; important to UX.

## 1. Scope & versions

| Version | Phase | Delivers |
|---------|-------|----------|
| v1 | 2 | **Tasks** (assign/forward), **inbox**, direct + group **messaging**; system **notifications** (job done, approval needed, mention) with per-user preferences; live delivery via WebSocket. |
| v2 | 3 | Email/push **digest** channels; richer preferences; escalation/SLA reminders. |

**Non-goals.** Not the live transport itself ([WebSocket](websocket-plan.md) delivers); not a workflow
engine (tasks originate in [BMS](bms-plan.md) or user actions).

> **Reference slice:** [`reference/notifications-service/`](../../../reference/notifications-service/README.md)
> is a tested Notifications slice — per-user inboxes from `workflow.task.created` + `asset.expired`,
> with preferences — plus a three-service **fan-out** test (one `asset.expired` drives both Scheduling
> and Notifications).

## 2. Build sequence

1. **Task model (v1)** — create/assign/forward/close; inbox state per user; `GET/POST /tasks`,
   `PATCH /tasks/{id}`, `GET /inbox`. Consume `workflow.task.created` (BMS) to materialize tasks.
2. **Messaging (v1)** — direct + group messages; `GET/POST /messages`; permission-aware (a user may only
   message permitted peers/groups).
3. **Notification pipeline (v1)** — consume many domain events (`asset.approved`, `asset.expired`,
   `transcode.failed`, mentions, `alert.raised`, …) → map to per-user **notifications** honoring
   **preferences**; emit `notification.raised`.
4. **Delivery** — push live through [WebSocket](websocket-plan.md) topics (`user:{id}:inbox`); mark
   read/delivered; unread counts.
5. **Preferences** — per-user, per-type opt-in/out + channel selection.
6. **Digest channels (v2)** — email/push for offline users; batching/quiet-hours; delivery receipts.

## 3. Components / modules

- `tasks`, `messages` (direct/group), `notifications` (event→notification mapper), `preferences`,
  `delivery` (WebSocket + email/push), `inbox` (read/unread state).

## 4. Data plane & migrations

- **Relational:** messages, tasks, inbox state, preferences. Additive migrations; idempotent
  event→notification mapping (dedupe on source `messageId`).

## 5. APIs & events

- REST: [`notifications.yaml`](../../architecture/openapi/notifications.yaml) — `/messages`, `/tasks`,
  `/inbox`, `/tasks/{id}`.
- **Emits:** `message.sent`, `task.created`, `task.updated`, `notification.raised`. **Consumes:** many
  (`asset.approved`, `asset.expired`, `workflow.task.created`, `transcode.failed`, `alert.raised`, …).

## 6. Dependencies & integration points

- **Requires first:** [WebSocket](websocket-plan.md) (delivery), broker, [IAM](iam-plan.md) (who may
  message/see whom). **Consumed by:** Studio (inbox/tasks/notifications), users.

## 7. Testing focus

- **Permission-aware** delivery (no cross-channel/cross-user leakage).
- Idempotent event→notification mapping (one alert per event, not per redelivery).
- Preference honoring (opt-outs respected); read/unread state correctness under concurrency.
- Digest batching + quiet-hours (v2).

## 8. Scaling & deployment

- **Stateless API + broker-backed delivery**; scale horizontally. Config: notification-type catalog +
  default preferences, delivery channels, digest schedule, quiet-hours.

## 9. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Notification storms | Coalesce/batch per user; rate-limit per type; digest for low-priority. |
| Leaking content via notifications | Permission checks at map + delivery; redact payloads. |
| Duplicate notifications on redelivery | Idempotency keyed on source event id. |
