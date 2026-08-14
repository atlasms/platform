// The gateway: authenticate once, establish correlation, proxy to the owning service with a
// signed internal identity header set, log access. No domain endpoints of its own.
//
// Spec: docs/architecture/services/api-gateway.md

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ulid } from '@atlas/contracts';
import {
  goldenSignals,
  isTraceable,
  HealthRegistry,
  Internal,
  MetricRegistry,
  PayloadTooLarge,
  runWithContext,
  serveSnapshot,
  toProblem,
  NotFound,
  TooManyRequests,
  TRACEPARENT_HEADER,
  Unauthorized,
  verifyJwt,
  type Claims,
  type Span,
  type Tracer,
} from '@atlas/service-kit';
import { matchRoute, defaultRoutes, type RoutingTable } from './routing.ts';
import { aggregateReference, ReferenceUnavailable, type ReferenceSource } from './reference.ts';
import {
  clientAddress,
  RateLimiter,
  type RateLimitDecision,
  type RateLimitPolicy,
} from './rate-limit.ts';

/** Header names the gateway establishes and downstream services trust. */
export const INTERNAL_HEADERS = {
  user: 'x-atlas-user',
  channel: 'x-atlas-channel',
  scopes: 'x-atlas-scopes',
  permVersion: 'x-atlas-perm-version',
  correlation: 'x-correlation-id',
} as const;

export interface AccessLogRecord {
  requestId: string;
  method: string;
  /** What the client asked for, verbatim. The edge is the one place that is worth keeping. */
  path: string;
  /** The matched routing-table prefix — bounded, so it aggregates (#245). */
  route?: string;
  status: number;
  userId?: string;
  latencyMs: number;
  at: string;
}

