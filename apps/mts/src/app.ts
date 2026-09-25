// The Mts service's HTTP surface.
//
// `buildMtsApp` builds the Fastify app with everything injected — no globals, no
// environment — so a test constructs one in memory and drives it with `app.inject()`. `main.ts` is
// the only place that reads config and talks to real infrastructure.
//
// What is here is the shape every Atlas service shares (generated from it, and kept to it by the
// same tests). What a service DOES goes in `service.ts` and its routes below the marker.

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { isUlid, ulid } from '@atlas/contracts';
import type { EffectivePolicy } from '@atlas/policy';
import type { ProfileInput } from './profile.ts';
import type { MtsService } from './service.ts';
import {
  accessRecord,
  goldenSignals,
  isTraceable,
  HealthRegistry,
  MetricRegistry,
  runWithContext,
  shouldLogAccess,
  PROBLEM_CONTENT_TYPE,
  toProblem,
  Unauthorized,
  ValidationError,
  type AccessLogPolicy,
  type AccessRecord,
  type Span,
  type Tracer,
} from '@atlas/service-kit';

export interface MtsAppOptions {
  service: MtsService;
  /** Resolves the caller's compiled policy — `PolicyClient` against IAM in production. */
  policyFor: (userId: string) => Promise<EffectivePolicy | undefined> | EffectivePolicy | undefined;
  /** Liveness and readiness. `main.ts` registers the real dependency checks. */
  health?: HealthRegistry;
  /** Shared with `main.ts` so every counter lands in one /metrics exposition. */
  metrics?: MetricRegistry;
  /** Omit and requests are not traced. When present, each request is a server span. */
  tracer?: Tracer;
  /** One line per request worth logging (#245). Injected so tests stay headless. */
  onAccessLog?: (record: AccessRecord) => void;
  accessLogPolicy?: AccessLogPolicy;
  /** Every 5xx, where it is raised, with the correlation id the caller was given. */
  onError?: (err: unknown, context: { correlationId: string; url: string }) => void;
}

/** Header names the gateway establishes and this service trusts. It never sees a token. */
export const INTERNAL_HEADERS = {
  user: 'x-atlas-user',
  channel: 'x-atlas-channel',
  scopes: 'x-atlas-scopes',
  permVersion: 'x-atlas-perm-version',
  correlation: 'x-correlation-id',
} as const;

/**
 * The caller, as the gateway established them.
 *
 * Both headers are required and neither is defaulted: every row and every message on this
 * platform is channel-scoped (AGENTS.md §5.3), so a request without a channel cannot be served.
 * The gateway strips these from client requests and sets them from verified claims — a request
 * that reaches this service without them did not come through the gateway, and is refused.
 */
export interface Caller {
  userId: string;
  channelId: string;
}

export function callerOf(headers: Record<string, string | string[] | undefined>): Caller {
  const userId = headers[INTERNAL_HEADERS.user];
  const channelId = headers[INTERNAL_HEADERS.channel];
  if (typeof userId !== 'string' || typeof channelId !== 'string') {
    throw new Unauthorized(
      'no authenticated caller — requests reach this service through the gateway',
    );
  }
  return { userId, channelId };
}

