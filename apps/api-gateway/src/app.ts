// The gateway: authenticate once, establish correlation, proxy to the owning service with a
// signed internal identity header set, log access. No domain endpoints of its own.
//
// Spec: docs/architecture/services/api-gateway.md

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ulid } from '@atlas/contracts';
import {
  HealthRegistry,
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
  /** Injected for testability; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const BEARER = /^Bearer (.+)$/i;

export function buildGateway(options: GatewayOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const routes = options.routes ?? defaultRoutes;
  const health = options.health ?? new HealthRegistry();
  const doFetch = options.fetchImpl ?? globalThis.fetch;

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
    done();
  });

  // --- health: never authenticated, the orchestrator must reach them ----------------------
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

    try {
      const upstream = await doFetch(route.origin + req.url, {
        method: req.method,
        headers,
        ...(req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined
          ? { body: JSON.stringify(req.body) }
          : {}),
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
