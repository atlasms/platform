# `@atlas/websocket`

Permission-aware fan-out of platform events to Studio
([websocket.md](../../docs/architecture/services/websocket.md)). Public channels carry what everyone
in a tenant may see; private channels are per-user.

## What is built

**EP-09.1/09.2** the connection + subscription registry and the eligibility rules · **EP-09.3** the
broker → socket bridge · **EP-13.2** the `/ws` endpoint that puts a server in front of them.

Until EP-13.2 this package was a **library with no entry point**: three well-tested pieces and
nothing that ran. Studio's client (EP-11.4) had been queueing subscriptions against an endpoint that
did not exist since the day it was written.

**Not built:** `resume` and the replay window, `progress` frames, Redis presence and cross-node
routing — see [below](#what-is-deliberately-missing).

## It does not sit behind the gateway

The gateway proxies with `fetch`, which cannot perform a protocol upgrade — so `/ws` was never going
to be another row in its routing table, and the choice was between teaching it to pipe raw sockets
and routing around it. Routing around it won on three counts: this service **already** authenticates
its own tokens (websocket.md §10 requires validation at upgrade, so the gateway would add no
security to this path), a stateless proxy tier would hold a second socket open for the life of every
connection, and §8 wants connections sticky per node, which is easier when the ingress addresses
pods directly.

In production that is **one ingress and one origin**: `/ws` here, everything else to the gateway.
The browser never learns there are two backends. In kind there is no ingress controller, so the
service gets NodePort 30081 and Studio's dev proxy forwards `/ws` to it with `"ws": true` — the
application code sees one origin either way.

The consequence worth stating: these connections do **not** pass through the gateway's rate limiting
(EP-08.3). The per-node connection cap websocket.md §11 specifies is what should bound them, and it
is not built.

## The protocol

JSON frames over a single socket at `GET /ws` (Upgrade).

| Frame                         | Direction       | Meaning                                              |
| ----------------------------- | --------------- | ---------------------------------------------------- |
| `subscribe` / `unsubscribe`   | client → server | Join or leave a subject pattern.                     |
| `subscribed` / `unsubscribed` | server → client | The server acted on it.                              |
| `event`                       | server → client | A permitted domain event, `{ subject, payload }`.    |
| `error`                       | server → client | A refusal, or a frame the server did not understand. |
| `permissions-changed`         | server → client | A subscription was dropped mid-session.              |

Subjects are `atlas.<channelId>.<domain>.<action>` and `user.<userId>.<…>`; patterns may use the
broker's wildcards (`atlas.ch12.asset.>`).

## Authentication happens BEFORE the upgrade

The token arrives as `?token=` — not a preference, a constraint: the browser `WebSocket`
constructor takes a URL and protocols and offers no way to set a header. A bearer header is also
accepted, so nothing that _can_ send one is forced to put a credential in a URL. It is always the
**access** token, never the refresh token, which is why a 15-minute life matters.

Verification runs in `preValidation`, so a bad token is an **HTTP 401 with a body**. The tempting
shape — upgrade first, then close with a status code — is worse: the browser surfaces a closed
socket with no body, so the client cannot tell "your token expired" from "the service is down", and
Studio's backoff loop would retry a permanent auth failure forever.

The connection also **fails closed on policy**. If IAM cannot say what the caller may see, the
upgrade is refused rather than admitted with no rules — `can()` is deliberately lenient, so a
rule-less policy meeting an incomplete context reads as _any_. An IAM outage must cost connections,
never widen them.

## Eligibility is checked twice, and the second one is the boundary

`subscribe` is refused at the door when the pattern is not permitted — that is an early refusal, so
an ineligible client is turned away once instead of being filtered on every message. **Delivery
re-checks per message anyway.** A grant can be revoked between the two, and a wildcard subscription
matches subjects that did not exist when it was created.

A `permissions.changed` event refetches the policy and drops the subscriptions it no longer permits
**on the open socket**, without waiting for a reconnect. If the refetch fails, the user's connections
are **closed**: keeping them open would keep delivering under grants just announced stale, and
applying an empty policy would leave the client attached but permanently deaf with nothing to prompt
a resubscribe once IAM returns. A closed socket is the one outcome the client already recovers from.

## What is deliberately missing

`websocket.md` §4 also specifies `resume` and `progress` frames. `resume` replays the gap from a
**Redis-backed window** (§6.2), and Redis is EP-07.4 — unbuilt. A `resume` that acknowledged the
frame and replayed nothing would be worse than its absence, because the client would believe it had
caught up. It is refused **by name** as an unsupported frame, so a client finds out immediately
rather than inferring it from events that never arrive.

Presence, cross-node routing and horizontal scale (§8) need the same Redis. One replica today.

## Running it

```sh
npx nx test @atlas/websocket        # 34 tests
node --import tsx src/main.ts       # needs IAM for JWKS; NATS is optional
```

| Env                     | Default            | Purpose                                                  |
| ----------------------- | ------------------ | -------------------------------------------------------- |
| `PORT` / `HOST`         | `3000` / `0.0.0.0` | Listen address.                                          |
| `ATLAS_IAM_ORIGIN`      | `http://iam:3000`  | JWKS **and** effective-permissions.                      |
| `ATLAS_NATS_URL`        | `nats://nats:4222` | The event source.                                        |
| `ATLAS_POLICY_TTL_MS`   | `30000`            | Policy cache — a **revocation window**, not a perf knob. |
| `ATLAS_WS_HEARTBEAT_MS` | `30000`            | Ping period; `0` disables.                               |

**IAM is a critical readiness dependency; NATS is not.** Without IAM every upgrade is a 401, so
reporting ready would only route connection attempts into refusals. Without NATS the service still
accepts connections and answers subscribes — what stops is live delivery, and Studio's panels
already reconcile by refetching. Failing readiness there would take the socket out of service to
protect the broadcast, which inverts the priority. Same reasoning MAM applies to its outbox relay.

## Testing note

Most tests drive `app.injectWS()`, which runs a real upgrade through the real plugin over an
in-memory duplex — no port, no flakiness. It has one blind spot: it does **not** complete a closing
handshake, so a client `close()` there never fires the server's `close` event. One test therefore
binds an ephemeral port and uses Node's built-in `WebSocket` client (the same API the browser gives
Studio, and no new dependency) to prove the full lifecycle including a graceful disconnect.
Asserting registry drainage under `injectWS` would have been asserting the mock.
