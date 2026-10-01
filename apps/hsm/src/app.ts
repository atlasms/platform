// The Hsm service's HTTP surface.
//
// `buildHsmApp` builds the Fastify app with everything injected — no globals, no
// environment — so a test constructs one in memory and drives it with `app.inject()`. `main.ts` is
// the only place that reads config and talks to real infrastructure.
//
// What is here is the shape every Atlas service shares (generated from it, and kept to it by the
// same tests). What a service DOES goes in `service.ts` and its routes below the marker.

import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { isUlid, ulid } from '@atlas/contracts';
import type { EffectivePolicy } from '@atlas/policy';
import { fileView, parsePlacement, type FileKind } from './file.ts';
import { operationView, OPERATION_KINDS, type OperationKind } from './operation.ts';
import type { Caller as ServiceCaller, HsmService } from './service.ts';
import { parseTargetInput } from './targets.ts';
import {
  INTERNAL_SIGNATURE_HEADER,
  NotFound,
  preflightInternal,
  ValidationError,
  verifyInternal,
  verifyInternalDigest,
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
  type AccessLogPolicy,
  type AccessRecord,
  type Span,
  type Tracer,
} from '@atlas/service-kit';

export interface HsmAppOptions {
  service: HsmService;
  /** Resolves the caller's compiled policy; `undefined` is a 401, never an empty policy. */
  policyFor: (userId: string) => Promise<EffectivePolicy | undefined> | EffectivePolicy | undefined;
  /** Keys a producer signs internal requests with (ADR-0008/0009). None: every one is refused. */
  internalKeys?: readonly string[];
  /** Why an internal request was refused — the log's business, never the caller's. */
  onInternalRefused?: (reason: string, context: { correlationId: string; url: string }) => void;
  /** An fs target's root must lie under this — the storage mounted into HSM (targets.ts). */
  fsBase: string;
  now?: () => Date;
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

export async function buildHsmApp(options: HsmAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const health = options.health ?? new HealthRegistry();
  const metrics = options.metrics ?? new MetricRegistry();
  const signals = goldenSignals(metrics, 'hsm');

  // An EMPTY body with a JSON content type is `undefined`, not an error. Fastify's default parser
  // refuses it (FST_ERR_CTP_EMPTY_JSON_BODY), which turned every `DELETE` and every body-less
  // `POST /…/approve` sent with `content-type: application/json` into a 500 — a client that sets
  // the header by default (most do) hit it on the first action with no body. The gateway strips an
  // empty body before proxying, which is why this only shows up on a direct call — and in tests.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    // The bytes as sent: an internal request's signature covers them, not the parsed object.
    (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
    if (body === '' || body === undefined) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // A file's bytes (ADR-0009 §3): handed to the route AS THE STREAM, never read into memory — a
  // master is gigabytes. No body limit applies to a parser that does not read.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) =>
    done(null, payload),
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
  // Contracts first (AGENTS.md §5.1): the OpenAPI stub in docs/architecture/openapi/hsm.yaml
  // is written BEFORE or WITH the route, and `npm run api:types` projects it for Studio. Every
  // handler `return await`s its work inside the try (a returned promise settles after the catch is
  // out of scope, so its rejection would escape the problem document — AGENTS.md §6).

  // --- HSM ---------------------------------------------------------------------------------------------

  const { service } = options;
  const now = (): Date => options.now?.() ?? new Date();
  const internalKeys = options.internalKeys ?? [];
  const refused = metrics.counter({
    name: 'atlas_hsm_internal_refused_total',
    help: 'Internal (signed) requests refused — a misconfigured producer, or someone probing.',
  });
  const placements = metrics.counter({
    name: 'atlas_hsm_placements_total',
    help: 'Files placed by producers, by outcome (created, replaced, unchanged).',
    labelNames: ['outcome'],
  });
  const placedBytes = metrics.counter({
    name: 'atlas_hsm_placed_bytes_total',
    help: 'Bytes written to storage by placements.',
  });

  const problem = (req: FastifyRequest, reply: FastifyReply, err: unknown): FastifyReply => {
    const doc = toProblem(err, req.correlationId);
    if (doc.status >= 500)
      options.onError?.(err, { correlationId: req.correlationId, url: req.url });
    return reply.code(doc.status).type(PROBLEM_CONTENT_TYPE).send(doc);
  };
  const refuse = (req: FastifyRequest, reason: string): never => {
    refused.inc();
    options.onInternalRefused?.(reason, { correlationId: req.correlationId, url: req.url });
    throw new Unauthorized('not an internal request');
  };
  const header = (req: FastifyRequest): string | undefined => {
    const h = req.headers[INTERNAL_SIGNATURE_HEADER];
    return typeof h === 'string' ? h : undefined;
  };

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
      return reply.code(status).send(result);
    } catch (err) {
      return problem(req, reply, err);
    }
  };
  /** A signed request with a small body (JSON or none): verified over the bytes as sent. */
  const handleInternal = async (
    req: FastifyRequest,
    reply: FastifyReply,
    status: number,
    fn: () => Promise<unknown>,
  ): Promise<unknown> => {
    try {
      const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
      const verdict = verifyInternal(
        internalKeys,
        { method: req.method, path: req.url, body: raw },
        header(req),
        now(),
      );
      if (!verdict.ok) refuse(req, verdict.reason);
      return reply.code(status).send(await fn());
    } catch (err) {
      return problem(req, reply, err);
    }
  };

