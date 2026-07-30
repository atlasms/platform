# Market, Customers & Competitive Positioning

> Who Atlas is for, who it competes with, and where it wins. Based on stakeholder research
> into Dalet, Avid, Superdesk, and the streaming/OVP vendors. Parent:
> [Technical Brief](../01-technical-brief.md). Scope consequences:
> [Production Lifecycle Scope](19-production-lifecycle-scope.md).

## 1. Target customers

Four segments, in priority order. The first is the launch beachhead
([A6](../README.md#assumptions-register)).

| # | Segment | What they need | Why Atlas fits |
|---|---------|----------------|----------------|
| 1 | **Broadcasting companies** (TV **and radio** stations) | Ingest → metadata → approval → schedule → playout, with automation and archive | The core spine Atlas already specifies; radio is a first-class case, not an afterthought (audio-only assets, audio editor, audio playout lists) |
| 2 | **News organizations** | Planning, assignments, rundowns, scripts, fast turnaround, wires, multi-platform publishing | [Newsroom](../architecture/services/newsroom.md) + planning; the segment where an integrated spine beats point tools most clearly |
| 3 | **Government & institutes** | Archive, catalogue, governed access, compliance retention, **air-gapped** operation | Atlas's on-prem/air-gapped stance ([A9](../README.md#assumptions-register)) is a genuine differentiator — most rivals are cloud-first |
| 4 | **Content owners & distributors** | Catalogue, rights windows, versioning, deliverables, multi-destination publishing | MAM + rights + [Integration/Feeds](../architecture/services/integration-feeds.md) |

**Radio deserves explicit design attention.** Segment 1 includes audio-only stations, which
change assumptions in several services (no video renditions, different playlist formats,
different editor surface). This is called out in the
[lifecycle scope](19-production-lifecycle-scope.md) and should be tested against a real radio
workflow before v1.0.

## 2. Competitive landscape

### 2.1 Direct rivals — end-to-end media operations

| Vendor | Products | Strengths | Where Atlas can win |
|--------|----------|-----------|---------------------|
| **Dalet** | Flex (cloud-native MAM/workflow, ex-Ooyala Flex), Galaxy five (enterprise MAM + news + automation), Pyramid (news), Media Cortex (AI) | Genuinely end-to-end; deep news; mature ecosystem; strong references | Cost and implementation weight; long deployments; enterprise-only sizing. Atlas targets mid-size with faster time-to-value and a modern, service-based core |
| **Avid** | MediaCentral platform, Media Composer, Production/Asset Management, iNEWS, Edit On Demand, Maestro | NLE dominance and craft credibility; iNEWS in news; owns key interchange formats (AAF/MXF) | Licensing complexity and legacy footprint; heavyweight infrastructure. Atlas can be simpler to run and own, and web-first rather than desktop-first |
| **Vizrt** | Viz One (MAM), Mosart (studio automation), graphics stack | Graphics + studio automation leadership | Atlas doesn't compete on graphics; it integrates |
| **Cinegy, Imagine, Grass Valley, Pebble, Etere** | Playout automation, traffic, channel-in-a-box | Deep, proven playout | Atlas deliberately **integrates** rather than competes here ([D1](../01-technical-brief.md#9-resolved-decisions)) — Cinegy is both the first [playout target](../integrations/14-playout-mcrlist-format.md) *and* an adjacent vendor |

> **Ooyala** no longer exists as an independent rival — Ooyala Flex was acquired by Dalet and
> became **Dalet Flex**. Treat it as Dalet, not a separate competitor.

### 2.2 Adjacent — not direct rivals

**Brightcove** and **Kaltura** are **OVPs** (online video platforms): streaming, distribution,
audience engagement, monetization, video portals. They do not do broadcast ingest, playout
scheduling, or production workflow. They are **downstream integration targets** for Atlas
(publish destinations via [Integration/Feeds](../architecture/services/integration-feeds.md)),
not competitors. Positioning Atlas against them would be a category error.

### 2.3 News — the open-source benchmark

**Superdesk** (Sourcefabric) is an enterprise-grade **open-source** newsroom: planning,
assignments, authoring, curation, publishing, built on IPTC standards (NewsML-G2 / ninjs).

Two implications:
1. **It validates the news-planning scope.** Superdesk proves the demand and the shape of news
   pre-production (planning → assignment → production → curation → publish). Atlas's
   [Planning service](../architecture/services/planning.md) should be measured against it.
2. **It sets a price floor in news.** A credible open-source alternative exists in this segment,
   so Atlas's news value must come from **integration with the broadcast spine** (rundown →
   schedule → playout → archive in one system), which Superdesk does not provide.

**There is no Superdesk-equivalent for broadcast operations.** That gap — an open, modern,
service-based broadcast platform for mid-size operators — is Atlas's clearest opening.

### 2.4 Pre-production tooling (a different competitive set)

Pre-production is served by a fragmented set of specialist tools rather than the broadcast
vendors: **Movie Magic Scheduling/Budgeting**, **StudioBinder**, **Yamdu**, **Celtx**,
**Final Draft** (scripts), **Autodesk Flow Production Tracking** (ex-ShotGrid) and **ftrack**
(production tracking). These are strong, cheap, and entrenched — a decisive reason Atlas should
**integrate rather than rebuild** most craft-specific pre-production tooling
([lifecycle scope §2](19-production-lifecycle-scope.md#2-pre-production)).

## 3. Atlas's differentiation

Where Atlas is genuinely different, rather than merely comparable:

1. **One spine across the lifecycle, not a suite of acquisitions.** Rivals' end-to-end stories
   are assembled from acquired products with seams. Atlas is a single service-based platform
   with one identity model, one metadata model, one event backbone.
2. **Mid-size economics.** Dalet and Avid are priced and scoped for large enterprises. The
   [baseline customer](../README.md#assumptions-register) is 1–3 channels / 10–100 users, sized
   and priced accordingly.
3. **Air-gapped capability.** The core runs fully offline ([FR-PLat-7](../requirements/05-functional-requirements.md#platform)),
   which most cloud-first rivals cannot offer — decisive for **government/institutional** buyers.
4. **Deployment freedom.** The same containers run **on-prem, hybrid, or vendor-hosted SaaS**
   ([Architecture §7](../architecture/02-system-architecture.md#7-deployment-shapes)).
5. **Open by construction.** Documented REST + events, an
   [integration guide](../integrations/10-third-party-developer-guide.md), pluggable playout
   formats, and **standards conformance** ([FIMS, EBUCore, BXF, OTIO](../integrations/20-standards-and-fims.md))
   — versus the closed, certified-partner model typical of the incumbents.
6. **Radio and video as equals.** Most MAM/automation platforms treat audio as a degraded video
   case; Atlas treats audio-only stations as a first-class segment.

## 4. Where Atlas should *not* compete

Being explicit about this is what keeps the plan achievable:

- **Craft creative tools** — Premiere, After Effects, Audition, Pro Tools, DaVinci. Atlas
  integrates ([lifecycle scope §4](19-production-lifecycle-scope.md#4-post-production)).
- **Playout hardware and channel-in-the-box** — [D1](../01-technical-brief.md#9-resolved-decisions).
- **Graphics/CG systems** — Vizrt et al.
- **Streaming/OVP delivery, CDN, monetization** — Brightcove/Kaltura are partners.
- **Full finance/ERP and HR/payroll** — integrate at the boundary
  ([lifecycle scope §2](19-production-lifecycle-scope.md#2-pre-production)).

## 5. Positioning statement

> **Atlas is the open, service-based media operations platform for mid-size broadcasters, news
> organizations, institutions, and content owners — covering planning through playout and
> archive in one system, deployable on-prem, hybrid, or hosted, and standards-based so it fits
> the tools customers already own.**

---
_Next: [Production Lifecycle Scope](19-production-lifecycle-scope.md) ·
[Standards & FIMS](../integrations/20-standards-and-fims.md)._
