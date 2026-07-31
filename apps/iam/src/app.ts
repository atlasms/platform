// The HTTP surface. Thin: every decision lives in IamService, so the routes are transport only.
// Spec: docs/architecture/services/iam.md · contract: docs/architecture/openapi/iam.yaml

import Fastify, { type FastifyInstance } from 'fastify';
import { HealthRegistry, Unauthorized, runWithContext, toProblem } from '@atlas/service-kit';
import { ulid } from '@atlas/contracts';
import type { IamService } from './service.ts';
import type { KeyRing } from './tokens.ts';

export interface IamAppOptions {
  service: IamService;
  keyRing: KeyRing;
  health?: HealthRegistry;
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

  app.addHook('onRequest', (req, _reply, done) => {
    const incoming = req.headers['x-correlation-id'];
    const correlationId = typeof incoming === 'string' && incoming ? incoming : ulid();
    req.correlationId = correlationId;
    runWithContext({ correlationId }, () => done());
  });

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
  }
}
