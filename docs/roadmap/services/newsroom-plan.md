# Newsroom — Implementation Plan

> Build plan for the multimedia **newsroom**: rundowns, stories, scripts, media association, and
> handoff to Scheduling for bulletins. Spec: [newsroom](../../architecture/services/newsroom.md) ·
> Stack: **Node + NestJS**, collaborative editing via WebSocket · Ships: **Phase 3 (v1)**.
> Feature-critical for news customers; optional for others.

## 1. Scope & versions

| Version | Phase | Delivers |
|---------|-------|----------|
| v1 | 3 | **Rundowns**, **stories**, **scripts** with media references; assignment + status; collaborative editing; handoff to Scheduling for bulletins. |
| v2 | Post | **MOS-style** integration surface for newsroom/playout devices. |

**Non-goals.** Not the catalog ([MAM](mam-plan.md)) or the schedule engine ([Scheduling](scheduling-plan.md)) —
Newsroom composes references and hands off. Wire/feed intake comes via [Integration](integration-feeds-plan.md).

## 2. Build sequence

1. **Rundown/story/script model (v1)** — rundowns contain stories; stories contain scripts + media
   references; assignment + editorial **status**; `GET/POST/PATCH /rundowns|/stories|/scripts`.
2. **Media association** — reference [MAM](mam-plan.md) assets in scripts; react to `asset.ready`;
   show availability.
3. **Collaborative editing** — real-time co-editing of scripts/rundowns via [WebSocket](websocket-plan.md)
   (presence + operational updates); conflict handling.
4. **Wire/feed intake** — consume `feed.item.received` (via [Integration](integration-feeds-plan.md)) to
   seed stories from wires.
5. **Bulletin handoff** — `rundown.ready` → hand a bulletin to [Scheduling](scheduling-plan.md).
6. **MOS integration (v2)** — protocol glue to newsroom/playout devices.

## 3. Components / modules

- `rundowns`, `stories`, `scripts` (rich text + media refs), `assignment/status`, `collab`
  (WebSocket co-editing), `wire-intake`, `bulletin-handoff`, `mos` (v2).

## 4. Data plane & migrations

- **Relational** (rundowns/stories/assignment/status) + **document** (rich script content). Additive
  migrations.

## 5. APIs & events

- REST: [`newsroom.yaml`](../../architecture/openapi/newsroom.yaml) — `/rundowns`, `/stories`, `/scripts`.
- **Emits:** `story.updated`, `rundown.updated`, `rundown.ready`. **Consumes:** `asset.ready`,
  `feed.item.received`.

## 6. Dependencies & integration points

- **Requires first:** [MAM](mam-plan.md), [Integration](integration-feeds-plan.md),
  [Scheduling](scheduling-plan.md), [WebSocket](websocket-plan.md). **Consumed by:** Scheduling
  (bulletins), Studio newsroom pages.

## 7. Testing focus

- Collaborative-edit conflict resolution + presence correctness.
- Media-reference integrity (broken/updated/expired asset references surface clearly).
- Wire-intake → story seeding; bulletin handoff to Scheduling.

## 8. Scaling & deployment

- **Collaboration-heavy**; real-time editing via WebSocket; scale horizontally. Config: rundown
  templates, editorial statuses, wire sources, MOS device endpoints (v2).

## 9. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Concurrent-edit conflicts | Operational-update model + presence + last-writer/merge strategy. |
| Referenced media expires before air | Surface expiry state from MAM in the rundown; validate at handoff. |
| MOS protocol variance (v2) | Isolate behind an adapter; certify per device. |
