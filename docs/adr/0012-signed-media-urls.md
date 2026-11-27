# ADR-0012 — A browser reads media through a short-lived URL MAM signs and HSM serves

- **Status:** Accepted. The product owner chose it on 2026-11-21. It touches HSM's read path, so
  the paired review of AGENTS.md §5.7 is owed, as for [ADR-0009](0009-hsm-storage-and-placement.md).
- **Date:** 2026-11-23
- **First use:** EP-26.4, the media editor playing its editing proxy ([ADR-0011](0011-editing-proxy-scrubbing.md))
- **Code:** `signMediaUrl` / `verifyMediaUrl` in [`@atlas/service-kit`](../../libs/service-kit/src/media-url.ts);
  MAM's `GET /assets/{id}/files/{kind}/url`; HSM's `GET /media/v1/…`; the gateway's streaming `/media/` route

## Context

Studio has never played media. The media editor must (ADR-0011: a `<video>` seeking a short-GOP
proxy over **HTTP Range**), and so will the asset editor's preview, the review screen and, later, a
third party ([developer guide §8](../integrations/10-third-party-developer-guide.md#8-media-access):
"request a time-limited signed URL from the API; HSM brokers the actual file access").

Nothing serves a file's bytes to a browser today:

- HSM's only read of bytes is `GET /internal/v1/…/content`, signed service to service
  (ADR-0008). The gateway never routes `/internal/`.
- Every routed request carries `Authorization: Bearer`, and a `<video src>` cannot send one. Studio
  deliberately keeps its token in memory only (AGENTS.md: "Studio never persists a token"), so
  there is no cookie for the browser to send either.
- The gateway reads every upstream body with `text()`. That corrupts binary data, buffers the whole
  file, and drops `Range`.

## Options

1. **A short-lived signed URL.** MAM, which owns the authorization question ("may this person read
   this asset's files?"), answers it and returns a URL carrying an HMAC over exactly what it
   grants: one file of one asset in one channel, until a time. HSM, which holds the bytes, verifies
   the signature and serves the file with Range. The gateway routes `/media/` with no bearer,
   because the signature is the credential. This is what the developer guide already promises.
2. **An httpOnly session cookie** from IAM that the gateway accepts on media GETs. It also fixes
   Studio's token-in-memory trade-off, but it changes authentication itself: IAM issues cookies,
   the gateway accepts two credentials, and every write needs CSRF protection. It does not serve
   a third party, which has no session.
3. **Fetch with the bearer into a `blob:` URL.** No backend change, but there is no Range: the
   whole proxy is downloaded before the first frame, and it lives in memory. That is fine for a
   30-second clip and fails at the length a news editor cuts from.

## Decision

**Option 1** (the product owner, 2026-11-21).

- **What is signed** is a canonical string, not the raw URL, so query order and encoding cannot
  matter: `atlas-media-v1 \n channelId \n assetId \n kind \n variant \n contentType \n exp`
  (`variant` empty when absent; `exp` in unix seconds). The signature is HMAC-SHA256, hex,
  compared in constant time. The URL is
  `/media/v1/{assetId}/{kind}?ch=…&v=…&ct=…&exp=…&sig=…`.
- **The key** is a new Secret, **`media-url-keys`**, mounted into MAM (the signer, which uses the
  first key) and HSM (the verifier, which accepts any of them), so it rotates without downtime as
  ADR-0008's keys do.
  - It is at least 32 bytes. It is never logged, never a metric and never in an event.
  - It is not ADR-0008's internal-call key, and it is not the third cross-service reader that
    ADR-0008's amendment warns about. It authenticates no service: it is a **capability for a
    browser**, which IAM service principals (that amendment's answer) could not serve either.
  - A leaked key lets its holder read any file of any channel until it is rotated. That is the
    same blast radius as `hsm-internal-keys`, so it is held to the same rules.
- **Authorization is MAM's, at signing.** `GET /assets/{id}/files/{kind}/url?variant=` asks what
  `GET /assets/{id}/files` asks: `asset:read` on the asset's `files` group, enforced
  (`canEnforce`), in the caller's channel. Another channel's asset is a 404. The file must be in
  MAM's mirror, **online** and available. A near-line or offline file is a 409, because a restore
  comes first, exactly as for send-to-air. MAM picks the content type: the rendition's
  `fileType`, or the asset's for its original, through a fixed map of media types. It answers
  `{ url, expiresAt }`.
- **HSM re-checks the ledger at serving.** That covers the live file of `(asset, kind, variant)`,
  **in the signed channel** (#577's rule: another channel's file is answered as a missing one), and
  online. Every request is checked, not only the first, so an expired URL stops working mid-playback.
  - A bad signature, an expired `exp`, or an `exp` further ahead than the **4-hour ceiling** is a
    403. The ceiling means a signer bug cannot mint a long-lived capability.
  - It serves `Accept-Ranges: bytes`. A single `Range` gets a 206 with `Content-Range`; anything
    else gets the whole file as a 200 (a server may ignore Range). An unsatisfiable range is a 416.
  - The response carries `Content-Type` (signed), `X-Content-Type-Options: nosniff`,
    `Content-Security-Policy: default-src 'none'; sandbox`, `Content-Disposition: inline` and
    `Cache-Control: private, max-age=<seconds left>`. A media URL on the platform's own origin must
    never be a page that runs script, even if a content-type mapping were ever wrong.
  - The storage drivers read ranges natively (fs: `start`/`end`; S3: `Range`), held by their
    conformance suite against the filesystem and a real S3 server.
- **The URL lives 30 minutes by default** (`ATLAS_MEDIA_URL_TTL_S`, at most the 4-hour ceiling).
  A player asks for a fresh one when the element errors, and resumes where it was. A shorter life
  is a smaller window for a URL copied out of the browser; a longer one interrupts fewer edits. Nothing
  revokes a URL early: an access withdrawn mid-session still plays until `exp`. That is accepted for
  a 30-minute read of one file, and it is the reason the ceiling exists.
- **The gateway** routes `/media/` to HSM as **public** (no bearer: the signature is checked by
  HSM, not the gateway) and **streaming**. It forwards `Range` and `If-Range`, pipes the body
  without reading it, relays `Content-Range`, `Accept-Ranges`, `Content-Length` and the safety
  headers, and allows GET and HEAD only. The route has its own per-address budget, generous
  enough for a scrub's burst of range requests. It is the second public prefix after `/auth`.

## Consequences

- A media URL is a bearer capability: anyone holding it reads that one file until it expires.
  Studio keeps it in memory only, like its token. A URL in a server log is the obvious leak, so the
  gateway's and HSM's request logs record the path without the query string.
- `media-url-keys` is **optional to the chart**, like the other signing Secrets. Without it MAM
  answers the URL request 503 ("media URLs are not configured") and HSM refuses every `/media/`
  request. The dev overlay generates one, and a site creates it before the first install
  ([helm README](../../infra/helm/README.md)).
- Third parties (developer guide §8) get the same endpoint once they have principals. Nothing
  here is Studio-specific.
- Bytes leave HSM through the gateway, so the gateway pod carries media traffic. A deployment
  that serves much of it puts a CDN in front of `/media/`. The URL is already shaped for that
  (a cache key without credentials, `private` caching only).

## Revisit when

- Studio gets an httpOnly session (option 2): a cookie could then authorize media for Studio,
  while third parties still need the signed URL.
- Per-URL revocation is required (a takedown that must stop playback within seconds): that needs
  a nonce and a deny list, or a much shorter life with refresh.
