// EP-13.2 — the `/ws` server endpoint.
//
// EP-09 built the registry, the eligibility rules and the broker bridge, and stopped there: a
// library with no entry point. Studio's client (EP-11.4) has been queueing subscriptions against
// an endpoint that did not exist since it was written. This is that endpoint, and nothing more —
// it wires the three existing pieces to a socket and gets out of the way.
//
// WHAT IS DELIBERATELY NOT HERE. `websocket.md` §4 also names `resume` and `progress` frames. The
// resume window is a Redis-backed replay buffer (§6.2), and Redis is EP-07.4, unbuilt. A `resume`
// that acknowledged the frame and replayed nothing would be worse than its absence: the client
// would believe it had caught up on the gap. It is refused as an unknown frame until there is a
// buffer behind it.

import { randomUUID } from 'node:crypto';
import websocketPlugin from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { EffectivePolicy } from '@atlas/policy';
import {
  goldenSignals,
  HealthRegistry,
  MetricRegistry,
  Unauthorized,
  verifyJwt,
  type Claims,
} from '@atlas/service-kit';
import type { ConnectionRegistry, Connection, ServerFrame } from './registry.ts';

/** Frames a client may send. Anything else is answered with an `error` frame, not ignored. */
type ClientFrame = { type: 'subscribe' | 'unsubscribe'; pattern?: unknown };

export interface WebsocketAppOptions {
  /** Shared with the broker bridge, so a published message reaches these connections. */
  registry: ConnectionRegistry;
  /** IAM's key set. `remoteJwks(...)` in production. */
  jwks: Parameters<typeof verifyJwt>[1];
  /**
   * Resolves the caller's compiled policy — `PolicyClient` from `@atlas/policy/client` against IAM
   * in production. FAILS CLOSED: `undefined` refuses the connection rather than admitting one with
   * no rules, which lenient evaluation would eventually read as "any".
   */
  policyFor: (userId: string) => Promise<EffectivePolicy | undefined> | EffectivePolicy | undefined;
  issuer?: string;
  audience?: string;
  health?: HealthRegistry;
  metrics?: MetricRegistry;
  /**
   * Heartbeat period. Each tick pings every socket and closes any that did not answer the previous
   * one — a half-open TCP connection is indistinguishable from an idle client at this layer, and
   * without this the registry accumulates connections that will never receive anything again.
   * `0` disables it, which is what the tests want.
   */
  heartbeatIntervalMs?: number;
  /** Connection lifecycle (websocket.md §12): connect, subscribe, disconnect-with-reason. */
  onConnectionLog?: (record: ConnectionRecord) => void;
  onError?: (err: unknown, context: { correlationId: string; url: string }) => void;
}

export interface ConnectionRecord {
  event: 'connected' | 'disconnected' | 'subscribed' | 'refused';
  connectionId: string;
  userId?: string;
  channelId?: string;
  pattern?: string;
  reason?: string;
}

const BEARER = /^Bearer (.+)$/i;

/**
 * The token arrives as a QUERY PARAMETER, not a header.
 *
 * Not a preference: the browser `WebSocket` constructor takes a URL and protocols, and provides no
 * way to set an `Authorization` header on the upgrade. Studio therefore sends `?token=`, and this
 * accepts a bearer header too so that non-browser clients and `curl` have the ordinary path.
 *
 * The cost is that the token lands in any URL the server logs. Access logging here is deliberately
 * on the frame, never the raw URL, and the deployment terminates TLS — but this is why the token is
 * an ACCESS token with a 15-minute life and never the refresh token.
 */
function tokenOf(req: FastifyRequest): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const bearer = BEARER.exec(auth)?.[1];
    if (bearer) return bearer;
  }
  const query = req.query as { token?: unknown } | undefined;
  return typeof query?.token === 'string' && query.token !== '' ? query.token : undefined;
}

