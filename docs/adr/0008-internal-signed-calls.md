# ADR-0008 — A service's own components call each other with signed internal requests

- **Status:** Accepted — chosen by the product owner, 2026-09-27
- **Date:** 2026-09-27
- **First use:** EP-39 — the `rim-recorder` worker handing finished files to RIM ([ADR-0007](0007-recorders.md))
- **Code:** `signInternal` / `verifyInternal` in [`@atlas/service-kit`](../../libs/service-kit/src/internal-auth.ts)

## Context

Every request so far enters through the gateway: it verifies the caller's token against IAM,
resolves the principal, and forwards the identity to the service in `x-atlas-*` headers, which the
service trusts because only the gateway can reach it (api-gateway.md §10). Authorization then
happens in the service with the caller's policy, **in the caller's home channel**.

ADR-0007's recorder worker breaks both assumptions. It is not a person and has no token; and one
worker records for many channels, while an upload through the gateway lands in the caller's home
channel. It must still hand each finished file to RIM — whose staging is RIM's own volume — and the
chunked upload (EP-15.1) is the right machinery for that. Something has to say "this request is
RIM's own worker", and the channel has to come from what is being recorded, not from who asks.

## Options

1. **Signed internal calls.** RIM and its worker share an HMAC key (a Kubernetes Secret). The worker
   calls `/internal/…` routes on RIM directly — the gateway routes only `/api/v1/…` and `/auth/…`, so
   they are unreachable from outside — signing the method, the path, a timestamp and the SHA-256 of
   the body. RIM refuses a missing, wrong or stale signature. The channel comes from the capture row
   the request names. The gateway document already names an "internal-header signing key".
2. **Kubernetes workload identity.** The worker presents its projected service-account token; RIM
   verifies it with the TokenReview API. No shared secret — but RIM needs RBAC to the Kubernetes API
   and depends on it at runtime for every hand-off.
3. **IAM service principals.** Client credentials in IAM, grants across channels, the worker using
   the normal gateway upload. The most general, and the largest change: IAM, the gateway's channel
   model and the public API.

## Decision

**Option 1**, scoped to calls between the components of ONE service (RIM and `rim-recorder` share
RIM's code, its Postgres schema and now a key).

- **The signature** is `HMAC-SHA256(key, METHOD \n PATH \n TIMESTAMP \n SHA256(BODY))`, hex, sent as
  `x-atlas-internal: v1,t=<unix seconds>,sig=<hex>`. The path includes the query string. A request
  more than **60 s** from the verifier's clock is refused, as is one signed with no current key.
  Comparison is constant-time.
- **Keys rotate without downtime:** the verifier accepts any key in its list, the signer uses the
  first. A key is at least 32 bytes. It is never logged, never a metric, never in an event.
- **Replay** inside the 60 s window is possible and deliberately tolerated: every internal operation
  is idempotent (a part sent again wins; completing an upload twice returns the same job), so a
  replay achieves nothing a retry would not. A non-idempotent internal operation would need a nonce
  and must say so in its own design.
- **Authority comes from the resource, not the caller.** An internal route acts for the channel of
  the capture it names, as the service's own actor (`rim-recorder`), and its writes are audited as
  that actor. It never takes a channel or a user from the request.
- **Transport:** in-cluster traffic is plain HTTP today; the signature authenticates, it does not
  encrypt. Service-to-service mTLS (architecture §5.3) remains the goal and would not replace this:
  it says which workload is talking, this says the request is one of ours and unaltered.

## Consequences

- The gateway never routes `/internal/`. A route added there by mistake would be caught by the
  service refusing unsigned requests, but the gateway's route table (in `main.ts`) is where the
  rule lives, and it is written down beside it.
- A new component pair that needs this adds its key to its own Secret; keys are not shared across
  services — a leaked RIM key reaches RIM's internal routes and nothing else.
- IAM service principals (option 3) are still the answer for a caller that is NOT part of the
  service it calls — a partner system, another service's workflow. This ADR does not cover them.

## Revisit when

- A caller outside the service needs internal access (→ option 3).
- The cluster gets a service mesh with workload identity (→ option 2, or mTLS identities, may
  replace the shared key).
