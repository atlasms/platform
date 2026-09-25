// The Rim service's HTTP surface.
//
// `buildRimApp` builds the Fastify app with everything injected — no globals, no
// environment — so a test constructs one in memory and drives it with `app.inject()`. `main.ts` is
// the only place that reads config and talks to real infrastructure.
//
// What is here is the shape every Atlas service shares (generated from it, and kept to it by the
// same tests). What a service DOES goes in `service.ts` and its routes below the marker.

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { isUlid, ulid } from '@atlas/contracts';
import type { EffectivePolicy } from '@atlas/policy';
import {
  accessRecord,
  goldenSignals,
  isTraceable,
  HealthRegistry,
  MetricRegistry,
  runWithContext,
  shouldLogAccess,
  PayloadTooLarge,
  PROBLEM_CONTENT_TYPE,
  toProblem,
  Unauthorized,
  ValidationError,
  type AccessLogPolicy,
  type AccessRecord,
  type Span,
  type Tracer,
} from '@atlas/service-kit';
import { parseRuleSetInput } from './acceptance.ts';
import { parseWatcherInput } from './watcher.ts';
import type { Caller as ServiceCaller, RimService } from './service.ts';
import type { JobQuery } from './store.ts';
import { INGEST_STATES, parseStartUpload, type IngestJob, type IngestState } from './upload.ts';

export interface RimAppOptions {
  service: RimService;
  /**
   * Resolves the caller's compiled policy — `PolicyClient` from `@atlas/policy/client` against IAM
   * in production, a stub in tests. Fails closed: `undefined` is a 401, never an empty policy.
   */
  policyFor: (userId: string) => Promise<EffectivePolicy | undefined> | EffectivePolicy | undefined;
  /**
   * The most bytes one part may carry — the service's part size, which the gateway must also
   * allow on this prefix. Fastify refuses a larger body before it is read (413, translated below).
   */
  partSizeBytes: number;
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

export async function buildRimApp(options: RimAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const health = options.health ?? new HealthRegistry();
  const metrics = options.metrics ?? new MetricRegistry();
  const signals = goldenSignals(metrics, 'rim');

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

  // The raw bytes of a part, as a Buffer. The gateway forwards them verbatim (it parses nothing
  // and re-serialises nothing — api-gateway app.ts), so what lands here is what the client sent.
  // Capped at the part size: a larger body is refused by Fastify before it is read.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: options.partSizeBytes },
    (_req, body, done) => done(null, body),
  );

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
    // Fastify enforces the part cap itself and raises FST_ERR_CTP_BODY_TOO_LARGE; `toProblem` maps
    // anything outside the taxonomy to INTERNAL/500, which would file a client's oversized part as
    // a server failure — the gateway learned the same lesson (api-gateway app.ts).
    const mapped =
      (err as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE'
        ? new PayloadTooLarge(`a part is at most ${options.partSizeBytes} bytes`)
        : err;
    const problem = toProblem(mapped, req.correlationId);
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
  // Contracts first (AGENTS.md §5.1): the OpenAPI stub in docs/architecture/openapi/rim.yaml
  // is written BEFORE or WITH the route, and `npm run api:types` projects it for Studio. Every
  // handler `return await`s its work inside the try (a returned promise settles after the catch is
  // out of scope, so its rejection would escape the problem document — AGENTS.md §6).

  // --- the upload (EP-15.1) ---------------------------------------------------------------------------
  //
  // The gateway authenticated; this service authorizes, with the caller's compiled policy and the
  // resource context. Every handler `return await`s inside the try: a returned promise settles
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
  type P = { id: string; n: string };

  app.post('/api/v1/uploads', (req, reply) =>
    handle(req, reply, 201, (caller) => service.start(caller, parseStartUpload(req.body))),
  );

  app.get<{ Params: P }>('/api/v1/uploads/:id', (req, reply) =>
    handle(req, reply, 200, (caller) => service.status(caller, req.params.id)),
  );

  app.delete<{ Params: P }>('/api/v1/uploads/:id', (req, reply) =>
    handle(req, reply, 204, (caller) => service.abort(caller, req.params.id)),
  );

  app.put<{ Params: P }>('/api/v1/uploads/:id/parts/:n', (req, reply) =>
    handle(req, reply, 204, (caller) => {
      const n = Number(req.params.n);
      if (!Number.isInteger(n) || n < 1)
        throw new ValidationError('part number must be a positive integer');
      // Only the octet-stream parser above yields a Buffer; anything else was the wrong content type.
      if (!Buffer.isBuffer(req.body)) {
        throw new ValidationError('a part is sent as application/octet-stream');
      }
      return service.putPart(caller, req.params.id, n, req.body);
    }),
  );

  // The received path is where the bytes sit on this node's disk — HSM's business (EP-14) and an
  // operator's, not a client's. rim.yaml's IngestJob does not carry it, on any route.
  const wire = (job: IngestJob): Omit<IngestJob, 'receivedPath'> => {
    const { receivedPath: _path, ...rest } = job;
    void _path;
    return rest;
  };

  app.post<{ Params: P }>('/api/v1/uploads/:id/complete', (req, reply) =>
    handle(req, reply, 202, async (caller) => wire(await service.complete(caller, req.params.id))),
  );

  // --- the queue and the review (EP-15.6) -------------------------------------------------------------

  type Q = { limit?: string; cursor?: string; state?: string; order?: string };
  const parseQueue = (q: Q): JobQuery => {
    const limit = q.limit === undefined ? 50 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ValidationError('limit must be an integer between 1 and 200');
    }
    if (q.cursor !== undefined && !isUlid(q.cursor))
      throw new ValidationError('cursor must be a ULID');
    if (q.state !== undefined && !INGEST_STATES.includes(q.state as IngestState)) {
      throw new ValidationError(`state must be one of ${INGEST_STATES.join(', ')}`);
    }
    if (q.order !== undefined && q.order !== 'asc' && q.order !== 'desc') {
      throw new ValidationError('order must be asc or desc');
    }
    return {
      limit,
      order: q.order === 'asc' ? 'asc' : 'desc',
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(q.state !== undefined ? { state: q.state as IngestState } : {}),
    };
  };

