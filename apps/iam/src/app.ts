// The HTTP surface. Thin: every decision lives in IamService, so the routes are transport only.
// Spec: docs/architecture/services/iam.md · contract: docs/architecture/openapi/iam.yaml

import Fastify, { type FastifyInstance } from 'fastify';
import {
  goldenSignals,
  isTraceable,
  HealthRegistry,
  Unauthorized,
  runWithContext,
  toProblem,
  type Span,
  type Tracer,
} from '@atlas/service-kit';
import { ulid } from '@atlas/contracts';
import type { IamService } from './service.ts';
import type { KeyRing } from './tokens.ts';

export interface IamAppOptions {
  service: IamService;
  keyRing: KeyRing;
  health?: HealthRegistry;
  /**
   * Tracer (EP-04.7). Omit and no spans are produced. Unlike the gateway, IAM **adopts** the
   * inbound `traceparent`: the caller is the gateway, which is trusted, and re-deciding sampling
   * here would leave holes in the middle of traces.
   */
  tracer?: Tracer;
}

interface Credentials {
  username?: string;
  password?: string;
}
interface RefreshBody {
  refreshToken?: string;
  allSessions?: boolean;
}

export function buildIamApp(options: IamAppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const { service, keyRing } = options;
  const health = options.health ?? new HealthRegistry();

  // The service's registry, not one of the app's own: IamService records the auth counters (#205)
  // and this route has to expose the SAME registry or half the signals would be unscrapeable.
  const metrics = service.metrics;
  const signals = goldenSignals(metrics, 'iam');

  app.addHook('onRequest', (req, _reply, done) => {
    const incoming = req.headers['x-correlation-id'];
    const correlationId = typeof incoming === 'string' && incoming ? incoming : ulid();
    req.correlationId = correlationId;
    req.startedAt = Date.now();
    req.inFlight = true;
    signals.enter();
    runWithContext({ correlationId }, () => {
      const route = (req as { routeOptions?: { url?: string } }).routeOptions?.url ?? req.url;
      // Probes and the scraper are not traced — see UNTRACED_ROUTES. Checked before the tracer so
      // an untraced request costs nothing at all, not even an id.
      if (!options.tracer || !isTraceable(route)) return done();
      // The span name is the route TEMPLATE, never the raw path — the same cardinality rule the
      // metrics follow.
      options.tracer.server(
        `${req.method} ${route}`,
        req.headers,
        {
          adoptRemote: true,
          attributes: { 'http.request.method': req.method, 'http.route': route },
        },
        (span) => {
          req.span = span;
          done();
        },
      );
    });
  });

  // Saturation is decremented from BOTH exits. A client that closes the connection mid-request
  // fires onRequestAbort and NOT onResponse, so counting only responses makes the gauge climb
  // forever — showing a service permanently saturated after any flaky network. The flag makes the
  // pair idempotent so a request can never be counted out twice either.
  const leave = (req: { inFlight?: boolean }): void => {
    if (req.inFlight !== true) return;
    req.inFlight = false;
    signals.exit();
  };
  app.addHook('onRequestAbort', (req, done) => {
    leave(req);
    done();
  });

  app.addHook('onResponse', (req, reply, done) => {
    leave(req);
    if (req.span) {
      req.span.setAttribute('http.response.status_code', reply.statusCode);
      // 5xx only: a 401 from an auth service is the system working, and marking it an error would
      // paint every failed login red in the trace UI.
      if (reply.statusCode >= 500) req.span.setError(`HTTP ${reply.statusCode}`);
      req.span.end();
    }
    // The route TEMPLATE. `req.url` would work for IAM's fixed paths today, but the moment a
    // `/users/:id` route lands it would mint a series per user — the cardinality bug arriving
    // through a route addition nobody connected to metrics.
    const template = (req as { routeOptions?: { url?: string } }).routeOptions?.url ?? req.url;
    signals.observe({
      method: req.method,
      route: template,
      status: reply.statusCode,
      duration: (Date.now() - req.startedAt) / 1000,
    });
    done();
  });

  // Unauthenticated, like the health endpoints: a scraper is infrastructure, not a user.
  //
  // Safe to publish because of what is NOT in here — auth-signals.ts keeps every label a closed
  // set, so this endpoint carries counts and route templates and no identity of any kind.
  app.get('/metrics', async (_req, reply) =>
    reply.header('content-type', metrics.contentType).send(metrics.expose()),
  );

  app.get('/healthz', async () => health.liveness());
  app.get('/readyz', async (_req, reply) => {
    const r = await health.readiness();
    return reply.code(r.status === 'ready' ? 200 : 503).send(r);
  });

  // Public: services fetch this to verify tokens locally, so it must never require a token.
  app.get('/.well-known/jwks.json', async (_req, reply) => {
    void reply.header('cache-control', 'public, max-age=300');
    return keyRing.jwks();
  });

  app.post('/auth/login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as Credentials;
    if (typeof username !== 'string' || typeof password !== 'string') {
      const p = toProblem(new Unauthorized('invalid username or password'), req.correlationId);
      return reply.code(p.status).send(p);
    }
    const forwarded = req.headers['x-forwarded-for'];
    const ua = req.headers['user-agent'];
    // Behind the gateway the client address is the first x-forwarded-for entry; fall back to
    // the socket address. Omit rather than pass undefined (exactOptionalPropertyTypes).
    const ip = typeof forwarded === 'string' ? (forwarded.split(',')[0]?.trim() ?? req.ip) : req.ip;
    try {
      return await service.login(username, password, {
        ...(ip !== undefined ? { ip } : {}),
        ...(typeof ua === 'string' ? { userAgent: ua } : {}),
      });
    } catch (err) {
      const p = toProblem(err, req.correlationId);
      return reply.code(p.status).send(p);
    }
  });

  app.post('/auth/refresh', async (req, reply) => {
    const { refreshToken } = (req.body ?? {}) as RefreshBody;
    if (typeof refreshToken !== 'string') {
      const p = toProblem(new Unauthorized('refreshToken is required'), req.correlationId);
      return reply.code(p.status).send(p);
    }
    try {
      return await service.refresh(refreshToken);
    } catch (err) {
      const p = toProblem(err, req.correlationId);
      return reply.code(p.status).send(p);
    }
  });

  app.post('/auth/logout', async (req, reply) => {
    const { refreshToken, allSessions } = (req.body ?? {}) as RefreshBody;
    if (typeof refreshToken === 'string') {
      service.logout(refreshToken, { ...(allSessions === true ? { allSessions: true } : {}) });
    }
    // Always 204: telling a caller whether the token existed is an oracle.
    return reply.code(204).send();
  });

  // The compiled policy. Identified by the gateway-established header, not by re-parsing a JWT.
  app.get('/api/v1/users/me/effective-permissions', async (req, reply) => {
    const userId = req.headers['x-atlas-user'];
    if (typeof userId !== 'string') {
      const p = toProblem(new Unauthorized('no authenticated subject'), req.correlationId);
      return reply.code(p.status).send(p);
    }
    try {
      const policy = service.effectivePolicy(userId);
      // Cached against permVersion by every consumer, so it must be revalidatable.
      void reply.header('etag', `W/"pv-${policy.permVersion}"`);
      return policy;
    } catch (err) {
      const p = toProblem(err, req.correlationId);
      return reply.code(p.status).send(p);
    }
  });

  app.setErrorHandler((err, req, reply) => {
    const p = toProblem(err, req.correlationId);
    void reply.code(p.status).send(p);
  });

  return app;
}

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
    startedAt: number;
    inFlight?: boolean;
    span?: Span;
  }
}