  type Q = Record<string, string | undefined>;
  const versionOf = (q: Q): number => {
    const v = Number(q['version']);
    if (!Number.isInteger(v) || v < 1) {
      throw new ValidationError(
        'version is required — the version you read, for the compare-and-set',
      );
    }
    return v;
  };

  // Location (EP-14.6): where an asset's files are, through the gateway. The gateway sends
  // `/api/v1/assets/{id}/location` here and the rest of `/api/v1/assets` to MAM (a suffix route).
  app.get<{ Params: { id: string } }>('/api/v1/assets/:id/location', (req, reply) =>
    handle(req, reply, 200, async (caller) =>
      (await service.location(caller, req.params.id)).map(({ file, replicas }) =>
        fileView(file, replicas),
      ),
    ),
  );

  app.get<{ Params: { id: string } }>('/api/v1/operations/:id', (req, reply) =>
    handle(req, reply, 200, async (caller) =>
      operationView(await service.operationFor(caller, req.params.id)),
    ),
  );

  // Storage targets (EP-14.2): storage:admin; `?scope=platform` for a platform-wide one.
  app.get('/api/v1/storage-targets', (req, reply) =>
    handle(req, reply, 200, (caller) => service.targets(caller)),
  );
  app.post<{ Querystring: Q }>('/api/v1/storage-targets', (req, reply) =>
    handle(req, reply, 201, (caller) =>
      service.createTarget(
        caller,
        parseTargetInput(req.body, options.fsBase),
        req.query['scope'] === 'platform',
      ),
    ),
  );
  app.get<{ Params: { id: string } }>('/api/v1/storage-targets/:id', (req, reply) =>
    handle(req, reply, 200, (caller) => service.target(caller, req.params.id)),
  );
  app.put<{ Params: { id: string }; Querystring: Q }>('/api/v1/storage-targets/:id', (req, reply) =>
    handle(req, reply, 200, (caller) =>
      service.updateTarget(
        caller,
        req.params.id,
        versionOf(req.query),
        parseTargetInput(req.body, options.fsBase),
      ),
    ),
  );

  // --- internal: producers and services (ADR-0009). Never routed by the gateway. -----------------

