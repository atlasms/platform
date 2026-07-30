# Non-Functional Requirements

> Quality attributes and their measurable targets (`NFR-<area>-<n>`). Targets are stated for
> the **v1.0** release unless noted; MVP/Beta relax some (marked). Parent:
> [Technical Brief](../01-technical-brief.md). Sizing that satisfies these:
> [Hardware & Infrastructure](07-hardware-requirements.md).

**Baseline scenario for the targets** ([A6](../README.md#assumptions-register)): one mid-size
broadcaster, **1–3 channels, 10–100 concurrent Studio users**, ingest peaks of ~50
items/hour, asset library up to ~2–5 million assets. Targets keep some headroom above this so
the first customer can grow without re-architecting.

---

## Performance & scalability {#performance}

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-PERF-1 | Studio interactive API latency (reads) | p95 < 300 ms, p99 < 800 ms |
| NFR-PERF-2 | Search query response (simple) | p95 < 500 ms over the baseline library |
| NFR-PERF-3 | Live change → Studio update (WebSocket) | < 1 s from event to client |
| NFR-PERF-4 | Proxy + thumbnail available after ingest accept | < 3 min for a 10-min HD file (1 GPU worker) |
| NFR-PERF-5 | Transcode throughput scales linearly with MTS instances | ±15% linearity to 20 workers |
| NFR-PERF-6 | Ingest sustained rate | ≥ 100 items/hour without queue growth at target infra |
| NFR-PERF-7 | Send-to-air export of a 2-hour hi-res playlist | < 10 min on the control-room LAN |
| NFR-PERF-8 | Concurrent Studio users per deployment | ≥ 100 (v1.0, first customer), ≥ 40 (MVP); architecture SHALL scale further by adding capacity |

## Availability & resilience {#availability}

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-AVAIL-1 | Platform availability (critical path: gateway, IAM, MAM, HSM, MTS control, broker) | 99.9% (v1.0); best-effort (MVP) |
| NFR-AVAIL-2 | No single point of failure on the critical path | HA (≥2 replicas / clustered) at v1.0 |
| NFR-AVAIL-3 | Non-critical service outage (AI, analytics) | MUST NOT block ingest→approval |
| NFR-AVAIL-4 | Broker delivery guarantee | at-least-once, durable, DLQ on poison |
| NFR-AVAIL-5 | Recovery Time Objective (RTO) | < 1 h (v1.0) |
| NFR-AVAIL-6 | Recovery Point Objective (RPO) | < 5 min for metadata; asset masters protected by tiering + checksum |
| NFR-AVAIL-7 | Graceful degradation of WebSocket | Studio falls back to polling |

## Security & privacy {#security--privacy}

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-SEC-1 | Transport encryption | TLS 1.2+ external, mTLS internal |
| NFR-SEC-2 | Token model | short-lived JWT access + rotating, revocable refresh (per [FR-IAM-5](05-functional-requirements.md#iam)) |
| NFR-SEC-3 | Authorization enforced in depth | gateway coarse scopes + per-service resource checks |
| NFR-SEC-4 | Storage credentials isolation | only HSM holds storage credentials |
| NFR-SEC-5 | Encryption at rest | databases and storage tiers encrypted; per-tenant keys in dedicated tier |
| NFR-SEC-6 | Secrets management | vault-managed; none in images/config |
| NFR-SEC-7 | Audit | append-only, tamper-evident, per-policy retention |
| NFR-SEC-8 | PII handling | cast/contributor + user PII tagged; retention & erasure workflow |
| NFR-SEC-9 | Vulnerability posture | dependency scanning in CI; critical CVEs patched < 7 days |
| NFR-SEC-10 | Penetration test | before v1.0 GA and annually |

## Maintainability & extensibility {#maintainability}

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-MNT-1 | Each service independently deployable | zero-downtime rolling deploys |
| NFR-MNT-2 | Message/API contracts versioned | additive within major; tolerant readers |
| NFR-MNT-3 | Test coverage on critical-path services | ≥ 80% line, meaningful integration tests |
| NFR-MNT-4 | Infrastructure as code | full environment reproducible from repo |
| NFR-MNT-5 | New media type / metadata schema | added via config, no deploy ([FR-PLat-4](05-functional-requirements.md#platform)) |
| NFR-MNT-6 | Mean time to onboard a new service | documented service template + CI in < 1 day |

## Observability {#observability}

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-OBS-1 | Structured logs with correlation id | 100% of services |
| NFR-OBS-2 | Metrics (RED/USE) per service | exposed and scraped |
| NFR-OBS-3 | Distributed tracing on critical path | gateway→services→broker |
| NFR-OBS-4 | Alerting on SLO burn, queue depth, checksum mismatch, DLQ | actionable alerts, low noise |

## Usability & accessibility {#usability}

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-USE-1 | Responsive desktop/tablet-first UI | usable at ≥ 1024px; graceful below |
| NFR-USE-2 | Internationalization | multilingual + RTL; externalized strings |
| NFR-USE-3 | Accessibility | WCAG 2.1 AA for core workflows (target) |
| NFR-USE-4 | Workspace personalization persisted | per [FR-UI-3](05-functional-requirements.md#studio) |

## Interoperability & portability {#interop}

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-INT-1 | Cross-platform services | run on Linux and Windows containers |
| NFR-INT-2 | Standard media handling | FFmpeg-supported containers/codecs per config |
| NFR-INT-3 | Open integration surface | documented REST + webhook/event APIs ([Integration guide](../integrations/10-third-party-developer-guide.md)) |
| NFR-INT-4 | Standards where applicable | EPG (e.g. XMLTV/TVA), HbbTV, MOS (newsroom), VTT (previews), **MCRList / standard playlist export** for playout |
| NFR-INT-5 | **Offline / air-gapped operation** | Full **core** function with **no internet**; **AI is online-first** and degrades to a limited local tier or off ([D4](../01-technical-brief.md#9-resolved-decisions)); other cloud features are optional plug-ins ([A9](../README.md#assumptions-register), [FR-PLat-7/8](05-functional-requirements.md#platform)) |
| NFR-INT-6 | Installability without external package/registry access | Deployable from a **local artifact/model registry** (offline install bundle) |

## Compliance & data governance {#compliance}

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-CMP-1 | Data protection | GDPR-aligned handling of PII. **Cast/people PII is deliberately minimal — name, role in the media, optional image — for metadata/search only** ([D5](../01-technical-brief.md#9-resolved-decisions)); no broader biometric profiling |
| NFR-CMP-1a | People-data governance | Person records support review/erasure; face-matching runs only against this limited register and only proposes matches for human confirmation |
| NFR-CMP-2 | Broadcast/regulatory logging | as-run/audit retention per customer policy |
| NFR-CMP-3 | Content rights | rights windows enforced in scheduling ([FR-SCH](05-functional-requirements.md#scheduling)) |
| NFR-CMP-4 | Data residency | supported via tenancy tiers ([Architecture §Tenancy](../architecture/02-system-architecture.md#tenancy)) |

## Capacity & data volume {#capacity}

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-CAP-1 | Asset catalog size | ≥ 5M assets searchable at target latency |
| NFR-CAP-2 | Metadata write rate | ≥ 200 asset updates/sec sustained |
| NFR-CAP-3 | Event throughput | ≥ 10k events/sec on the broker at target infra |
| NFR-CAP-4 | Storage tiers | online (days), near-line (weeks/months), offline (archive) per policy |

---

## Verification {#verification}

How each NFR class is proven:

| Class | Method |
|-------|--------|
| Performance / capacity | Load tests against the baseline scenario in CI-adjacent perf env; published dashboards. |
| Availability / resilience | Chaos/failover drills (kill critical services, broker partition); RTO/RPO measured. |
| Security | SAST/DAST + dependency scanning in CI; external pen test before GA (NFR-SEC-10). |
| Maintainability | Coverage gates, contract tests between services, IaC apply from clean state. |
| Observability | Synthetic incident: confirm trace + logs + alert fire end-to-end. |
| Usability / a11y | Automated a11y checks + moderated usability sessions on core flows. |
| Compliance | Policy review + audit-log integrity test + data-erasure test. |

Every NFR should have at least one automated or scripted check before its owning release
([Roadmap](../roadmap/08-roadmap.md)) is declared done.

---
_Next: [Hardware & Infrastructure Requirements](07-hardware-requirements.md)._