  app.get<{ Querystring: Q }>('/api/v1/ingest/queue', (req, reply) =>
    handle(req, reply, 200, async (caller) => {
      const page = await service.queue(caller, parseQueue(req.query));
      return { ...page, items: page.items.map(wire) };
    }),
  );

  app.get<{ Params: P }>('/api/v1/ingest/:id', (req, reply) =>
    handle(req, reply, 200, async (caller) => wire(await service.job(caller, req.params.id))),
  );

  app.post<{ Params: P }>('/api/v1/ingest/:id/accept', (req, reply) =>
    handle(req, reply, 200, async (caller) => wire(await service.acceptJob(caller, req.params.id))),
  );

  app.post<{ Params: P }>('/api/v1/ingest/:id/reject', (req, reply) =>
    handle(req, reply, 200, async (caller) => {
      const reason = (req.body as { reason?: unknown } | undefined)?.reason;
      if (typeof reason !== 'string') throw new ValidationError('reason is required');
      return wire(await service.rejectJob(caller, req.params.id, reason));
    }),
  );

  // --- the acceptance rules (EP-15.3) -------------------------------------------------------------------

  app.get('/api/v1/acceptance-rules', (req, reply) =>
    handle(req, reply, 200, (caller) => service.ruleSets(caller)),
  );

  app.post('/api/v1/acceptance-rules', (req, reply) =>
    handle(req, reply, 201, (caller) => service.createRuleSet(caller, parseRuleSetInput(req.body))),
  );

  app.get<{ Params: P }>('/api/v1/acceptance-rules/:id', (req, reply) =>
    handle(req, reply, 200, (caller) => service.ruleSet(caller, req.params.id)),
  );

  app.put<{ Params: P }>('/api/v1/acceptance-rules/:id', (req, reply) =>
    handle(req, reply, 200, (caller) =>
      service.replaceRuleSet(caller, req.params.id, parseRuleSetInput(req.body)),
    ),
  );

  app.delete<{ Params: P }>('/api/v1/acceptance-rules/:id', (req, reply) =>
    handle(req, reply, 204, (caller) => service.deleteRuleSet(caller, req.params.id)),
  );

  // Folder watchers (EP-15.2). No DELETE: jobs name their watcher as source — disable it instead.
  app.get('/api/v1/watchers', (req, reply) =>
    handle(req, reply, 200, (caller) => service.watchers(caller)),
  );

  app.post('/api/v1/watchers', (req, reply) =>
    handle(req, reply, 201, (caller) => service.createWatcher(caller, parseWatcherInput(req.body))),
  );

  app.get<{ Params: P }>('/api/v1/watchers/:id', (req, reply) =>
    handle(req, reply, 200, (caller) => service.watcher(caller, req.params.id)),
  );

  app.put<{ Params: P }>('/api/v1/watchers/:id', (req, reply) =>
    handle(req, reply, 200, (caller) =>
      service.replaceWatcher(caller, req.params.id, parseWatcherInput(req.body)),
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