  /**
   * A producer's file, streamed. The signature's shape, key and time are checked BEFORE the body is
   * read; its MAC is checked AFTER, against the digest HSM computed of the bytes it wrote — so the
   * checksum in the ledger is HSM's own AND the producer's. The channel, the variant and the
   * provenance come from the query string, which the signature covers; headers are not signed.
   */
  app.put<{ Params: { assetId: string; kind: string }; Querystring: Q }>(
    '/internal/v1/assets/:assetId/files/:kind',
    async (req, reply) => {
      const arrived = now();
      const signature = header(req);
      try {
        const pre = preflightInternal(internalKeys, signature, arrived);
        if (!pre.ok) refuse(req, pre.reason);
        if (!(req.body instanceof Readable)) {
          throw new ValidationError('a file is sent as application/octet-stream');
        }
        const input = parsePlacement(req.params.assetId, req.params.kind, req.query);
        const { file, outcome } = await service.place(
          input,
          req.body,
          (sha256) => {
            const verdict = verifyInternalDigest(
              internalKeys,
              { method: req.method, path: req.url, bodySha256: sha256 },
              signature,
              arrived,
            );
            if (!verdict.ok) {
              refused.inc();
              options.onInternalRefused?.(verdict.reason, {
                correlationId: req.correlationId,
                url: req.url,
              });
            }
            return verdict.ok;
          },
          req.correlationId,
        );
        placements.inc({ outcome });
        if (outcome !== 'unchanged') placedBytes.inc({}, file.sizeBytes);
        return reply.code(outcome === 'created' ? 201 : 200).send(fileView(file));
      } catch (err) {
        return problem(req, reply, err);
      }
    },
  );

  /** A live file's bytes, for a producer reading an input (MTS). The digest rides in a header. */
  app.get<{ Params: { assetId: string; kind: string }; Querystring: Q }>(
    '/internal/v1/assets/:assetId/files/:kind/content',
    async (req, reply) => {
      try {
        const verdict = verifyInternal(
          internalKeys,
          { method: req.method, path: req.url, body: '' },
          header(req),
          now(),
        );
        if (!verdict.ok) refuse(req, verdict.reason);
        const { file, stream } = await service.content(
          req.params.assetId,
          req.params.kind as FileKind,
          req.query['variant'],
        );
        return reply
          .code(200)
          .type('application/octet-stream')
          .header('content-length', String(file.sizeBytes))
          .header('x-atlas-sha256', file.checksum.value)
          .header('x-atlas-file-id', file.id)
          .send(stream);
      } catch (err) {
        return problem(req, reply, err);
      }
    },
  );

  /** Copy, move or delete (EP-14.3), queued; the caller's `id` makes a retry the same request. */
  app.post('/internal/v1/files/operations', (req, reply) =>
    handleInternal(req, reply, 202, async () => {
      const body = req.body as Record<string, unknown> | undefined;
      if (typeof body !== 'object' || body === null)
        throw new ValidationError('body must be an object');
      const kind = body['kind'];
      if (typeof kind !== 'string' || !(OPERATION_KINDS as readonly string[]).includes(kind)) {
        throw new ValidationError('kind must be copy, move or delete');
      }
      const fileId = body['fileId'];
      if (typeof fileId !== 'string' || !isUlid(fileId))
        throw new ValidationError('fileId must be a ULID');
      const id = body['id'];
      if (id !== undefined && (typeof id !== 'string' || !isUlid(id))) {
        throw new ValidationError('id must be a ULID');
      }
      const requestedBy = body['requestedBy'];
      const to = body['toTargetId'];
      return operationView(
        await service.requestOperation(
          {
            kind: kind as OperationKind,
            fileId,
            ...(typeof id === 'string' ? { id } : {}),
            ...(typeof to === 'string' ? { toTargetId: to } : {}),
          },
          typeof requestedBy === 'string' ? requestedBy.slice(0, 64) : 'service',
          req.correlationId,
        ),
      );
    }),
  );

  app.get<{ Params: { id: string } }>('/internal/v1/operations/:id', (req, reply) =>
    handleInternal(req, reply, 200, async () => {
      const op = await service.operation(req.params.id).catch(() => undefined);
      if (!op) throw new NotFound(`operation ${req.params.id}`);
      return operationView(op);
    }),
  );

  /** Who the gateway says is calling. The first thing a real route does. */
  app.get('/api/v1/hsm/whoami', async (req) => {
    const caller = callerOf(req.headers);
    return { service: 'hsm', ...caller };
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
