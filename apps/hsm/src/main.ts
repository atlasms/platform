// The Hsm service's container entrypoint.
//
// Run with plain `node`, no bundler and no tsx: Node 24 strips types natively, so the image ships
// the same source the tests run against — which is why nothing in this service's import graph may
// use syntax that EMITS (a constructor parameter property, an enum): AGENTS.md §6, and eslint.
//
// This file is the only one that reads the environment or touches real infrastructure. Everything
// it wires is injected into `buildHsmApp`, so the tests never see any of it.

import { mkdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { migrate, openPool, PgOutboxStore } from '@atlas/data-pg';
import { OutboxRelay } from '@atlas/messaging';
import { NatsBroker } from '@atlas/messaging-nats';
import { PolicyClient } from '@atlas/policy/client';
import {
  createLogger,
  createTracer,
  currentTraceparent,
  HealthRegistry,
  internalKeys,
  loadConfig,
  MetricRegistry,
} from '@atlas/service-kit';
import { buildHsmApp, driverFactory, HsmService, pgHsmStore, pgMigrations } from './index.ts';

const config = loadConfig({
  port: { env: 'PORT', type: 'number', default: 3000 },
  host: { env: 'HOST', type: 'string', default: '0.0.0.0' },
  iamOrigin: { env: 'ATLAS_IAM_ORIGIN', type: 'string', default: 'http://iam:3000' },
  databaseUrl: {
    env: 'ATLAS_PG_URL',
    type: 'string',
    default: 'postgres://atlas:atlas@postgres:5432/atlas',
  },
  // The service's OWN Postgres schema (EP-07.6): the database is shared infrastructure, the
  // tables are not. Named after the service; every connection's search_path is pinned to it.
  pgSchema: { env: 'ATLAS_PG_SCHEMA', type: 'string', default: 'hsm' },
  natsUrl: { env: 'ATLAS_NATS_URL', type: 'string', default: 'nats://nats:4222' },
  policyTtlMs: { env: 'ATLAS_POLICY_TTL_MS', type: 'number', default: 30_000 },
  // ADR-0009. The storage mounted into THIS pod — an fs target's root must lie under it — and the
  // first online target, made once from config when the platform has none.
  fsBase: { env: 'ATLAS_HSM_FS_BASE', type: 'string', default: '/storage' },
  bootstrapRoot: { env: 'ATLAS_HSM_BOOTSTRAP_ROOT', type: 'string', default: '/storage/online' },
  // The storage credentials Secret, mounted here only: `<credentialRef>/accessKeyId|secretAccessKey`.
  credentialsDir: {
    env: 'ATLAS_HSM_CREDENTIALS_DIR',
    type: 'string',
    default: '/var/run/atlas/hsm-credentials',
  },
  // The keys producers sign placements with (hsm-internal-keys; ADR-0008/0009). Comma-separated.
  internalKeys: { env: 'ATLAS_HSM_INTERNAL_KEYS', type: 'string', default: '' },
  workerIntervalMs: { env: 'ATLAS_HSM_WORKER_INTERVAL_MS', type: 'number', default: 1_000 },
  relayIntervalMs: { env: 'ATLAS_RELAY_INTERVAL_MS', type: 'number', default: 1_000 },
  // EP-04.7 / ADR-0004. No endpoint means no export: spans are still created and `traceparent`
  // still propagates, so a site without a collector pays only the cost of an id.
  otlpEndpoint: { env: 'ATLAS_OTLP_ENDPOINT', type: 'string', default: '' },
  traceSampleRatio: { env: 'ATLAS_TRACE_SAMPLE_RATIO', type: 'number', default: 1 },
});

const log = createLogger('hsm');

const tracer = createTracer({
  service: 'hsm',
  ...(config.otlpEndpoint !== '' ? { endpoint: config.otlpEndpoint } : {}),
  sampleRatio: config.traceSampleRatio,
});

const metrics = new MetricRegistry();

const pool = openPool({ connectionString: config.databaseUrl, schema: config.pgSchema });

/**
 * Wait for the database, within a budget.
 *
 * On a fresh install every service starts at once and Postgres is not up yet. Exiting immediately
 * hands the problem to Kubernetes' restart backoff, which grows to five minutes — measured on a
 * first deploy, that was 7 restarts and 16 minutes to reach ready, long after the database was
 * serving. Retrying here recovers in seconds.
 *
 * The budget matters as much as the retry: a wrong password or a missing database is a permanent
 * failure, and a service that retries one of those forever never tells anyone it is misconfigured.
 * After the budget we exit and let the pod report CrashLoopBackOff, which is the signal an
 * operator actually looks for.
 */
async function migrateWithRetry(budgetMs = 120_000, intervalMs = 2_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (let attempt = 1; ; attempt++) {
    try {
      // The ledger, its replicas, the storage targets and the operation queue (store-pg.ts).
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

const store = pgHsmStore(pool);
const service = new HsmService({
  store,
  drivers: driverFactory({ credentialsDir: config.credentialsDir }),
  // Captured where the event is created, inside the request (EP-13.3).
  traceHeaders: () => {
    const traceparent = currentTraceparent();
    return traceparent ? { traceparent } : undefined;
  },
});

// A platform with no storage target cannot place a byte: make the first one from config, once.
await mkdir(config.bootstrapRoot, { recursive: true });
const bootstrapped = await service.bootstrapTarget(config.bootstrapRoot);
if (bootstrapped)
  log.info('bootstrap storage target created', { id: bootstrapped.id, root: bootstrapped.root });

const health = new HealthRegistry()
  .register(
    'iam',
    async () => (await fetch(new URL('/healthz', config.iamOrigin)).catch(() => null))?.ok === true,
    // Critical: without IAM no caller's permissions can be resolved. Reporting ready would only
    // route requests into refusals.
    { critical: true },
  )
  .register('postgres', async () => (await pool.query('SELECT 1').catch(() => null)) !== null, {
    critical: true,
  })
  // HSM IS its storage: the platform's default online target must be writable to be ready.
  .register(
    'storage',
    async () => {
      const target = (await store.targets(undefined)).find(
        (t) => t.channelId === undefined && t.isDefault && t.tier === 'online' && t.enabled,
      );
      if (!target) return false;
      return (await driverFactory({ credentialsDir: config.credentialsDir })(target))
        .probe()
        .then(() => true)
        .catch(() => false);
    },
    { critical: true },
  );

const policies = new PolicyClient({ origin: config.iamOrigin, ttlMs: config.policyTtlMs });

const app = await buildHsmApp({
  service,
  policyFor: (userId) => policies.policyFor(userId),
  internalKeys: internalKeys(config.internalKeys),
  onInternalRefused: (reason, ctx) => log.warn('internal request refused', { ...ctx, reason }),
  fsBase: config.fsBase,
  health,
  metrics,
  tracer,
  onAccessLog: (record) => log.info('access', { ...record }),
  onError: (err, ctx) =>
    log.error('unhandled error', {
      ...ctx,
      error: (err as Error).message,
      stack: (err as Error).stack,
    }),
});

// --- the broker -------------------------------------------------------------------------------------
//
// NOT a readiness check. With NATS down this service still serves requests; what it commits
// accumulates in the outbox to be relayed when the broker returns — that is what the outbox is for.
// Failing readiness here would take the service out of service to protect a broadcast, which
// inverts the priority.

let broker: NatsBroker | undefined;
let retryTimer: NodeJS.Timeout | undefined;
const outbox = new PgOutboxStore(pool);

async function startBroker(): Promise<void> {
  try {
    broker = await NatsBroker.connect({ servers: config.natsUrl, service: 'hsm' });
  } catch (err) {
    // Retry rather than exit. A broker that is slow to start would otherwise crash-loop this
    // service, and it does not need the broker to serve requests.
    log.warn('broker unavailable, retrying', { error: (err as Error).message });
    retryTimer = setTimeout(() => void startBroker(), 5_000);
    return;
  }

  const relay = new OutboxRelay(outbox, broker);
  log.info('outbox relay started', { intervalMs: config.relayIntervalMs });
  const tick = async (): Promise<void> => {
    try {
      const n = await relay.drain();
      if (n > 0) log.info('relayed events', { count: n });
    } catch (err) {
      // Left unsent on purpose: the next tick retries. Marking them sent to clear the error would
      // silently drop the event, which is the one outcome the outbox exists to prevent.
      log.error('relay tick failed', { error: (err as Error).message });
    }
    retryTimer = setTimeout(() => void tick(), config.relayIntervalMs);
  };
  void tick();
}

void startBroker();

// --- the operation worker (EP-14.5) -----------------------------------------------------------------
//
// In-process for v1: one loop per replica, the lease making any number of them safe (ADR-0009 §5).
// The pod name is the lease holder, so a lapsed lease names the pod that died holding it.

const workerId = process.env['HOSTNAME'] ?? hostname();
let workerTimer: NodeJS.Timeout | undefined;
let stopping = false;
const work = async (): Promise<void> => {
  try {
    while (!stopping && (await service.work(workerId, 1)) > 0) {
      // Drain what is due, one at a time; each one is its own lease.
    }
  } catch (err) {
    log.error('operation worker tick failed', { error: (err as Error).message });
  }
  if (!stopping) workerTimer = setTimeout(() => void work(), config.workerIntervalMs);
};
void work();

await app.listen({ port: config.port, host: config.host });
log.info('hsm listening', { port: config.port, host: config.host });

// Kubernetes stops routing and sends SIGTERM at the same moment, so a request already in flight
// can still arrive; draining Fastify is what stops every rollout dropping requests. The manifest's
// terminationGracePeriodSeconds gives this 30s.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info(`${signal} received, draining`);
    if (retryTimer) clearTimeout(retryTimer);
    stopping = true;
    if (workerTimer) clearTimeout(workerTimer);
    void app
      .close()
      // After Fastify closes, so spans for in-flight requests make the final batch.
      .then(() => tracer.shutdown())
      .then(() => broker?.close())
      .then(() => pool.end())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}
