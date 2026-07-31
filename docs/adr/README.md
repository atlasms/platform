# Architecture decision records

One file per decision that is **expensive to reverse**: a datastore, a broker, a protocol, a
framework that ends up in every service. Not every choice needs one — if it can be changed in an
afternoon behind an interface, just change it.

**Naming:** `NNNN-short-slug.md`, numbered in the order decided, never renumbered.

**Status:** `Proposed` → `Accepted` → (`Superseded by NNNN` | `Deprecated`). An accepted ADR is
never edited to change its decision; a new ADR supersedes it and links back. The record of what we
believed *at the time*, and why, is the point.

**Sections:** Context · Options · Evidence · Decision · Consequences · Revisit when.

The *Evidence* section is what separates these from opinion. Where a spike produced numbers, the
numbers go in, along with the harness that produced them, so a future reader can re-run it and
disagree with data.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-message-broker.md) | NATS JetStream as the message broker | Accepted |
