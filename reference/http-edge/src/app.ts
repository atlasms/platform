import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ulid, isUlid } from '../../contracts/src/index.ts';
import { verifyJwt, requirePermission, runWithContext, toProblem, Unauthorized, NotFound, HealthRegistry, type Claims, type VerifyOptions } from '../../service-kit/src/index.ts';
import type { MamService } from '../../mam-service/src/index.ts';

// The synchronous edge for a service. Every cross-cutting concern comes from service-kit; the routes
// are thin and delegate to the domain service. Same shape for any service (design: system plan §6).
export interface EdgeDeps {
  mam: MamService;
  health: HealthRegistry;
  jwks: Parameters<typeof verifyJwt>[1];
  verifyOptions?: VerifyOptions;
}

type Req = FastifyRequest & { correlationId: string; claims?: Claims };

export function buildApp(deps: EdgeDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  // Correlation: adopt an incoming id if it's a valid ULID, else mint one; echo it on the response.
  app.addHook('onRequest', async (req: any, reply) => {
    const incoming = req.headers['x-correlation-id'] as string | undefined;
    req.correlationId = incoming && isUlid(incoming) ? incoming : ulid();
    reply.header('x-correlation-id', req.correlationId);
  });

  // One error mapping for the whole surface: AppError -> problem+JSON; unknown -> 500.
  app.setErrorHandler((err, req: any, reply) => {
    const problem = toProblem(err, req.correlationId);
    reply.status(problem.status).send(problem);
  });

  const authed = async (req: Req): Promise<Claims> => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw new Unauthorized('missing bearer token');
    req.claims = await verifyJwt(h.slice(7), deps.jwks, deps.verifyOptions);
    return req.claims;
  };
  const inCtx = <T>(req: Req, claims: Claims | undefined, fn: () => T): T =>
    runWithContext({ correlationId: req.correlationId, actor: claims?.sub ? { kind: 'user', id: claims.sub } : undefined }, fn);

  // --- public: health ---
  app.get('/healthz', async () => deps.health.liveness());
  app.get('/readyz', async (_req, reply) => {
    const r = await deps.health.readiness();
    if (r.status !== 'ready') reply.status(503);
    return r;
  });

  // --- asset reads/commands ---
  app.get('/assets/:id', async (req: any) => {
    const asset = deps.mam.getAsset(req.params.id);
    if (!asset) throw new NotFound(`asset ${req.params.id}`);
    return asset;
  });

  app.post('/assets/:id/approve', async (req: any) => {
    const claims = await authed(req);
    requirePermission(claims, 'asset:approve');
    return inCtx(req, claims, () => deps.mam.approve(req.params.id, claims.sub!, { expiresAt: req.body?.expiresAt, correlationId: req.correlationId }));
  });

  app.post('/assets/:id/reject', async (req: any) => {
    const claims = await authed(req);
    requirePermission(claims, 'asset:approve');
    return inCtx(req, claims, () => deps.mam.reject(req.params.id, req.body?.reason ?? 'unspecified', { rejectedBy: claims.sub, retainUntil: req.body?.retainUntil }));
  });

  return app;
}
