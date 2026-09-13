// IAM's container entrypoint (EP-01.4).
//
// Run with plain `node`, no bundler and no tsx: Node 24 strips types natively, so the image ships
// the same source the tests run against. One fewer build artefact to keep honest.

import { migrate, openPool } from '@atlas/data-pg';
import { createTracer, createLogger, HealthRegistry, loadConfig } from '@atlas/service-kit';
import {
  buildIamApp,
  DEFAULT_LOCKOUT,
  IamService,
  KeyRing,
  pgIamStore,
  pgMigrations,
  seedStarterRoles,
} from './index.ts';

const config = loadConfig({
  port: { env: 'PORT', type: 'number', default: 3000 },
  host: { env: 'HOST', type: 'string', default: '0.0.0.0' },
  issuer: { env: 'ATLAS_ISSUER', type: 'string', default: 'atlas-iam' },
  audience: { env: 'ATLAS_AUDIENCE', type: 'string', default: 'atlas' },
  accessTokenTtl: { env: 'ATLAS_ACCESS_TOKEN_TTL', type: 'string', default: '15m' },
  // EP-10.4: identity persists. Before this IAM was in-memory Maps, and every user, grant and
  // session vanished with the pod.
  databaseUrl: {
    env: 'ATLAS_PG_URL',
    type: 'string',
    default: 'postgres://atlas:atlas@postgres:5432/atlas',
  },
  // iam.md §11 calls these out as configuration, and a site with an unusual threat model will want
  // them. The defaults come from DEFAULT_LOCKOUT rather than being restated, so there is one place
  // that decides what "ten in fifteen minutes" means.
  lockoutThreshold: {
    env: 'ATLAS_LOCKOUT_THRESHOLD',
    type: 'number',
    default: DEFAULT_LOCKOUT.threshold,
  },
  lockoutWindowMs: {
    env: 'ATLAS_LOCKOUT_WINDOW_MS',
    type: 'number',
    default: DEFAULT_LOCKOUT.windowMs,
  },
  lockoutDurationMs: {
    env: 'ATLAS_LOCKOUT_DURATION_MS',
    type: 'number',
    default: DEFAULT_LOCKOUT.durationMs,
  },
  // EP-04.7 / ADR-0004. No endpoint means no export: spans are still created and `traceparent`
  // still propagates, so a site without a collector pays only the cost of an id and its traces are
  // already joined up the day one appears.
  otlpEndpoint: { env: 'ATLAS_OTLP_ENDPOINT', type: 'string', default: '' },
  traceSampleRatio: { env: 'ATLAS_TRACE_SAMPLE_RATIO', type: 'number', default: 1 },
});

const log = createLogger('iam');

const tracer = createTracer({
  service: 'iam',
  ...(config.otlpEndpoint !== '' ? { endpoint: config.otlpEndpoint } : {}),
  sampleRatio: config.traceSampleRatio,
});

// Generated per process for now. Production must load the ring from a secret so every replica
// signs with the SAME key — until that lands, a multi-replica IAM would reject its own tokens,
// which is why the dev manifest pins replicas to 1.
const keyRing = await KeyRing.create();

const pool = openPool({ connectionString: config.databaseUrl });

/**
 * Wait for the database, within a budget — the same shape as every other service here. On a fresh
 * install Postgres is not up when IAM starts; retrying recovers in seconds where a crash hands the
 * problem to Kubernetes' backoff. The budget is what turns a wrong password into CrashLoopBackOff,
 * which is the signal an operator actually looks for.
 */
async function migrateWithRetry(budgetMs = 120_000, intervalMs = 2_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (let attempt = 1; ; attempt++) {
    try {
      const { applied } = await migrate(pool, pgMigrations);
      if (applied.length > 0) log.info('migrations applied', { applied });
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      log.warn('database unavailable, retrying', {
        attempt,
        error: (err as Error).message,
        msRemaining: deadline - Date.now(),
      });
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

await migrateWithRetry();

const health = new HealthRegistry().register(
  'postgres',
  async () => (await pool.query('SELECT 1').catch(() => null)) !== null,
  // Critical: nothing IAM does — not a login, not a policy — works without its store.
  { critical: true },
);
const service = new IamService({
  keyRing,
  store: pgIamStore(pool),
  issuer: config.issuer,
  audience: config.audience,
  accessTokenTtl: config.accessTokenTtl,
  lockout: {
    threshold: config.lockoutThreshold,
    windowMs: config.lockoutWindowMs,
    durationMs: config.lockoutDurationMs,
  },
});

// Optional bootstrap account, and deliberately opt-in: it only happens when BOTH variables are
// set, so a production deployment that forgets to unset something cannot silently acquire a
// known-username account.
// The shipped role catalogue (EP-10.7, authorization-model.md §9). Inert until something is
// assigned to a subject — registering them only makes them available to assign.
log.info('starter roles registered', { added: await seedStarterRoles(service.store) });

const seedUser = process.env['ATLAS_SEED_USERNAME'];
const seedPassword = process.env['ATLAS_SEED_PASSWORD'];
if (seedUser && seedPassword) {
  const channelId = process.env['ATLAS_SEED_CHANNEL'] ?? 'ch12';
  // The store persists now, so the seed is idempotent: an existing account is kept as it is —
  // its password included, because a restart must not silently reset a credential someone changed.
  const user =
    (await service.store.userByUsername(seedUser)) ??
    (await service.createUser({ username: seedUser, password: seedPassword, channelId }));

  // A grant, or the account can log in and do nothing. CHANNEL-SCOPED rather than an unscoped
  // assignment of the starter roles: the starter roles ship unscoped for an operator to narrow,
  // and a bootstrap account that could write in every channel is not a useful default even in
  // dev — it would also make cross-tenant refusal untestable in a deployed environment. Written
  // by a fixed id, so a restart replaces rather than duplicates it.
  await service.store.transaction((tx) =>
    tx.putAssignment({
      id: 'seed-grant',
      userId: user.id,
      rule: {
        id: 'seed-grant',
        description:
          'dev bootstrap: full asset lifecycle within the seeded channel, and its history',
        // `logs:read` so the smoke suite can read the audit history of what it wrote (EP-19.1) —
        // the one check that proves gateway → MAM → outbox → broker → sink → Postgres end to end.
        permissions: [
          'asset:read',
          'asset:write',
          'asset:approve',
          'taxonomy:read',
          'logs:read',
          // EP-18: the program table, so the smoke suite can write a reel and read it back.
          'schedule:read',
          'schedule:write',
        ],
        scope: { channelIds: [channelId] },
      },
    }),
  );

  log.warn('seeded a bootstrap user from the environment — never do this in production', {
    username: seedUser,
    channelId,
  });
}

const app = buildIamApp({
  service,
  keyRing,
  health,
  tracer,
  onAccessLog: (record) => log.info('access', { ...record }),
});

await app.listen({ port: config.port, host: config.host });
log.info('iam listening', { port: config.port, host: config.host });

// Kubernetes sends SIGTERM and waits terminationGracePeriodSeconds before SIGKILL. Closing
// Fastify lets in-flight requests finish; ignoring the signal drops requests on every rollout.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info(`${signal} received, draining`);
    // Flush AFTER Fastify closes, so spans for in-flight requests make the final batch.
    void app
      .close()
      .then(() => tracer.shutdown())
      .then(() => pool.end())
      .then(() => process.exit(0));
  });
}
