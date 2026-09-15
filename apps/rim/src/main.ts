// The Rim service's container entrypoint.
//
// Run with plain `node`, no bundler and no tsx: Node 24 strips types natively, so the image ships
// the same source the tests run against — which is why nothing in this service's import graph may
// use syntax that EMITS (a constructor parameter property, an enum): AGENTS.md §6, and eslint.
//
// This file is the only one that reads the environment or touches real infrastructure. Everything
// it wires is injected into `buildRimApp`, so the tests never see any of it.

import { mkdir } from 'node:fs/promises';
import { migrate, openPool, PgOutboxStore } from '@atlas/data-pg';
import { OutboxRelay } from '@atlas/messaging';
import { NatsBroker } from '@atlas/messaging-nats';
import {
  createLogger,
  createTracer,
  currentTraceparent,
  HealthRegistry,
  loadConfig,
  MetricRegistry,
} from '@atlas/service-kit';
import { PolicyClient } from '@atlas/policy/client';
import {
  buildRimApp,
  DEFAULT_PART_BYTES,
  DEFAULT_UPLOAD_TTL_MS,
  fsStaging,
  pgMigrations,
  pgRimStore,
  RimService,
} from './index.ts';

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
  pgSchema: { env: 'ATLAS_PG_SCHEMA', type: 'string', default: 'rim' },
  natsUrl: { env: 'ATLAS_NATS_URL', type: 'string', default: 'nats://nats:4222' },
  relayIntervalMs: { env: 'ATLAS_RELAY_INTERVAL_MS', type: 'number', default: 1_000 },
  policyTtlMs: { env: 'ATLAS_POLICY_TTL_MS', type: 'number', default: 30_000 },
  // The upload (EP-15.1; rim.md §11). The staging area is RIM's own landing zone, a volume of
  // this pod's — NOT the platform's storage, which only HSM writes (FR-HSM-5). The part size is
  // what every part but the last must be, and it must fit through the gateway's cap on the
  // /api/v1/uploads prefix; the TTL is how long an open upload may go uncompleted.
  stagingDir: {
    env: 'ATLAS_RIM_STAGING_DIR',
    type: 'string',
    default: '/var/lib/atlas/rim/staging',
  },
  partSizeBytes: { env: 'ATLAS_UPLOAD_PART_BYTES', type: 'number', default: DEFAULT_PART_BYTES },
  uploadTtlMs: { env: 'ATLAS_UPLOAD_TTL_MS', type: 'number', default: DEFAULT_UPLOAD_TTL_MS },
  sweepIntervalMs: { env: 'ATLAS_UPLOAD_SWEEP_INTERVAL_MS', type: 'number', default: 60_000 },
  // EP-04.7 / ADR-0004. No endpoint means no export: spans are still created and `traceparent`
  // still propagates, so a site without a collector pays only the cost of an id.
  otlpEndpoint: { env: 'ATLAS_OTLP_ENDPOINT', type: 'string', default: '' },
  traceSampleRatio: { env: 'ATLAS_TRACE_SAMPLE_RATIO', type: 'number', default: 1 },
});

const log = createLogger('rim');

const tracer = createTracer({
  service: 'rim',
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
      // The outbox, the uploads with their parts, the ingest jobs. Every row is channel-scoped;
      // the outbox and the parts (scoped through their upload) are the inventoried exceptions.
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
// The staging area must exist and be writable before the first part arrives — a missing volume
// mount is a deploy error worth failing on at start, not on the first upload.
await mkdir(config.stagingDir, { recursive: true });

const store = pgRimStore(pool);
const service = new RimService({
  store,
  staging: fsStaging(config.stagingDir),
  partSizeBytes: config.partSizeBytes,
  uploadTtlMs: config.uploadTtlMs,
  // The trace context is captured where the event is CREATED, inside the request (EP-13.3): the
  // relay publishes later on a timer with no ambient context at all.
  traceHeaders: () => {
    const traceparent = currentTraceparent();
    return traceparent ? { traceparent } : undefined;
  },
});
const policies = new PolicyClient({ origin: config.iamOrigin, ttlMs: config.policyTtlMs });

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
  });

const app = await buildRimApp({
  service,
  policyFor: (userId) => policies.policyFor(userId),
  partSizeBytes: config.partSizeBytes,
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
    broker = await NatsBroker.connect({ servers: config.natsUrl, service: 'rim' });
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

// --- the sweeper: abandoned uploads do not keep their parts forever ---------------------------------
let sweepTimer: NodeJS.Timeout | undefined;
const sweep = async (): Promise<void> => {
  try {
    const n = await service.sweep();
    if (n > 0) log.info('swept expired uploads', { count: n });
  } catch (err) {
    log.error('sweep failed', { error: (err as Error).message });
  }
  sweepTimer = setTimeout(() => void sweep(), config.sweepIntervalMs);
};
void sweep();

await app.listen({ port: config.port, host: config.host });
log.info('rim listening', { port: config.port, host: config.host });

// Kubernetes stops routing and sends SIGTERM at the same moment, so a request already in flight
// can still arrive; draining Fastify is what stops every rollout dropping requests. The manifest's
// terminationGracePeriodSeconds gives this 30s.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info(`${signal} received, draining`);
    if (retryTimer) clearTimeout(retryTimer);
    if (sweepTimer) clearTimeout(sweepTimer);
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
