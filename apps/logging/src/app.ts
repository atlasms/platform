// The Logging service's HTTP surface.
//
// `buildLoggingApp` builds the Fastify app with everything injected — no globals, no
// environment — so a test constructs one in memory and drives it with `app.inject()`. `main.ts` is
// the only place that reads config and talks to real infrastructure.
//
// What is here is the shape every Atlas service shares (generated from it, and kept to it by the
// same tests). What a service DOES goes in `service.ts` and its routes below the marker.

import Fastify, { type FastifyInstance } from 'fastify';
import { isUlid, ulid } from '@atlas/contracts';
import { canEnforce, type EffectivePolicy } from '@atlas/policy';
import type { AuditStore, LogBrowser, LogFilter } from './store.ts';
import { visible } from './visibility.ts';
import {
  accessRecord,
  Forbidden,
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

export interface LoggingAppOptions {
  store: AuditStore;
  /**
   * Where `GET /logs` reads (EP-07.4): the OpenSearch index when the deployment has one, the
   * store itself otherwise. The history and the ingest always use the store — they are the
   * system of record's business. Both browsers pass the same conformance cases.
   */
  browser?: LogBrowser;
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

export async function buildLoggingApp(options: LoggingAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const health = options.health ?? new HealthRegistry();
  const metrics = options.metrics ?? new MetricRegistry();
  const signals = goldenSignals(metrics, 'logging');

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
  // Contracts first (AGENTS.md §5.1): the OpenAPI stub in docs/architecture/openapi/logging.yaml
  // is written BEFORE or WITH the route, and `npm run api:types` projects it for Studio. Every
  // handler `return await`s its work inside the try (a returned promise settles after the catch is
  // out of scope, so its rejection would escape the problem document — AGENTS.md §6).

  /**
   * The revision timeline of one entity (logging-analytics.md §6.4).
   *
   * Two permissions, both enforced: `logs:read` in the channel, AND read on the entity type — a
   * history is the entity's past states, so whoever may not read the asset may not read what it
   * used to be either. Strict evaluation (`canEnforce`): a predicate the caller's rules declare
   * but the request cannot satisfy is a refusal, never a widening.
   */
  app.get<{ Params: { entityType: string; id: string } }>(
    '/api/v1/history/:entityType/:id',
    async (req) => {
      const caller = callerOf(req.headers);
      const policy = await options.policyFor(caller.userId);
      // "We could not determine your permissions" must never degrade into "you have none, carry
      // on" — to a caller with none the two look the same, and only one of them is safe.
      if (!policy) throw new Unauthorized('no policy for subject');

      const { entityType, id } = req.params;
      const context = { channelId: caller.channelId };
      for (const permission of ['logs:read', `${entityType}:read`]) {
        const decision = canEnforce(policy, permission, context);
        if (!decision.allowed) throw new Forbidden(decision.reason ?? `missing ${permission}`);
      }

      // The history of nothing is empty, not missing: a 404 here would tell a caller who may read
      // the channel that no such entity ever existed there, which is itself information.
      const entries = await options.store.history(caller.channelId, entityType, id);
      return { entityType, entityId: id, revisions: entries };
    },
  );

  // --- the log browse (EP-19.3) ----------------------------------------------------------------------
  //
  // `GET /logs` takes its filter from the query string; `POST /logs/query` takes the same filter
  // as JSON, which is where a list of types fits. One engine behind both.

  const MAX_LIMIT = 200;
  const DEFAULT_LIMIT = 50;
  const browser: LogBrowser = options.browser ?? options.store;

  const parseFilter = (raw: Record<string, unknown>): LogFilter => {
    const str = (k: string): string | undefined => {
      const v = raw[k];
      if (v === undefined || v === null || v === '') return undefined;
      if (typeof v !== 'string') throw new ValidationError(`${k} must be a string`);
      return v;
    };
    const num = (k: string): number | undefined => {
      const v = raw[k];
      if (v === undefined || v === null || v === '') return undefined;
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isInteger(n) || n < 0)
        throw new ValidationError(`${k} must be a non-negative integer`);
      return n;
    };
    const types = (() => {
      const v = raw['types'] ?? raw['type'];
      if (v === undefined || v === null || v === '') return undefined;
      const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [v];
      if (!list.every((t) => typeof t === 'string' && t.length > 0)) {
        throw new ValidationError('types must be event type names');
      }
      return list as string[];
    })();
    const limit = Math.min(num('limit') ?? DEFAULT_LIMIT, MAX_LIMIT);
    if (limit < 1) throw new ValidationError('limit must be at least 1');
    const correlationId = str('correlationId');
    const actorId = str('actorId');
    const from = str('from');
    const to = str('to');
    const before = num('before');
    return {
      ...(types ? { types } : {}),
      ...(correlationId !== undefined ? { correlationId } : {}),
      ...(actorId !== undefined ? { actorId } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(before !== undefined ? { before } : {}),
      limit,
    };
  };

  /**
   * One page of the caller's channel's log, permission-filtered.
   *
   * `logs:read` is the door; each entry is then checked against the permission IT requires (see
   * visibility.ts), strictly. Filtering happens after the read, so a page can come back thin with
   * a cursor still present — that is normal, not the end of the log. The cursor advances per row
   * CONSIDERED, not per row returned: advancing only on visible rows would re-scan filtered ones
   * forever, and advancing past what was read would skip rows the loop never reached.
   */
  const browse = async (
    headers: Record<string, string | string[] | undefined>,
    filter: LogFilter,
  ) => {
    const caller = callerOf(headers);
    const policy = await options.policyFor(caller.userId);
    if (!policy) throw new Unauthorized('no policy for subject');
    const door = canEnforce(policy, 'logs:read', { channelId: caller.channelId });
    if (!door.allowed) throw new Forbidden(door.reason ?? 'missing logs:read');

    const page = await browser.browse(caller.channelId, filter);
    const items = page.filter((e) => visible(policy, caller.channelId, e));
    const last = page[page.length - 1];
    // A cursor only when the store's page was full: a short page means the log ran out.
    const nextCursor = page.length === filter.limit && last ? last.seq : undefined;
    return { items, ...(nextCursor !== undefined ? { nextCursor } : {}) };
  };

  app.get<{ Querystring: Record<string, unknown> }>('/api/v1/logs', async (req) =>
    browse(req.headers, parseFilter(req.query)),
  );

  app.post<{ Body: Record<string, unknown> | null }>('/api/v1/logs/query', async (req) =>
    browse(req.headers, parseFilter(req.body ?? {})),
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