export async function buildMtsApp(options: MtsAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const health = options.health ?? new HealthRegistry();
  const metrics = options.metrics ?? new MetricRegistry();
  const signals = goldenSignals(metrics, 'mts');

  // An EMPTY body with a JSON content type is `undefined`, not an error. Fastify's default parser
  // refuses it (FST_ERR_CTP_EMPTY_JSON_BODY), which turned every `DELETE` and every body-less
  // `POST /…/approve` sent with `content-type: application/json` into a 500 — a client that sets
  // the header by default (most do) hit it on the first action with no body. The gateway strips an
  // empty body before proxying, which is why this only shows up on a direct call — and in tests.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '' || body === undefined) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // --- correlation + tracing: issue or adopt, for every request including failures ---------------
  app.addHook('onRequest', (req, _reply, done) => {
    // A ULID, adopted only when the caller sent a well-formed one. Behind the gateway that caller
    // is the gateway, which already applied this rule (#306); applying it again here costs nothing
    // and means a direct call cannot put an arbitrary string into every log line of the request.
    const incoming = req.headers[INTERNAL_HEADERS.correlation];
    req.correlationId = typeof incoming === 'string' && isUlid(incoming) ? incoming : ulid();
    req.startedAt = Date.now();
    req.inFlight = true;
    signals.enter();
    // Everything downstream runs inside the context, so a log line from any handler carries the
    // same id without being passed one — the service-kit logger reads it.
    runWithContext({ correlationId: req.correlationId }, () => {
      const route = (req as { routeOptions?: { url?: string } }).routeOptions?.url ?? req.url;
      // Probes and the scraper are not traced — see UNTRACED_ROUTES. Checked before the tracer so
      // an untraced request costs nothing at all, not even an id.
      if (!options.tracer || !isTraceable(route)) return done();
      // The span name is the route TEMPLATE, never the raw path: `GET /x/01H2XK…` would be one
      // distinct operation per id in every trace UI — the cardinality trap, wearing a different hat.
      options.tracer.server(
        `${req.method} ${route}`,
        req.headers,
        {
          // Behind the gateway: continue the trace the gateway started rather than opening a new one.
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

  // Saturation is decremented from BOTH exits: a client that closes the connection mid-request
  // fires onRequestAbort and NOT onResponse, so counting only responses makes the gauge climb
  // forever. The flag keeps the pair idempotent.
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
      // 5xx only: a 403 or a 404 is the system working as designed.
      if (reply.statusCode >= 500) req.span.setError(`HTTP ${reply.statusCode}`);
      req.span.end();
    }
    const template = (req as { routeOptions?: { url?: string } }).routeOptions?.url ?? req.url;
    signals.observe({
      method: req.method,
      route: template,
      status: reply.statusCode,
      duration: (Date.now() - req.startedAt) / 1000,
    });

    // The access record (#245). Probes and the scraper are excluded for the same reason they are
    // not traced; and the POLICY decides what is worth a line — every non-2xx, every slow request,
    // and a sample of the rest, default 0, because the golden signals already describe a fast 200.
    if (options.onAccessLog && isTraceable(template)) {
      const latencyMs = Date.now() - req.startedAt;
      if (shouldLogAccess({ status: reply.statusCode, latencyMs }, options.accessLogPolicy)) {
        const userId = req.headers[INTERNAL_HEADERS.user];
        options.onAccessLog(
          accessRecord({
            requestId: req.correlationId,
            method: req.method,
            // The TEMPLATE, never req.url — a ULID in a log field is the Loki version of the
            // cardinality trap, and it makes "how slow is GET /x/:id" unanswerable.
            route: template,
            status: reply.statusCode,
            latencyMs,
            ...(typeof userId === 'string' ? { userId } : {}),
            ...(req.span ? { traceId: req.span.traceId } : {}),
          }),
        );
      }
    }
    done();
  });

  // --- errors: one document, and every 5xx logged where it is raised ------------------------------
  app.setErrorHandler((err: unknown, req, reply) => {
    // The platform's problem document — `{ code, status, message, correlationId }` — mapped by the
    // one function every service uses (@atlas/service-kit errors.ts).
    const problem = toProblem(err, req.correlationId);
    // 5xx only. A 404 or a 409 is the service saying no correctly; logging those at error level
    // trains everyone to ignore the error log. A 500 is deliberately opaque to the caller, which
    // makes it invisible to the operator too unless the service says so itself, here.
    if (problem.status >= 500) {
      options.onError?.(err, { correlationId: req.correlationId, url: req.url });
    }
    return reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
  });

  // --- probes and the scraper -----------------------------------------------------------------------
  app.get('/metrics', async (_req, reply) =>
    reply.header('content-type', metrics.contentType).send(metrics.expose()),
  );
  // Liveness: is the process wedged. No dependencies, or a dependency outage becomes a restart loop.
  app.get('/healthz', async () => health.liveness());
  // Readiness: should traffic come here. This one DOES ask the dependencies.
  app.get('/readyz', async (_req, reply) => {
    const report = await health.readiness();
    return reply.code(report.status === 'ready' ? 200 : 503).send(report);
  });

  // --- routes ------------------------------------------------------------------------------------------
  //
  // Contracts first (AGENTS.md §5.1): the OpenAPI stub in docs/architecture/openapi/mts.yaml
  // is written BEFORE or WITH the route, and `npm run api:types` projects it for Studio. Every
  // handler `return await`s its work inside the try (a returned promise settles after the catch is
  // out of scope, so its rejection would escape the problem document — AGENTS.md §6).

  /**
   * The caller, their policy, and the correlation id this request already carries.
   *
   * A policy that cannot be established is 401, not an empty policy: "we could not determine your
   * permissions" must never degrade into "you have none, carry on" — the same rule MAM's is.
   */
  const caller = async (req: FastifyRequest) => {
    const who = callerOf(req.headers);
    const policy = await options.policyFor(who.userId);
    if (!policy) throw new Unauthorized('no policy for subject');
    return { ...who, policy, correlationId: req.correlationId };
  };

  /**
   * Enqueue a transcode.
   *
   * **202, not 201**: the job is accepted, not done — mts.yaml says so, and it is the honest
   * status for work that a worker will pick up in a moment. The body is the job, so the caller
   * has the id to poll without a second request.
   *
   * Normally a command over the broker from BMS/RIM (`transcode.job.create`); this is the same
   * enqueue for an operator, a tool, or the smoke suite.
   */
  app.post('/api/v1/jobs', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const presetIds = body['presetIds'];
    const job = await options.service.enqueue(await caller(req), {
      assetId: str(body['assetId'], 'assetId'),
      inputPath: str(body['inputPath'], 'inputPath'),
      presetIds: Array.isArray(presetIds) ? presetIds.map((p, i) => str(p, `presetIds[${i}]`)) : [],
      ...(typeof body['priority'] === 'number' ? { priority: body['priority'] } : {}),
    });
    return reply.code(202).send(job);
  });

  /** One job: its state, its progress and — once it has them — its renditions. */
  app.get<{ Params: { id: string } }>('/api/v1/jobs/:id', async (req) =>
    options.service.get(await caller(req), req.params.id),
  );

  // --- the profile registry (EP-16.6) -------------------------------------------------------------
  //
  // Validation of the SHAPE is the grammar's (`profileErrors`), run by the service; the routes only
  // pass the body through and read `scope`. `version` rides in the PUT body — it is the CAS.
  const scopeOf = (req: FastifyRequest): 'channel' | 'platform' => {
    const scope = (req.query as Record<string, string | undefined>)['scope'];
    if (scope === undefined || scope === 'channel') return 'channel';
    if (scope === 'platform') return 'platform';
    throw new ValidationError('scope must be channel or platform');
  };

  app.get('/api/v1/profiles', async (req) => options.service.listProfiles(await caller(req)));

  app.post('/api/v1/profiles', async (req, reply) => {
    const created = await options.service.createProfile(
      await caller(req),
      (req.body ?? {}) as ProfileInput,
    );
    return reply.code(201).send(created);
  });

  app.get<{ Params: { id: string } }>('/api/v1/profiles/:id', async (req) =>
    options.service.getProfile(await caller(req), req.params.id, scopeOf(req)),
  );

  app.put<{ Params: { id: string } }>('/api/v1/profiles/:id', async (req) => {
    const body = (req.body ?? {}) as ProfileInput & { version?: unknown };
    if (typeof body.version !== 'number') throw new ValidationError('version is required');
    return options.service.replaceProfile(
      await caller(req),
      req.params.id,
      body as ProfileInput & { version: number },
      scopeOf(req),
    );
  });

  /** A channel's jobs, optionally one asset's. */
  app.get<{ Querystring: Record<string, string | undefined> }>('/api/v1/jobs', async (req) => {
    const limit = Number(req.query['limit'] ?? 50);
    return options.service.list(await caller(req), {
      ...(req.query['assetId'] !== undefined ? { assetId: req.query['assetId'] } : {}),
      limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50,
    });
  });

  return app;
}

/** A required string field, or the 422 that names it. */
function str(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new ValidationError(`${field} is required`);
  }
  return value;
}

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
    startedAt: number;
    inFlight?: boolean;
    span?: Span;
  }
}
