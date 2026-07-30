# WebSocket Service (Pusher) — Implementation Plan

> Build plan for the live-push edge: authenticated, permission-aware fan-out of real-time
> updates to Studio (job progress, asset changes, notifications, collaboration).
> Spec: [websocket](../../architecture/services/websocket.md) ·
> Stack: **Node + Fastify + ws** (escape hatch: `uWebSockets.js`) · Ships: **Phase 0 (backbone)**.

## 1. Scope & versions

| Version | Phase | Delivers |
|---------|-------|----------|
| v0 | 0 | Authenticated connections; subscribe to channels; push the "hello asset" update. |
| v1 | 1 | Progress + asset-lifecycle fan-out; reconnect/resume; presence basics. |
| v2 | 2–3 | Collaboration channels (editor, newsroom); high-fan-out tuning; email/push handoff. |

**Non-goals.** No persistence of messages (that's [Notifications](notifications-plan.md)); no business
decisions — it's a delivery transport that enforces subscription authz.

## 2. Build sequence

1. **Connection lifecycle** — WS upgrade over TLS; authenticate the handshake via JWT (query/subprotocol
   token), bind the connection to `sub` + `channelId` + permissions.
2. **Subscription model** — clients subscribe to topics (`asset:{id}`, `channel:{id}:jobs`,
   `user:{id}:inbox`); enforce that the token may see each topic before subscribing.
3. **Broker bridge** — subscribe to relevant broker subjects; map events → topic messages; drop/redact
   per subscriber permissions.
4. **Reliability** — heartbeats/ping-pong, idle timeout, reconnect with a resume cursor (last-seen
   sequence) so a brief drop doesn't lose updates.
5. **Backpressure & fan-out** — per-connection send queues with drop/coalesce policy for slow clients;
   measure concurrent connections; switch hot paths to `uWebSockets.js` only if profiling demands.
6. **Collaboration channels** (v2) — editor/newsroom presence + operational updates.

## 3. Components / modules

- `handshake-auth`, `subscription-registry` (topic ↔ connections), `broker-bridge`,
  `authz-filter`, `heartbeat/resume`, `metrics`.

## 4. Data plane & migrations

**None owned.** Optional Redis for presence/sharded routing across instances (sticky or pub/sub relay).

## 5. APIs & events

- No REST domain surface. **Consumes** broker events (progress, `asset.*`, `notification.raised`,
  `workflow.task.created`, editor/newsroom updates) and pushes them to authorized subscribers.

## 6. Dependencies & integration points

- **Requires first:** [IAM](iam-plan.md) (token verify), broker, `service-kit`.
- **Consumed by:** Studio (all live UI). **Producers:** every service that emits progress/state.

## 7. Testing focus

- Subscription authz (a user cannot subscribe to another channel's topics).
- Reconnect/resume correctness (no lost or duplicated updates across a drop).
- Load: N concurrent connections with fan-out; slow-consumer backpressure doesn't stall others.

## 8. Scaling & deployment

- **Stateless per connection**, but connections are sticky; scale horizontally with a shared
  broker subscription and (optionally) Redis for cross-instance presence.
- Config: heartbeat/idle timeouts, max connections, per-connection queue limits.

## 9. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Extreme fan-out saturates the event loop | Measure early; `uWebSockets.js` escape hatch; coalesce updates. |
| Permission leakage via topics | Authorize every subscribe; filter payloads per subscriber. |
| Reconnect storms after a blip | Jittered backoff on client; resume cursor to avoid full replays. |
