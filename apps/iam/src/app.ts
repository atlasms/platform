// The HTTP surface. Thin: every decision lives in IamService, so the routes are transport only.
// Spec: docs/architecture/services/iam.md · contract: docs/architecture/openapi/iam.yaml

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  accessRecord,
  goldenSignals,
  isTraceable,
  HealthRegistry,
  Unauthorized,
  runWithContext,
  shouldLogAccess,
  PROBLEM_CONTENT_TYPE,
  toProblem,
  type AccessLogPolicy,
  type AccessRecord,
  type Span,
  type Tracer,
} from '@atlas/service-kit';
import { ulid } from '@atlas/contracts';
import { ValidationError } from '@atlas/service-kit';
import { IamAdmin, type AdminCaller } from './admin.ts';
import type { IamService } from './service.ts';
import type { KeyRing } from './tokens.ts';

export interface IamAppOptions {
  service: IamService;
  keyRing: KeyRing;
  /** The admin surface (EP-10.4). Built from the service when omitted. */
  admin?: IamAdmin;
  health?: HealthRegistry;
  /**
   * Per-request access log (#245). Omit and nothing is logged — this service emitted no access
   * record at all before, so the default must not suddenly triple anyone's log volume.
   *
   * The POLICY decides what is worth a line; see `access-log.ts`. Non-2xx and slow requests are
   * always logged, the rest is sampled and defaults to off, because a fast successful request is
   * already fully described by the golden signals.
   */
  onAccessLog?: (record: AccessRecord) => void;
  accessLogPolicy?: AccessLogPolicy;
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

  // An EMPTY body with a JSON content type is not an error. Fastify's default parser refuses it
  // (FST_ERR_CTP_EMPTY_JSON_BODY), which turns a body-less DELETE sent with the header into a 500.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '' || body === undefined) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

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

