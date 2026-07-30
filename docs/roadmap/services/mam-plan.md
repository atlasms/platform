# MAM — Metadata & Asset Management — Implementation Plan

> Build plan for the **system of record** for media metadata and the searchable catalog — the
> busiest domain service. Spec: [mam](../../architecture/services/mam.md) · Stack: **Node + NestJS**
> over Postgres + Mongo + OpenSearch + Redis · Ships: **Phase 1 (v1)** → **Phase 2 (v2 + review
> lifecycle)**. Critical path; read-heavy.

## 1. Scope & versions

| Version | Phase | Delivers |
|---------|-------|----------|
| v1 | 1 | Core fields (relational); basic extensible fields (document); **free-form tags**; simple search; **mandatory-metadata gate**; cache; ready-assembly. |
| v2 | 2 | **Advanced faceted search**; shot-list; **schema editor**; auto-vs-manual provenance; **category taxonomy**, subjects/vocabularies, **people register**. |
| v2 review | 2 | **Manual approval, expiry (category-inherited) & rejected-retention** — built per the [Review Lifecycle plan](../15-review-lifecycle-implementation-plan.md). |
| v3 | Post | Semantic/vector search; bulk-edit; collections. |

**Non-goals.** File location/integrity ([HSM](hsm-plan.md)); encoding ([MTS](mts-plan.md)); workflow
orchestration ([BMS](bms-plan.md)); AI inference ([AI](ai-enrichment-plan.md) — MAM records its results
as *suggestions*).

> **Reference slice:** [`reference/mam-service/`](../../../reference/mam-service/README.md) is a
> tested MAM vertical slice (ingest→create→ready→approve/reject) assembled from the foundation libs
> — a concrete starting shape for steps 1 and 9 below (asset lifecycle + review events, outbox + idempotency).

## 2. Build sequence

1. **Asset core + lifecycle (v1)** — relational Asset (title/duration/type/resolution/…, state,
   version); create from `ingest.accepted`; ready-assembly on `transcode.completed`
   (renditions in + mandatory metadata present → `Ready`, emit `asset.ready`).
2. **Extensible metadata (v1→v2)** — document store for type/category fields; **FieldSchema**
   definitions + a **schema editor** (v2); mandatory-metadata policy per type.
3. **Search projection** — OpenSearch read model rebuilt by event replay; write via the **outbox** to
   avoid dual-write drift; simple search (v1) → **faceted** search (v2: category ∧ subject ∧ tag ∧ person).
4. **Cache** — Redis for hot reads; invalidate on update.
5. **Versioning + clone-on-replace** — `POST /assets/{id}/versions`; clone metadata to a **new id**;
   emit `asset.replaced(oldId,newId)` for Scheduling to swap references.
6. **Classification (v2)** — free-form tags (v1), hierarchical **categories**, subjects from controlled
   vocabularies; operator-managed without deploy; all indexed for facets.
7. **People register (v2)** — minimal PII (name/role/optional image); associate person+role with assets;
   search-by-person; **AI suggestions** intake (human-confirmed, never auto-write).
8. **Provenance** — keep AI/derived distinct from user-entered; AI never overwrites mandatory fields.
9. **Review lifecycle (v2)** — approval verdicts + history, **category-inherited expiry**, internal
   scheduler for expiry/purge — see the [dedicated plan](../15-review-lifecycle-implementation-plan.md).

## 3. Components / modules

- `assets` (core + lifecycle state machine), `extended` (document fields), `field-schemas`,
  `search` (projector + query), `cache`, `versions` (clone-on-replace), `taxonomy`
  (tags/categories/subjects), `people`, `provenance`, `review` (verdicts/expiry/scheduler — plan 15).

## 4. Data plane & migrations

- **Relational** (core, renditions mirror, tags/categories/subjects/people, verdicts), **document**
  (extensible fields, shot-list), **search index** (OpenSearch), **cache** (Redis). Writes transactional
  in relational; document + index updated via **outbox**. Index projections versioned + rebuildable
  (offline reindex path). Additive migrations.

## 5. APIs & events

- REST: [`mam.yaml`](../../architecture/openapi/mam.yaml) — `/assets`, `/assets/{id}/versions`,
  `/assets/{id}/approve|reject|verdicts`, `/search` (simple+faceted), `/field-schemas`,
  `/tags|categories|subjects`, `/people`, `/assets/{id}/people`.
- **Emits:** `asset.created/updated/ready/approved/rejected/expired/replaced/deleted`,
  `person.created/linked`, `taxonomy.updated`. **Consumes:** `ingest.accepted`, `transcode.completed`,
  `ai.enrichment.completed`, `ai.suggestion.raised`, `file.moved`.

## 6. Dependencies & integration points

- **Requires first:** data plane, [HSM](hsm-plan.md) (rendition location), [MTS](mts-plan.md) (results),
  broker. **Consumed by:** [Scheduling](scheduling-plan.md) (approved assets), Studio (catalog/search),
  everything downstream.

## 7. Testing focus

- Ready-assembly gate (renditions + mandatory metadata) correctness.
- **Search projection** rebuild-by-replay = relational truth; outbox prevents drift; p95 < 500 ms
  ([NFR-PERF-2](../../requirements/06-non-functional-requirements.md#performance)).
- Clone-on-replace metadata fidelity + reference swap.
- Provenance: AI never overwrites mandatory fields.
- Review-lifecycle suite (see [plan 15 §WS-J](../15-review-lifecycle-implementation-plan.md#ws-j--testing-strategy)).

## 8. Scaling & deployment

- **Read-heavy:** scale read replicas + cache; index asynchronously; ≥5M assets, ≥200 updates/s
  ([NFR-CAP](../../requirements/06-non-functional-requirements.md#capacity)). Config: core-field set,
  per-type field schemas, vocabularies, mandatory-metadata policy, cache TTLs, index/analyzer
  (multilingual/RTL), review-lifecycle config (plan 15).

## 9. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Dual-write drift (relational vs index/doc) | Outbox + rebuildable projections; reconcile job. |
| Search latency at scale | Read replicas + cache + async index; measure p95 continuously. |
| Extensible-schema sprawl | Typed FieldSchema + validation; governance tooling (Post-v1.0). |
| MAM down = metadata path blocked | HA replicas; cache serves some reads; it's the critical read path. |
