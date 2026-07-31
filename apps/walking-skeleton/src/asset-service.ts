// The skeleton's stand-in for MAM. DELIBERATELY TRIVIAL — one entity, one field, one event.
//
// This is NOT the MAM service (EP-17). Its only job is to be the thinnest possible domain service
// that still exercises every cross-cutting rule: channel scoping, server-side authorization, the
// transactional outbox, and correlation propagation. If the spine works for this, it works.

import Fastify, { type FastifyInstance } from 'fastify';
import { buildEnvelope, subjectFor, ulid, type Envelope } from '@atlas/contracts';
import { canEnforce, type EffectivePolicy } from '@atlas/policy';
import { Forbidden, Unauthorized, runWithContext, toProblem } from '@atlas/service-kit';
import {
  SqliteOutboxStore,
  jsonRepo,
  jsonTableMigration,
  migrate,
  openDb,
  withTransaction,
  type Db,
} from '@atlas/data';

export interface SkeletonAsset {
  id: string;
  channelId: string;
  title: string;
  createdBy: string;
  createdAt: string;
}

export interface AssetServiceOptions {
  /** Resolves the caller's compiled policy. In production this is the cached IAM snapshot. */
  policyFor: (userId: string) => EffectivePolicy | undefined;
  db?: Db;
}

export interface AssetService {
  app: FastifyInstance;
  db: Db;
  outbox: SqliteOutboxStore;
  assets: ReturnType<typeof jsonRepo<SkeletonAsset>>;
}

export function buildAssetService(options: AssetServiceOptions): AssetService {
  const db = options.db ?? openDb(':memory:');
  migrate(db, [jsonTableMigration('assets'), { id: 'core_outbox', up: OUTBOX_DDL }]);

  const assets = jsonRepo<SkeletonAsset>(db, 'assets');
  const outbox = new SqliteOutboxStore(db);
  const app = Fastify({ logger: false });

  app.addHook('onRequest', (req, _reply, done) => {
    // The gateway always sets this; falling back keeps the service testable standalone.
    const incoming = req.headers['x-correlation-id'];
    req.correlationId = typeof incoming === 'string' && incoming ? incoming : ulid();
    runWithContext({ correlationId: req.correlationId }, () => done());
  });

  app.post('/api/v1/assets', async (req, reply) => {
    try {
      // Identity comes from the gateway-established header set — the service never re-parses
      // a JWT (see the gateway's INTERNAL_HEADERS).
      const userId = req.headers['x-atlas-user'];
      const channelId = req.headers['x-atlas-channel'];
      if (typeof userId !== 'string') throw new Unauthorized('no authenticated subject');
      if (typeof channelId !== 'string') throw new Unauthorized('no channel scope');

      const policy = options.policyFor(userId);
      if (!policy) throw new Unauthorized('no policy for subject');

      // STRICT enforcement with the full context. Lenient `can` would widen the grant
      // (authorization-model.md §5.1).
      const decision = canEnforce(policy, 'asset:write', { channelId, ownerId: userId });
      if (!decision.allowed) throw new Forbidden(decision.reason ?? 'not permitted');

      const { title } = (req.body ?? {}) as { title?: string };
      if (typeof title !== 'string' || title.length === 0) {
        return reply.code(422).send({ code: 'VALIDATION', status: 422, message: 'title required' });
      }

      const asset: SkeletonAsset = {
        id: ulid(),
        channelId,
        title,
        createdBy: userId,
        createdAt: new Date().toISOString(),
      };

      const envelope: Envelope = buildEnvelope({
        type: 'asset.created',
        channelId,
        payload: { assetId: asset.id, title: asset.title },
        actor: { kind: 'user', id: userId },
        correlationId: req.correlationId,
      });

      // THE POINT OF THE SKELETON: the row and its event commit together, or neither does.
      withTransaction(db, () => {
        assets.put(asset);
        outbox.enqueue({
          id: envelope.messageId,
          message: {
            id: envelope.messageId,
            subject: subjectFor(channelId, envelope.type),
            body: envelope,
          },
        });
      });

      return reply.code(201).send(asset);
    } catch (err) {
      const problem = toProblem(err, req.correlationId);
      return reply.code(problem.status).send(problem);
    }
  });

  app.get('/api/v1/assets/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = assets.get(id);
    if (!found)
      return reply.code(404).send({ code: 'NOT_FOUND', status: 404, message: 'no asset' });
    return found;
  });

  return { app, db, outbox, assets };
}

const OUTBOX_DDL = `CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
)`;

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
  }
}
