// The Scheduling service's HTTP surface.
//
// `buildSchedulingApp` builds the Fastify app with everything injected — no globals, no
// environment — so a test constructs one in memory and drives it with `app.inject()`. `main.ts` is
// the only place that reads config and talks to real infrastructure.
//
// What is here is the shape every Atlas service shares (generated from it, and kept to it by the
// same tests). What a service DOES goes in `service.ts` and its routes below the marker.

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { isUlid, ulid } from '@atlas/contracts';
import type { EffectivePolicy } from '@atlas/policy';
import {
  parseCreateSchedule,
  parseItemInput,
  parseUpdateSchedule,
  type ScheduleItemInput,
} from './schedule.ts';
import type { SchedulingService, Caller as ServiceCaller } from './service.ts';
import {
  accessRecord,
  goldenSignals,
  isTraceable,
  HealthRegistry,
  MetricRegistry,
  runWithContext,
  shouldLogAccess,
  PROBLEM_CONTENT_TYPE,
  NotFound,
  toProblem,
  Unauthorized,
  ValidationError,
  type AccessLogPolicy,
  type AccessRecord,
  type Span,
  type Tracer,
} from '@atlas/service-kit';

export interface SchedulingAppOptions {
  service: SchedulingService;
  /**
   * Resolves the caller's compiled policy — `PolicyClient` from `@atlas/policy/client` against IAM
   * in production, a stub in tests. Fails closed: `undefined` is a 401, never an empty policy.
   */
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

export async function buildSchedulingApp(options: SchedulingAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const health = options.health ?? new HealthRegistry();
  const metrics = options.metrics ?? new MetricRegistry();
  const signals = goldenSignals(metrics, 'scheduling');

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
  // Contracts first (AGENTS.md §5.1): the OpenAPI stub in docs/architecture/openapi/scheduling.yaml
  // is written BEFORE or WITH the route, and `npm run api:types` projects it for Studio. Every
  // handler `return await`s its work inside the try (a returned promise settles after the catch is
  // out of scope, so its rejection would escape the problem document — AGENTS.md §6).

  // --- the program table (EP-18 v0) ------------------------------------------------------------------
  //
  // The gateway authenticated; this service authorizes, with the caller's compiled policy and the
  // full resource context. Every handler `return await`s inside the try: a returned promise settles
  // after the catch is out of scope, and its rejection would escape the problem document.

  const withCaller = async (req: FastifyRequest): Promise<ServiceCaller> => {
    const caller = callerOf(req.headers);
    const policy = await options.policyFor(caller.userId);
    // "We could not determine your permissions" must never degrade into "you have none, carry on".
    if (!policy) throw new Unauthorized('no policy for subject');
    return { ...caller, policy, correlationId: req.correlationId };
  };

  const handle = async (
    req: FastifyRequest,
    reply: FastifyReply,
    status: number,
    fn: (caller: ServiceCaller) => Promise<unknown>,
  ): Promise<unknown> => {
    try {
      const result = await fn(await withCaller(req));
      return status === 204 ? reply.code(204).send() : reply.code(status).send(result);
    } catch (err) {
      const problem = toProblem(err, req.correlationId);
      if (problem.status >= 500) {
        options.onError?.(err, { correlationId: req.correlationId, url: req.url });
      }
      return reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
    }
  };

  const { service } = options;
  type Q = Record<string, string | undefined>;
  type P = { id: string; itemId: string };

  app.get<{ Querystring: Q }>('/api/v1/schedules', (req, reply) =>
    handle(req, reply, 200, (caller) =>
      service.list(caller, {
        ...(req.query['broadcastDate'] !== undefined
          ? { broadcastDate: req.query['broadcastDate'] }
          : {}),
        ...(req.query['after'] !== undefined ? { after: req.query['after'] } : {}),
        ...(req.query['limit'] !== undefined ? { limit: Number(req.query['limit']) } : {}),
      }),
    ),
  );

  app.post('/api/v1/schedules', (req, reply) =>
    handle(req, reply, 201, (caller) => service.create(caller, parseCreateSchedule(req.body))),
  );

  app.get<{ Params: P }>('/api/v1/schedules/:id', (req, reply) =>
    handle(req, reply, 200, async (caller) => {
      const schedule = await service.get(caller, req.params.id);
      const items = await service.items(caller, req.params.id);
      return { ...schedule, items };
    }),
  );

  app.patch<{ Params: P }>('/api/v1/schedules/:id', (req, reply) =>
    handle(req, reply, 200, (caller) =>
      service.update(caller, req.params.id, parseUpdateSchedule(req.body)),
    ),
  );

  app.get<{ Params: P }>('/api/v1/schedules/:id/items', (req, reply) =>
    handle(req, reply, 200, (caller) => service.items(caller, req.params.id)),
  );

  // The editor's save: the whole reel, as given (the thin write path — §3.4, §3.6).
  app.put<{ Params: P }>('/api/v1/schedules/:id/items', (req, reply) =>
    handle(req, reply, 200, (caller) => {
      if (!Array.isArray(req.body)) throw new ValidationError('body must be an array of items');
      const inputs: ScheduleItemInput[] = req.body.map((item, i) =>
        parseItemInput(item, `items[${i}]: `),
      );
      return service.replaceItems(caller, req.params.id, inputs);
    }),
  );

  app.post<{ Params: P }>('/api/v1/schedules/:id/items', (req, reply) =>
    handle(req, reply, 201, (caller) =>
      service.addItem(caller, req.params.id, parseItemInput(req.body)),
    ),
  );

  app.patch<{ Params: P }>('/api/v1/schedules/:id/items/:itemId', (req, reply) =>
    handle(req, reply, 200, async (caller) => {
      // A patch is a partial item: validate the fields that are present by parsing them over the
      // current row, so every rule that applies to a whole item applies to the merged one.
      const current = (await service.items(caller, req.params.id)).find(
        (i) => i.id === req.params.itemId,
      );
      if (!current) throw new NotFound(`item ${req.params.itemId}`);
      if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) {
        throw new ValidationError('body must be an object');
      }
      const { end: _end, id: _id, scheduleId: _s, ...base } = current;
      void _end;
      void _id;
      void _s;
      const merged = parseItemInput({ ...base, ...(req.body as Record<string, unknown>) });
      const { id: _mid, ...patch } = merged;
      void _mid;
      return service.updateItem(caller, req.params.id, req.params.itemId, patch);
    }),
  );

  app.delete<{ Params: P }>('/api/v1/schedules/:id/items/:itemId', (req, reply) =>
    handle(req, reply, 204, (caller) =>
      service.removeItem(caller, req.params.id, req.params.itemId),
    ),
  );

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
