// The gateway: authenticate once, establish correlation, proxy to the owning service with a
// signed internal identity header set, log access. No domain endpoints of its own.
//
// Spec: docs/architecture/services/api-gateway.md

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ulid } from '@atlas/contracts';
import {
  goldenSignals,
  HealthRegistry,
  MetricRegistry,
  runWithContext,
  toProblem,
  NotFound,
  Unauthorized,
  verifyJwt,
  type Claims,
} from '@atlas/service-kit';
import { matchRoute, defaultRoutes, type RoutingTable } from './routing.ts';

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
  path: string;
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
  /** Injected for testability; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const BEARER = /^Bearer (.+)$/i;

export function buildGateway(options: GatewayOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const routes = options.routes ?? defaultRoutes;
  const health = options.health ?? new HealthRegistry();
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const metrics = options.metrics ?? new MetricRegistry();
  const signals = goldenSignals(metrics, 'api-gateway');

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
    // Everything downstream of here — auth, proxy, error mapping — runs inside the context,
    // so a log line from any of them carries the same id without being passed one.
    runWithContext({ correlationId }, () => done());
  });

  app.addHook('onSend', (req, reply, payload, done) => {
    void reply.header(INTERNAL_HEADERS.correlation, req.correlationId);
    done(null, payload);
  });

  // --- access log: emitted for EVERY response, including 4xx/5xx --------------------------
  app.addHook('onResponse', (req, reply, done) => {
    options.onAccessLog?.({
      requestId: req.correlationId,
      method: req.method,
      path: req.url,
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

    const headers: Record<string, string> = {
      [INTERNAL_HEADERS.correlation]: req.correlationId,
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
    const problem = toProblem(err, req.correlationId);
    void reply.code(problem.status).send(problem);
  });

  return app;
}

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
    startedAt: number;
    claims?: Claims;
  }
}