export interface GatewayOptions {
  /** JWKS for local token verification — the gateway never calls IAM per request. */
  jwks: Parameters<typeof verifyJwt>[1];
  routes?: RoutingTable;
  issuer?: string;
  audience?: string;
  health?: HealthRegistry;
  /**
   * The lowest permission version still accepted. Any token below it is refused so a revoked
   * grant cannot outlive its access token (FR-IAM-8). Updated from `permissions.changed`.
   */
  minPermVersion?: number;
  /** Injected so tests stay headless; production ships these to the log pipeline. */
  onAccessLog?: (record: AccessLogRecord) => void;
  /**
   * Metric registry backing `/metrics` (EP-12.2). Omit and the gateway makes its own.
   *
   * Passing one in lets a deployment register additional metrics on the same registry, so a
   * single scrape covers the whole process.
   */
  metrics?: MetricRegistry;
  /**
   * Requests per window from one SOURCE ADDRESS (EP-08.3). Generous by design — see rate-limit.ts:
   * a broadcast facility shares one public address, so this bounds a building, not a person.
   */
  rateLimit?: RateLimitPolicy;
  /**
   * Requests per window from one authenticated SUBJECT — the "per-principal quota" of §10. This
   * one really is per person, so it can be tighter than the address limit.
   */
  principalRateLimit?: RateLimitPolicy;
  /**
   * Honour `x-forwarded-for` when choosing the rate-limit key. **Off by default, deliberately** —
   * see {@link clientAddress}. Turn it on only when a proxy that OVERWRITES the header is in front.
   */
  trustProxy?: boolean;
  /** Largest request body accepted, in bytes (§10 "request/body size caps"). */
  bodyLimit?: number;
  /**
   * Tracer (EP-04.7). Omit and no spans are produced at all — tracing is opt-in per deployment.
   *
   * The gateway **starts** the trace rather than adopting an inbound one
   * ([api-gateway.md §12](../../../docs/architecture/services/api-gateway.md)), which is also what
   * stops a public client pinning every request to one trace id or forcing the sampled flag.
   */
  tracer?: Tracer;
  /**
   * Services that own reference data, aggregated by `GET /api/v1/reference` (EP-08.5).
   *
   * Omit and the route is not registered at all — a gateway with nothing to aggregate should 404
   * rather than serve an empty snapshot that looks like "there is no reference data".
   */
  referenceSources?: readonly ReferenceSource[];
  /** Injected for testability; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const BEARER = /^Bearer (.+)$/i;

/**
 * 600 per minute per source address, 300 per subject.
 *
 * The address figure is sized for a FACILITY behind one NAT — a gallery of editors during a busy
 * hour — not for one browser, because that is what a source address means in this product. It stops
 * a runaway client or a crude flood; it is not tuned to stop credential guessing, which #240 does
 * where the key is the account rather than the building.
 */
const DEFAULT_ADDRESS_LIMIT: RateLimitPolicy = { limit: 600, windowMs: 60_000 };
const DEFAULT_PRINCIPAL_LIMIT: RateLimitPolicy = { limit: 300, windowMs: 60_000 };

/** Fastify's own default, restated so the value is visible rather than inherited silently. */
const DEFAULT_BODY_LIMIT = 1024 * 1024;

export function buildGateway(options: GatewayOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: options.bodyLimit ?? DEFAULT_BODY_LIMIT });
  const routes = options.routes ?? defaultRoutes;
  const health = options.health ?? new HealthRegistry();
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const metrics = options.metrics ?? new MetricRegistry();
  const signals = goldenSignals(metrics, 'api-gateway');

  // §12 names "rate-limit rejections" as a gateway signal. `scope` says WHICH limit fired, because
  // "one user is greedy" and "one address is flooding" call for different responses.
  const rejections = metrics.counter({
    name: 'atlas_gateway_rate_limited_total',
    help: 'Requests refused with 429, by which limit rejected them.',
    labelNames: ['scope'],
  });

  // Counted, not ignored: fail-open means the limiter stops limiting new keys under pressure, and
  // that must be visible or the protection can be absent while every dashboard looks healthy.
  const untracked = metrics.counter({
    name: 'atlas_gateway_rate_limit_untracked_total',
    help: 'Requests allowed because the limiter was at its key cap and failed open.',
    labelNames: ['scope'],
  });

  const addressLimiter = new RateLimiter(options.rateLimit ?? DEFAULT_ADDRESS_LIMIT);
  const principalLimiter = new RateLimiter(options.principalRateLimit ?? DEFAULT_PRINCIPAL_LIMIT);
  // One limiter per route that overrides the default, built once rather than per request.
  const routeLimiters = new Map<string, RateLimiter>(
    routes
      .filter((r) => r.rateLimit !== undefined)
      .map((r) => [r.prefix, new RateLimiter(r.rateLimit as RateLimitPolicy)]),
  );

  /** Apply one decision to the reply. Returns true when the request was refused. */
  const refuse = (
    decision: RateLimitDecision,
    scope: 'address' | 'principal',
    req: FastifyRequest,
    reply: FastifyReply,
  ): boolean => {
    if (decision.untracked === true) untracked.inc({ scope });
    if (decision.allowed) return false;

    rejections.inc({ scope });
    const problem = toProblem(
      new TooManyRequests(`rate limit exceeded (${scope})`),
      req.correlationId,
    );
    // Seconds, and at least 1: `Retry-After: 0` is an invitation to spin.
    void reply.header('retry-after', String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))));
    void reply.code(problem.status).send(problem);
    return true;
  };

  // The gateway does not parse request bodies — it forwards BYTES.
  //
  // Fastify's default JSON parser rejects an empty body outright, and a lifecycle transition
  // legitimately has nothing to say: `POST /assets/{id}/approve` with `content-type: application/
  // json` and no body is what every generated client sends. That surfaced as a 500 from the
  // gateway before the request ever reached the owning service.
  //
  // Parsing was wrong for two more reasons. It re-serializes, so what the upstream receives is not
  // byte-identical to what the client sent — fatal for a signature or a checksum. And it rejects
  // anything that is not JSON, which is every file upload the platform will ever carry.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  // --- correlation: issue or adopt, for every request including failures ------------------
  app.addHook('onRequest', (req, _reply, done) => {
    const incoming = req.headers[INTERNAL_HEADERS.correlation];
    const correlationId = typeof incoming === 'string' && incoming ? incoming : ulid();
    req.correlationId = correlationId;
    req.startedAt = Date.now();
    req.inFlight = true;
    signals.enter();
    // Everything downstream of here — auth, proxy, error mapping — runs inside the context,
    // so a log line from any of them carries the same id without being passed one.
    runWithContext({ correlationId }, () => {
      const route = (req as { routeOptions?: { url?: string } }).routeOptions?.url ?? req.url;
      // Probes and the scraper are not traced — see UNTRACED_ROUTES. Checked before the tracer so
      // an untraced request costs nothing at all, not even an id.
      if (!options.tracer || !isTraceable(route)) return done();
      // The span name is the route TEMPLATE, never the raw path: `GET /api/v1/assets/01H2XK…`
      // would be one distinct operation per asset in every trace UI — the cardinality trap that
      // ruins metrics, wearing a different hat.
      options.tracer.server(
        `${req.method} ${route}`,
        req.headers,
        {
          adoptRemote: false,
          attributes: { 'http.request.method': req.method, 'http.route': route },
        },
        (span) => {
          req.span = span;
          done();
        },
      );
    });
  });

  // Saturation is decremented from BOTH exits: a client that closes the connection mid-request
  // fires onRequestAbort and NOT onResponse, so counting only responses makes the gauge climb
  // forever. It matters most here — the gateway holds a request open for the whole upstream call,
  // so in-flight IS the queue depth an operator watches. The flag keeps the pair idempotent.
  const leave = (req: { inFlight?: boolean }): void => {
    if (req.inFlight !== true) return;
    req.inFlight = false;
    signals.exit();
  };
  app.addHook('onRequestAbort', (req, done) => {
    leave(req);
    done();
  });

  app.addHook('onSend', (req, reply, payload, done) => {
    void reply.header(INTERNAL_HEADERS.correlation, req.correlationId);
    done(null, payload);
  });

  // --- access log: emitted for EVERY response, including 4xx/5xx --------------------------
  app.addHook('onResponse', (req, reply, done) => {
    leave(req);
    if (req.span) {
      req.span.setAttribute('http.response.status_code', reply.statusCode);
      // 5xx only. A 404 or a 401 is the system working — marking those as span errors would paint
      // every trace red and make a real failure indistinguishable from a typo in a URL.
      if (reply.statusCode >= 500) req.span.setError(`HTTP ${reply.statusCode}`);
      req.span.end();
    }
    options.onAccessLog?.({
      requestId: req.correlationId,
      method: req.method,
      // The RAW path, and here that is right: the gateway is the edge, and what the outside world
      // actually asked for is the thing an operator wants when reading the edge log.
      path: req.url,
      // The matched ROUTE as well (#245), so the gateway's records aggregate alongside every other
      // service's. Fastify's own template is the catch-all `/*` for everything proxied, so the
      // useful bounded value is the routing table's prefix — which `req.matchedRoute` records once
      // the table has matched.
      ...(req.matchedRoute !== undefined ? { route: req.matchedRoute } : {}),
      status: reply.statusCode,
      ...(req.claims?.sub !== undefined ? { userId: req.claims.sub } : {}),
      latencyMs: Date.now() - req.startedAt,
      at: new Date().toISOString(),
    });

    // Golden signals off the same hook as the access log, so a request can never be logged but
    // not counted. `routerPath` is Fastify's route TEMPLATE — using req.url instead would put a
    // ULID in a label and mint a time series per asset (EP-12.2).
    const template = (req as { routeOptions?: { url?: string } }).routeOptions?.url ?? req.url;
    signals.observe({
      method: req.method,
      route: template,
      status: reply.statusCode,
      duration: (Date.now() - req.startedAt) / 1000,
    });
    done();
  });

  // --- health: never authenticated, the orchestrator must reach them ----------------------
  // Unauthenticated, like the health endpoints: a scraper is infrastructure, not a user, and
  // metrics carry no tenant data — only route templates, methods and status classes.
  app.get('/metrics', async (_req, reply) =>
    reply.header('content-type', metrics.contentType).send(metrics.expose()),
  );

  app.get('/healthz', async () => health.liveness());
  app.get('/readyz', async (_req, reply) => {
    const r = await health.readiness();
    return reply.code(r.status === 'ready' ? 200 : 503).send(r);
  });

  // --- the aggregated reference snapshot (EP-08.5) ---------------------------------------
  //
  // The ONE path the gateway answers itself rather than proxying, and it earns the exception: the
  // aggregate does not exist in any single service, so there is nothing to forward it to. Declared
  // before the catch-all because Fastify matches a literal path ahead of a wildcard.
  if (options.referenceSources && options.referenceSources.length > 0) {
    const sources = options.referenceSources;
    app.get('/api/v1/reference', async (req, reply) => {
      // Authentication happens here as it does for any protected route — the aggregate is a
      // channel's vocabulary, not public data — and the established identity is forwarded so each
      // upstream applies its OWN authorization. The gateway does not decide who may read MAM's
      // tags; MAM does.
      let claims: Claims;
      try {
        const auth = req.headers.authorization;
        const token = typeof auth === 'string' ? BEARER.exec(auth)?.[1] : undefined;
        if (!token) throw new Unauthorized('missing bearer token');
        claims = await verifyJwt(token, options.jwks, {
          ...(options.issuer !== undefined ? { issuer: options.issuer } : {}),
          ...(options.audience !== undefined ? { audience: options.audience } : {}),
        });
      } catch (err) {
        const problem = toProblem(err, req.correlationId);
        return reply.code(problem.status).send(problem);
      }

      const headers: Record<string, string> = {
        [INTERNAL_HEADERS.correlation]: req.correlationId,
        ...(req.span ? { [TRACEPARENT_HEADER]: req.span.traceparent() } : {}),
        ...(claims.sub !== undefined ? { [INTERNAL_HEADERS.user]: claims.sub } : {}),
        ...(claims.channelId !== undefined ? { [INTERNAL_HEADERS.channel]: claims.channelId } : {}),
        ...(claims.permissions !== undefined
          ? { [INTERNAL_HEADERS.scopes]: claims.permissions.join(' ') }
          : {}),
      };

      try {
        const snapshot = await aggregateReference({
          sources,
          headers,
          ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
        });
        const result = serveSnapshot(snapshot, req.headers['if-none-match']);
        void reply.header('etag', result.etag);
        if (result.status === 304) return reply.code(304).send();
        return result.body;
      } catch (err) {
        if (err instanceof ReferenceUnavailable) {
          // 503, not a partial snapshot. See ReferenceUnavailable — a client cannot tell an
          // incomplete snapshot from a complete one, but it can tell a failure, and its own client
          // keeps the last good one. Failing hands the situation to the component equipped for it.
          const problem = toProblem(new Internal(err.message), req.correlationId);
          return reply.code(503).send({ ...problem, status: 503 });
        }
        throw err;
      }
    });
  }

  // --- everything else is proxied --------------------------------------------------------
  app.all('/*', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    const route = matchRoute(routes, path);

    if (!route) {
      // A real AppError, not a hand-rolled shape: toProblem only maps the taxonomy, so a plain
      // object would silently come back as INTERNAL/500.
      const problem = toProblem(new NotFound(`no route for ${path}`), req.correlationId);
      return reply.code(problem.status).send(problem);
    }

    // ADDRESS limit first, BEFORE authentication. After would mean an unlimited supply of requests
    // carrying a garbage token — each one costing a signature verification — never reaches a limit,
    // which is the cheapest denial of service available against a JWT gateway.
    const limiter = routeLimiters.get(route.prefix) ?? addressLimiter;
    if (
      refuse(limiter.check(clientAddress(req, options.trustProxy === true)), 'address', req, reply)
    ) {
      return reply;
    }

    // Now that routing has decided, the span can say what this request actually is. Named after
    // the matched PREFIX and the owning service — bounded by the routing table, which is exactly
    // the property a span name needs, and readable as "which service did this go to".
    req.span?.setName(`${req.method} ${route.prefix} → ${route.service}`);
    req.span?.setAttribute('atlas.upstream', route.service);
    req.matchedRoute = route.prefix;

    const headers: Record<string, string> = {
      [INTERNAL_HEADERS.correlation]: req.correlationId,
      // The hop that makes this a DISTRIBUTED trace rather than a per-service one. Carries this
      // span's id, so the upstream becomes our child rather than a sibling.
      ...(req.span ? { [TRACEPARENT_HEADER]: req.span.traceparent() } : {}),
    };

    if (!route.public) {
      let claims: Claims;
      try {
        const auth = req.headers.authorization;
        const token = typeof auth === 'string' ? BEARER.exec(auth)?.[1] : undefined;
        if (!token) throw new Unauthorized('missing bearer token');

        claims = await verifyJwt(token, options.jwks, {
          ...(options.issuer !== undefined ? { issuer: options.issuer } : {}),
          ...(options.audience !== undefined ? { audience: options.audience } : {}),
        });

        // Stale-permission rejection. The gateway does NOT make resource decisions — the owning
        // service does that with the full context — but a token whose grants have since been
        // revoked must not get through at all.
        if (
          options.minPermVersion !== undefined &&
          (claims.permVersion ?? 0) < options.minPermVersion
        ) {
          throw new Unauthorized('stale permission version; refresh your token');
        }
      } catch (err) {
        const problem = toProblem(err, req.correlationId);
        return reply.code(problem.status).send(problem);
      }

      req.claims = claims;

      // PRINCIPAL quota (§10). Only now is there a principal to key on, and only a verified one —
      // keying on an unverified `sub` would let a client pick its own quota bucket.
      if (claims.sub !== undefined) {
        if (refuse(principalLimiter.check(claims.sub), 'principal', req, reply)) return reply;
      }

      if (claims.sub !== undefined) headers[INTERNAL_HEADERS.user] = claims.sub;
      if (claims.channelId !== undefined) headers[INTERNAL_HEADERS.channel] = claims.channelId;
      if (claims.permissions !== undefined) {
        headers[INTERNAL_HEADERS.scopes] = claims.permissions.join(' ');
      }
      if (claims.permVersion !== undefined) {
        headers[INTERNAL_HEADERS.permVersion] = String(claims.permVersion);
      }
    }

    // Forward only what the upstream needs. Notably NOT `authorization`: downstream services
    // trust the internal header set the gateway establishes rather than re-parsing the JWT.
    for (const h of ['content-type', 'accept', 'if-none-match']) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }

    // A Buffer, thanks to the catch-all parser above. Forwarded verbatim; an EMPTY one is omitted
    // rather than sent, since a zero-length body with a JSON content type is what the upstream's
    // own parser would then have to special-case.
    const raw = req.body as Buffer | undefined;
    const hasBody =
      req.method !== 'GET' && req.method !== 'HEAD' && raw !== undefined && raw.length > 0;

    try {
      const upstream = await doFetch(route.origin + req.url, {
        method: req.method,
        headers,
        ...(hasBody ? { body: raw } : {}),
      });

      const body = await upstream.text();
      void reply.code(upstream.status);
      const ct = upstream.headers.get('content-type');
      if (ct !== null) void reply.header('content-type', ct);
      return reply.send(body);
    } catch {
      // An unreachable upstream is a gateway problem, not a mystery 500 from Fastify.
      return reply.code(502).send({
        code: 'INTERNAL',
        status: 502,
        message: `upstream "${route.service}" unreachable`,
        correlationId: req.correlationId,
      });
    }
  });

  app.setErrorHandler((err, req: FastifyRequest, reply: FastifyReply) => {
    // Fastify enforces the body cap itself and raises FST_ERR_CTP_BODY_TOO_LARGE with a 413, but
    // `toProblem` only knows the Atlas taxonomy and maps anything else to INTERNAL/500. So an
    // oversized upload told the caller the SERVER had failed, and put a 5xx on the error-rate
    // dashboard for what is squarely a client error. Translated at the one place that sees it.
    const mapped =
      (err as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE'
        ? new PayloadTooLarge()
        : err;
    const problem = toProblem(mapped, req.correlationId);
    void reply.code(problem.status).send(problem);
  });

  return app;
}

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
    startedAt: number;
    inFlight?: boolean;
    span?: Span;
    matchedRoute?: string;
    claims?: Claims;
  }
}
