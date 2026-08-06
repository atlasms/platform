// MAM's HTTP surface ([mam.md §4](../../../docs/architecture/services/mam.md#4-public-api)).
//
// Identity arrives as the internal headers the gateway establishes; this service never parses a
// JWT. The gateway authenticates, MAM authorizes — and MAM's decision is the one that counts.

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ulid } from '@atlas/contracts';
import type { EffectivePolicy } from '@atlas/policy';
import {
  goldenSignals,
  HealthRegistry,
  MetricRegistry,
  runWithContext,
  toProblem,
  Unauthorized,
} from '@atlas/service-kit';
import type { LifecycleAction } from './lifecycle.ts';
import type { MamService, Caller } from './service.ts';

export interface MamAppOptions {
  service: MamService;
  /** Resolves the caller's compiled policy — {@link PolicyClient} against IAM in production. */
  policyFor: (userId: string) => Promise<EffectivePolicy | undefined> | EffectivePolicy | undefined;
  health?: HealthRegistry;
  metrics?: MetricRegistry;
  /**
   * Called for any error that becomes a 5xx.
   *
   * A 500 tells the caller nothing on purpose — the message is deliberately opaque so an internal
   * failure cannot leak a query, a path or a stack. That makes it invisible to the operator too
   * unless it is logged HERE, with the same correlation id the caller was given. Without this, an
   * unexpected failure in a deployed service is a bare "Internal error" and nothing to search for.
   */
  onError?: (err: unknown, context: { correlationId: string; method: string; url: string }) => void;
}

export function buildMamApp(options: MamAppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const health = options.health ?? new HealthRegistry();
  const metrics = options.metrics ?? new MetricRegistry();
  const signals = goldenSignals(metrics, 'mam');

  // Lifecycle transitions legitimately carry no body — `POST /assets/{id}/approve` with nothing to
  // say is the normal case. Fastify's default JSON parser rejects an empty body outright, which
  // would surface as a confusing 400 from the framework instead of the service's own answer.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const raw = typeof body === 'string' ? body.trim() : '';
    if (raw === '') return done(null, {});
    try {
      done(null, JSON.parse(raw));
    } catch {
      // Malformed JSON is still the caller's error, and still a 400.
      done(new SyntaxError('body is not valid JSON'), undefined);
    }
  });

  app.addHook('onRequest', (req, _reply, done) => {
    const incoming = req.headers['x-correlation-id'];
    req.correlationId = typeof incoming === 'string' && incoming ? incoming : ulid();
    req.startedAt = Date.now();
    runWithContext({ correlationId: req.correlationId }, () => done());
  });

  app.addHook('onResponse', (req, reply, done) => {
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
  app.get('/metrics', async (_req, reply) =>
    reply.header('content-type', metrics.contentType).send(metrics.expose()),
  );
  app.get('/healthz', async () => health.liveness());
  app.get('/readyz', async (_req, reply) => {
    const report = await health.readiness();
    return reply.code(report.status === 'ready' ? 200 : 503).send(report);
  });

  /** Rebuild the caller from the gateway's headers. Missing identity is 401, never a default. */
  const callerOf = async (req: FastifyRequest): Promise<Caller> => {
    const userId = req.headers['x-atlas-user'];
    const channelId = req.headers['x-atlas-channel'];
    if (typeof userId !== 'string') throw new Unauthorized('no authenticated subject');
    if (typeof channelId !== 'string') throw new Unauthorized('no channel scope');

    // A policy that cannot be established is 401, not an empty policy. "We could not determine
    // your permissions" must never degrade into "you have none, carry on" — the two are
    // indistinguishable to a caller who legitimately has none, and only one of them is safe.
    const policy = await options.policyFor(userId);
    if (!policy) throw new Unauthorized('no policy for subject');
    return { userId, channelId, policy, correlationId: req.correlationId };
  };

  const handle = async (
    req: FastifyRequest,
    reply: FastifyReply,
    fn: () => Promise<unknown>,
  ): Promise<unknown> => {
    try {
      // AWAITED inside the try. Returning the promise would settle it after the catch is out of
      // scope, so every rejection would escape to Fastify's default handler as a bare 500 — losing
      // the problem document, the status, and the correlation id.
      return await fn();
    } catch (err) {
      const problem = toProblem(err, req.correlationId);
      // Only 5xx. A 404 or a 409 is the service working correctly and saying no; logging those at
      // error level trains everyone to ignore the error log.
      if (problem.status >= 500) {
        options.onError?.(err, {
          correlationId: req.correlationId,
          method: req.method,
          url: req.url,
        });
      }
      return reply.code(problem.status).send(problem);
    }
  };

  app.get('/api/v1/assets', async (req, reply) =>
    handle(req, reply, async () => options.service.list(await callerOf(req))),
  );

  app.post('/api/v1/assets', async (req, reply) =>
    handle(req, reply, async () => {
      const asset = await options.service.create(await callerOf(req), req.body as never);
      return reply.code(201).send(asset);
    }),
  );

  app.get('/api/v1/assets/:id', async (req, reply) =>
    handle(req, reply, async () =>
      options.service.get(await callerOf(req), (req.params as { id: string }).id),
    ),
  );

  app.patch('/api/v1/assets/:id', async (req, reply) =>
    handle(req, reply, async () =>
      options.service.update(
        await callerOf(req),
        (req.params as { id: string }).id,
        req.body as never,
      ),
    ),
  );

  // Extensible metadata (EP-17.2). A separate resource from the asset, not a nested object on it:
  // it is governed by its own schema, authorized on its own, and can grow without bound — so a
  // catalogue listing should never carry it.
  app.get('/api/v1/assets/:id/extended', async (req, reply) =>
    handle(req, reply, async () =>
      options.service.extended(await callerOf(req), (req.params as { id: string }).id),
    ),
  );

  app.patch('/api/v1/assets/:id/extended', async (req, reply) =>
    handle(req, reply, async () =>
      options.service.updateExtended(
        await callerOf(req),
        (req.params as { id: string }).id,
        (req.body ?? {}) as Record<string, unknown>,
      ),
    ),
  );

  app.get('/api/v1/field-schemas', async (req, reply) =>
    handle(req, reply, async () => options.service.schemas(await callerOf(req))),
  );

  app.put('/api/v1/field-schemas', async (req, reply) =>
    handle(req, reply, async () =>
      options.service.putSchema(await callerOf(req), req.body as never),
    ),
  );

  // Lifecycle transitions are their own endpoints, not a PATCH of `state`. The verb is the point:
  // approving is a distinct permission, emits a distinct event, and is refused from a state a
  // metadata edit would happily have overwritten.
  const transitionRoute = (path: string, action: LifecycleAction): void => {
    app.post(`/api/v1/assets/:id/${path}`, async (req, reply) =>
      handle(req, reply, async () =>
        options.service.transition(
          await callerOf(req),
          (req.params as { id: string }).id,
          action,
          (req.body ?? {}) as { expiresAt?: string; retainUntil?: string; reason?: string },
        ),
      ),
    );
  };

  transitionRoute('process', 'startProcessing');
  transitionRoute('ready', 'markReady');
  transitionRoute('approve', 'approve');
  transitionRoute('reject', 'reject');

  return app;
}

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
    startedAt: number;
  }
}