    // The access record (#245). Probes and the scraper are excluded for the same reason they are
    // not traced: they are almost all the requests, and an operator reading this is looking for a
    // request somebody made.
    if (options.onAccessLog && isTraceable(template)) {
      const latencyMs = Date.now() - req.startedAt;
      if (shouldLogAccess({ status: reply.statusCode, latencyMs }, options.accessLogPolicy)) {
        const userId = req.headers['x-atlas-user'];
        options.onAccessLog(
          accessRecord({
            requestId: req.correlationId,
            method: req.method,
            // The TEMPLATE, never req.url — a ULID in a log field is the Loki version of the
            // cardinality trap the metrics already avoid, and it makes "how slow is
            // GET /assets/:id" unanswerable because every request is its own route.
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
      return reply.code(p.status).type(PROBLEM_CONTENT_TYPE).send(p);
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
      return reply.code(p.status).type(PROBLEM_CONTENT_TYPE).send(p);
    }
  });

  app.post('/auth/refresh', async (req, reply) => {
    const { refreshToken } = (req.body ?? {}) as RefreshBody;
    if (typeof refreshToken !== 'string') {
      const p = toProblem(new Unauthorized('refreshToken is required'), req.correlationId);
      return reply.code(p.status).type(PROBLEM_CONTENT_TYPE).send(p);
    }
    try {
      return await service.refresh(refreshToken);
    } catch (err) {
      const p = toProblem(err, req.correlationId);
      return reply.code(p.status).type(PROBLEM_CONTENT_TYPE).send(p);
    }
  });

  app.post('/auth/logout', async (req, reply) => {
    const { refreshToken, allSessions } = (req.body ?? {}) as RefreshBody;
    if (typeof refreshToken === 'string') {
      await service.logout(refreshToken, {
        ...(allSessions === true ? { allSessions: true } : {}),
      });
    }
    // Always 204: telling a caller whether the token existed is an oracle.
    return reply.code(204).send();
  });

  // --- administration (EP-10.4) ----------------------------------------------------------------------
  //
  // Behind the gateway: the caller is the gateway-established header, never a re-parsed JWT. Every
  // decision is the admin module's; these routes parse, call, and answer. Each handler `return
  // await`s inside the try so a rejection cannot escape the problem document.

  const admin = options.admin ?? new IamAdmin({ service, store: service.store });

  const callerOf = (req: FastifyRequest): AdminCaller => {
    const userId = req.headers['x-atlas-user'];
    if (typeof userId !== 'string' || userId === '')
      throw new Unauthorized('no authenticated subject');
    const channelId = req.headers['x-atlas-channel'];
    return {
      userId,
      ...(typeof channelId === 'string' && channelId !== '' ? { channelId } : {}),
      correlationId: req.correlationId,
    };
  };

  const handle = async (
    req: FastifyRequest,
    reply: FastifyReply,
    status: number,
    fn: (caller: AdminCaller) => Promise<unknown>,
  ): Promise<unknown> => {
    try {
      const result = await fn(callerOf(req));
      return status === 204 ? reply.code(204).send() : reply.code(status).send(result);
    } catch (err) {
      const p = toProblem(err, req.correlationId);
      return reply.code(p.status).type(PROBLEM_CONTENT_TYPE).send(p);
    }
  };

  const body = (req: FastifyRequest): Record<string, unknown> => {
    if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) {
      throw new ValidationError('body must be an object');
    }
    return req.body as Record<string, unknown>;
  };
  const str = (v: unknown, name: string, required = false): string | undefined => {
    if (v === undefined || v === null) {
      if (required) throw new ValidationError(`${name} is required`);
      return undefined;
    }
    if (typeof v !== 'string') throw new ValidationError(`${name} must be a string`);
    return v;
  };
  type Q = Record<string, string | undefined>;
  type P = { id: string; assignmentId: string };

  // The compiled policy. `me` is the caller; anyone else needs user:admin in the user's channel.
  // Cached against permVersion by every consumer, so it must be revalidatable.
  app.get<{ Params: P }>('/api/v1/users/:id/effective-permissions', (req, reply) =>
    handle(req, reply, 200, async (caller) => {
      const id = req.params.id === 'me' ? caller.userId : req.params.id;
      const policy = await admin.effectivePolicyOf(caller, id);
      void reply.header('etag', `W/"pv-${policy.permVersion}"`);
      return policy;
    }),
  );

  app.get<{ Querystring: Q }>('/api/v1/users', (req, reply) =>
    handle(req, reply, 200, (caller) =>
      admin.listUsers(caller, {
        ...(req.query['channelId'] !== undefined ? { channelId: req.query['channelId'] } : {}),
        ...(req.query['after'] !== undefined ? { after: req.query['after'] } : {}),
        ...(req.query['limit'] !== undefined ? { limit: Number(req.query['limit']) } : {}),
      }),
    ),
  );
  app.post('/api/v1/users', (req, reply) =>
    handle(req, reply, 201, (caller) => {
      const b = body(req);
      const channelId = b['channelId'];
      if (channelId !== undefined && channelId !== null && typeof channelId !== 'string') {
        throw new ValidationError('channelId must be a string or null');
      }
      const state = str(b['state'], 'state');
      if (state !== undefined && state !== 'active' && state !== 'invited') {
        throw new ValidationError('state must be active or invited');
      }
      return admin.createUser(caller, {
        username: str(b['username'], 'username', true) as string,
        ...(b['password'] !== undefined
          ? { password: str(b['password'], 'password') as string }
          : {}),
        ...(b['name'] !== undefined ? { name: str(b['name'], 'name') as string } : {}),
        ...(channelId !== undefined ? { channelId: channelId as string | null } : {}),
        ...(state !== undefined ? { state } : {}),
      });
    }),
  );
  app.get<{ Params: P }>('/api/v1/users/:id', (req, reply) =>
    handle(req, reply, 200, (caller) => admin.getUser(caller, req.params.id)),
  );
  app.patch<{ Params: P }>('/api/v1/users/:id', (req, reply) =>
    handle(req, reply, 200, (caller) => {
      const b = body(req);
      const state = str(b['state'], 'state');
      if (state !== undefined && state !== 'active' && state !== 'disabled') {
        throw new ValidationError('state must be active or disabled');
      }
      return admin.updateUser(caller, req.params.id, {
        ...(b['name'] !== undefined ? { name: str(b['name'], 'name') as string } : {}),
        ...(state !== undefined ? { state } : {}),
        ...(b['password'] !== undefined
          ? { password: str(b['password'], 'password') as string }
          : {}),
      });
    }),
  );

  app.get<{ Params: P }>('/api/v1/users/:id/assignments', (req, reply) =>
    handle(req, reply, 200, (caller) => admin.listAssignments(caller, req.params.id)),
  );
  app.post<{ Params: P }>('/api/v1/users/:id/assignments', (req, reply) =>
    handle(req, reply, 201, (caller) => {
      const b = body(req);
      if (b['roleId'] !== undefined) {
        return admin.createAssignment(caller, req.params.id, {
          roleId: str(b['roleId'], 'roleId') as string,
        });
      }
      if (b['rule'] !== undefined) {
        return admin.createAssignment(caller, req.params.id, { rule: b['rule'] as never });
      }
      throw new ValidationError('an assignment names a roleId or carries a rule');
    }),
  );
  app.delete<{ Params: P }>('/api/v1/users/:id/assignments/:assignmentId', (req, reply) =>
    handle(req, reply, 204, (caller) =>
      admin.deleteAssignment(caller, req.params.id, req.params.assignmentId),
    ),
  );

  const groupInput = (b: Record<string, unknown>) => {
    const channelId = b['channelId'];
    if (channelId !== undefined && channelId !== null && typeof channelId !== 'string') {
      throw new ValidationError('channelId must be a string or null');
    }
    const roleIds = b['roleIds'];
    if (
      roleIds !== undefined &&
      (!Array.isArray(roleIds) || !roleIds.every((r) => typeof r === 'string'))
    ) {
      throw new ValidationError('roleIds must be an array of strings');
    }
    return {
      ...(channelId !== undefined ? { channelId: channelId as string | null } : {}),
      ...(b['name'] !== undefined ? { name: str(b['name'], 'name') as string } : {}),
      ...(b['description'] !== undefined
        ? { description: str(b['description'], 'description') as string }
        : {}),
      ...(b['rules'] !== undefined ? { rules: b['rules'] as never } : {}),
      ...(roleIds !== undefined ? { roleIds: roleIds as string[] } : {}),
    };
  };

  app.get<{ Querystring: Q }>('/api/v1/groups', (req, reply) =>
    handle(req, reply, 200, (caller) =>
      admin.listGroups(caller, {
        ...(req.query['channelId'] !== undefined ? { channelId: req.query['channelId'] } : {}),
      }),
    ),
  );
  app.post('/api/v1/groups', (req, reply) =>
    handle(req, reply, 201, (caller) => admin.createGroup(caller, groupInput(body(req)))),
  );
  app.get<{ Params: P }>('/api/v1/groups/:id', (req, reply) =>
    handle(req, reply, 200, (caller) => admin.getGroup(caller, req.params.id)),
  );
  app.patch<{ Params: P }>('/api/v1/groups/:id', (req, reply) =>
    handle(req, reply, 200, (caller) =>
      admin.updateGroup(caller, req.params.id, groupInput(body(req))),
    ),
  );
  app.delete<{ Params: P }>('/api/v1/groups/:id', (req, reply) =>
    handle(req, reply, 204, (caller) => admin.deleteGroup(caller, req.params.id)),
  );
  app.get<{ Params: P }>('/api/v1/groups/:id/members', (req, reply) =>
    handle(req, reply, 200, (caller) => admin.listMembers(caller, req.params.id)),
  );
  app.post<{ Params: P }>('/api/v1/groups/:id/members', (req, reply) =>
    handle(req, reply, 204, (caller) =>
      admin.addMember(caller, req.params.id, str(body(req)['userId'], 'userId', true) as string),
    ),
  );
  app.delete<{ Params: P; Querystring: Q }>('/api/v1/groups/:id/members', (req, reply) =>
    handle(req, reply, 204, (caller) => {
      const userId = req.query['userId'];
      if (userId === undefined || userId === '') throw new ValidationError('userId is required');
      return admin.removeMember(caller, req.params.id, userId);
    }),
  );

  app.get<{ Querystring: Q }>('/api/v1/roles', (req, reply) =>
    handle(req, reply, 200, (caller) =>
      admin.listRoles(caller, {
        ...(req.query['channelId'] !== undefined ? { channelId: req.query['channelId'] } : {}),
      }),
    ),
  );
  app.post('/api/v1/roles', (req, reply) =>
    handle(req, reply, 201, (caller) => {
      const b = body(req);
      return admin.createRole(caller, {
        ...groupInput(b),
        ...(b['id'] !== undefined ? { id: str(b['id'], 'id') as string } : {}),
      });
    }),
  );
  app.get<{ Params: P }>('/api/v1/roles/:id', (req, reply) =>
    handle(req, reply, 200, (caller) => admin.getRole(caller, req.params.id)),
  );
  app.patch<{ Params: P }>('/api/v1/roles/:id', (req, reply) =>
    handle(req, reply, 200, (caller) =>
      admin.updateRole(caller, req.params.id, groupInput(body(req))),
    ),
  );
  app.delete<{ Params: P }>('/api/v1/roles/:id', (req, reply) =>
    handle(req, reply, 204, (caller) => admin.deleteRole(caller, req.params.id)),
  );
  app.get<{ Params: P }>('/api/v1/roles/:id/holders', (req, reply) =>
    handle(req, reply, 200, (caller) => admin.roleHolders(caller, req.params.id)),
  );

  app.setErrorHandler((err, req, reply) => {
    const p = toProblem(err, req.correlationId);
    void reply.code(p.status).type(PROBLEM_CONTENT_TYPE).send(p);
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
