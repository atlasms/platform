# @atlas/notifications-service — a third consumer + event fan-out

A Notifications vertical slice that turns lifecycle events into **per-user inboxes** — and carries the
**three-service fan-out test** that proves one event drives several independent consumers.

## What it does

- Consumes **`workflow.task.created`** (BMS) → an assigned **task** in the assignee's inbox.
- Consumes **`asset.expired`** (MAM) → a **re-review-due notification** for the prior approver.
- Honors per-user, per-type **preferences** (opt-out); tracks **unread counts**; `markRead` / `completeTask`.

A pure consumer: real delivery pushes these live over the WebSocket service and emits
`notification.raised` (out of scope here); this slice maintains the inbox state that delivery reads.
Built from the same libs — `messaging` (idempotent consumers), `contracts`, `service-kit` (logger).

## Run

```bash
# from reference/ (shared dep root): npm install once, then:
cd notifications-service && node --import tsx --test test/*.test.ts   # 6 tests
```

## Tests prove

**Unit** — a task is delivered to the assignee; `asset.expired` raises a re-review notification for the
prior approver (unread count = 1); a **preference opt-out** suppresses it; `markRead`/`completeTask`
work; `asset.expired` with no prior approver raises nothing.

**Fan-out** ([`fanout.test.ts`](test/fanout.test.ts)) — **MAM + Scheduling + Notifications on one
broker**: after approve→air, MAM's `expire()` emits **one** `asset.expired` that **both** Scheduling
(pulls the item from air) **and** Notifications (raises a re-review notification to the approver) react
to — plus an independent BMS task delivered to another user. One event, multiple consumers, exactly
the event-driven fan-out the architecture promises.