export async function buildWebsocketApp(options: WebsocketAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const health = options.health ?? new HealthRegistry();
  const metrics = options.metrics ?? new MetricRegistry();
  const signals = goldenSignals(metrics, 'websocket');
  const { registry } = options;

  const connections = metrics.gauge({
    name: 'atlas_ws_connections',
    help: 'Currently open WebSocket connections on this node.',
    labelNames: ['service'],
  });
  const subscribes = metrics.counter({
    name: 'atlas_ws_subscribes_total',
    help: 'Subscription attempts, by outcome.',
    labelNames: ['service', 'outcome'],
  });
  const refusals = metrics.counter({
    name: 'atlas_ws_upgrades_refused_total',
    help: 'Upgrade attempts refused before the socket opened, by reason.',
    labelNames: ['service', 'reason'],
  });

  await app.register(websocketPlugin);

  app.addHook('onRequest', async (req) => {
    req.correlationId =
      typeof req.headers['x-correlation-id'] === 'string'
        ? req.headers['x-correlation-id']
        : randomUUID();
    req.startedAt = Date.now();
    req.inFlight = true;
    signals.enter();
  });

  app.addHook('onResponse', async (req, reply) => {
    if (req.inFlight) {
      req.inFlight = false;
      signals.exit();
    }
    signals.observe({
      method: req.method,
      route: req.routeOptions.url ?? 'unmatched',
      status: reply.statusCode,
      duration: (Date.now() - req.startedAt) / 1000,
    });
  });

  /**
   * Close out an upgraded request's HTTP accounting.
   *
   * An upgrade produces no response, so `onResponse` never fires for it — leave it and the
   * in-flight gauge climbs by one per connection and never comes down, which reads on a dashboard
   * as permanent load. That is the exact failure `goldenSignals` warns about in its own comment.
   *
   * The upgrade is counted as finished the moment the socket opens, because that is when the HTTP
   * transaction really is over. How many sockets are then held open is a different question, and
   * `atlas_ws_connections` is the metric that answers it.
   */
  const settleUpgrade = (req: FastifyRequest): void => {
    if (!req.inFlight) return;
    req.inFlight = false;
    signals.exit();
    signals.observe({
      method: req.method,
      route: '/ws',
      status: 101,
      duration: (Date.now() - req.startedAt) / 1000,
    });
  };

  app.setErrorHandler((err: unknown, req, reply) => {
    const status = (err as { status?: number }).status ?? 500;
    // Logged HERE, where it is raised, with the correlation id the caller was given. A 500 is
    // deliberately opaque to the caller, which makes it invisible to the operator too unless the
    // service says so itself.
    if (status >= 500) options.onError?.(err, { correlationId: req.correlationId, url: req.url });
    const message = status >= 500 ? 'Internal error' : ((err as Error).message ?? 'Error');
    return reply.code(status).send({ error: message });
  });

  app.get('/metrics', async (_req, reply) =>
    reply.header('content-type', metrics.contentType).send(metrics.expose()),
  );
  app.get('/healthz', async () => health.liveness());
  app.get('/readyz', async (_req, reply) => {
    const report = await health.readiness();
    return reply.code(report.status === 'ready' ? 200 : 503).send(report);
  });

  // Internal, per websocket.yaml. Not a user surface: it reports this NODE's counts, and with more
  // than one replica the number an operator wants is the sum across pods, which is what /metrics
  // gives Prometheus.
  app.get('/ws/stats', async () => registry.stats());

  app.get(
    '/ws',
    {
      websocket: true,
      /**
       * Authenticate BEFORE the upgrade, so a bad token is an HTTP 401 the client can read.
       *
       * Upgrading first and then closing with a status code is the common shape and it is worse:
       * the browser surfaces a closed socket with no body, so a client cannot distinguish "your
       * token expired" from "the service is down" — and Studio's reconnect loop would treat a
       * permanent auth failure as a transient outage and back off against it forever.
       */
      preValidation: async (req, reply) => {
        const token = tokenOf(req);
        let claims: Claims;
        try {
          if (!token) throw new Unauthorized('missing access token');
          claims = await verifyJwt(token, options.jwks, {
            ...(options.issuer !== undefined ? { issuer: options.issuer } : {}),
            ...(options.audience !== undefined ? { audience: options.audience } : {}),
          });
        } catch {
          refusals.inc({ service: 'websocket', reason: 'token' });
          return reply.code(401).send({ error: 'invalid or missing access token' });
        }

        // Both are required, and neither is defaulted. A connection without a channel cannot be
        // channel-scoped, and every subject on this platform is channel-scoped.
        if (typeof claims.sub !== 'string' || typeof claims.channelId !== 'string') {
          refusals.inc({ service: 'websocket', reason: 'claims' });
          return reply.code(401).send({ error: 'token carries no subject or channel' });
        }

        const policy = await options.policyFor(claims.sub);
        if (!policy) {
          // Fails closed. An unreachable IAM refuses connections rather than admitting one whose
          // rules nobody could establish — `can()` is lenient, so "no rules" degrades to "any" the
          // moment an incomplete context meets it.
          refusals.inc({ service: 'websocket', reason: 'policy' });
          options.onConnectionLog?.({
            event: 'refused',
            connectionId: '-',
            userId: claims.sub,
            reason: 'no policy',
          });
          return reply.code(401).send({ error: 'could not establish permissions' });
        }

        req.claims = claims;
        req.policy = policy;
        return undefined;
      },
    },
    (socket, req) => {
      // preValidation replied on every path that leaves these unset, so the socket cannot open
      // without them. The assertion documents that rather than re-deriving it.
      const claims = req.claims as Claims & { sub: string; channelId: string };
      const policy = req.policy as EffectivePolicy;
      settleUpgrade(req);

      const connection: Connection = {
        id: randomUUID(),
        userId: claims.sub,
        channelId: claims.channelId,
        policy,
        send: (frame: ServerFrame) => {
          // OPEN only. A frame written to a CLOSING socket throws, and the throw would propagate
          // out of registry.publish() and abort the fan-out to every connection after this one —
          // one disconnecting client silencing everybody else.
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
        },
        close: (reason: string) => socket.close(1000, reason),
      };

      registry.add(connection);
      connections.set({ service: 'websocket' }, registry.stats().connections);
      options.onConnectionLog?.({
        event: 'connected',
        connectionId: connection.id,
        userId: connection.userId,
        channelId: connection.channelId,
      });

      let alive = true;
      socket.on('pong', () => {
        alive = true;
      });

      socket.on('message', (raw: unknown) => {
        let frame: ClientFrame;
        try {
          frame = JSON.parse(String(raw)) as ClientFrame;
        } catch {
          connection.send({ type: 'error', message: 'frame is not valid JSON' });
          return;
        }

        if (typeof frame.pattern !== 'string' || frame.pattern === '') {
          connection.send({ type: 'error', message: 'frame has no pattern' });
          return;
        }

        if (frame.type === 'subscribe') {
          // The registry sends the `subscribed` or `error` frame itself and re-checks eligibility
          // per message later — this is the early refusal, never the boundary.
          const result = registry.subscribe(connection.id, frame.pattern);
          subscribes.inc({ service: 'websocket', outcome: result.ok ? 'ok' : 'refused' });
          options.onConnectionLog?.({
            event: result.ok ? 'subscribed' : 'refused',
            connectionId: connection.id,
            userId: connection.userId,
            pattern: frame.pattern,
            ...(result.reason !== undefined ? { reason: result.reason } : {}),
          });
        } else if (frame.type === 'unsubscribe') {
          registry.unsubscribe(connection.id, frame.pattern);
        } else {
          // Named rather than ignored: `resume` is in the spec and is not built, and a client that
          // sends it must find out now rather than infer it from a gap that never gets replayed.
          connection.send({
            type: 'error',
            message: `unsupported frame type "${String(frame.type)}"`,
          });
        }
      });

      socket.on('close', () => {
        registry.remove(connection.id);
        connections.set({ service: 'websocket' }, registry.stats().connections);
        options.onConnectionLog?.({
          event: 'disconnected',
          connectionId: connection.id,
          userId: connection.userId,
        });
      });

      const period = options.heartbeatIntervalMs ?? 30_000;
      if (period > 0) {
        const beat = setInterval(() => {
          if (!alive) {
            // `terminate`, not `close`: the point of failing a heartbeat is that the peer is not
            // answering, so waiting for a close handshake it will never complete just keeps the
            // socket around for another timeout.
            socket.terminate();
            return;
          }
          alive = false;
          socket.ping();
        }, period);
        // Never let the heartbeat hold the process open — a service whose only remaining work is
        // pinging sockets should still exit on SIGTERM.
        beat.unref?.();
        socket.on('close', () => clearInterval(beat));
      }
    },
  );

  return app;
}

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
    startedAt: number;
    inFlight?: boolean;
    claims?: Claims;
    policy?: EffectivePolicy;
  }
}
