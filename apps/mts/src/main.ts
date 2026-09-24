// The Mts service's container entrypoint.
//
// Run with plain `node`, no bundler and no tsx: Node 24 strips types natively, so the image ships
// the same source the tests run against — which is why nothing in this service's import graph may
// use syntax that EMITS (a constructor parameter property, an enum): AGENTS.md §6, and eslint.
//
// This file is the only one that reads the environment or touches real infrastructure. Everything
// it wires is injected into `buildMtsApp`, so the tests never see any of it.

import { migrate, openPool, PgOutboxStore } from '@atlas/data-pg';
import { OutboxRelay } from '@atlas/messaging';
import { NatsBroker } from '@atlas/messaging-nats';
import { PolicyClient } from '@atlas/policy/client';
import {
  createLogger,
  createTracer,
  HealthRegistry,
  loadConfig,
  MetricRegistry,
} from '@atlas/service-kit';
import {
  buildMtsApp,
  ffmpegTranscoder,
  MtsService,
  pgJobStore,
  pgMigrations,
  runWorker,
  startJobConsumer,
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
  pgSchema: { env: 'ATLAS_PG_SCHEMA', type: 'string', default: 'mts' },
  natsUrl: { env: 'ATLAS_NATS_URL', type: 'string', default: 'nats://nats:4222' },
  relayIntervalMs: { env: 'ATLAS_RELAY_INTERVAL_MS', type: 'number', default: 1_000 },
  // EP-04.7 / ADR-0004. No endpoint means no export: spans are still created and `traceparent`
  // still propagates, so a site without a collector pays only the cost of an id.
  otlpEndpoint: { env: 'ATLAS_OTLP_ENDPOINT', type: 'string', default: '' },
  traceSampleRatio: { env: 'ATLAS_TRACE_SAMPLE_RATIO', type: 'number', default: 1 },
  policyTtlMs: { env: 'ATLAS_POLICY_TTL_MS', type: 'number', default: 30_000 },
  // EP-16.2. Inputs are read from here and renditions written under it. Until HSM (EP-14)
  // resolves paths, a job's `inputPath` MUST be inside this root — see service.ts.
  workRoot: { env: 'ATLAS_MTS_WORK_DIR', type: 'string', default: '/var/lib/atlas/mts' },
  ffmpegBinary: { env: 'ATLAS_FFMPEG_BINARY', type: 'string', default: 'ffmpeg' },
  transcodeTimeoutMs: { env: 'ATLAS_TRANSCODE_TIMEOUT_MS', type: 'number', default: 30 * 60_000 },
  maxAttempts: { env: 'ATLAS_TRANSCODE_MAX_ATTEMPTS', type: 'number', default: 3 },
  // How long a `running` row may go unwritten before the sweep takes it back. Longer than any
  // single progress write, shorter than a person's patience.
  staleAfterMs: { env: 'ATLAS_TRANSCODE_STALE_MS', type: 'number', default: 5 * 60_000 },
  // A worker polls its own table; this is the pause after finding nothing to do.
  idleMs: { env: 'ATLAS_TRANSCODE_IDLE_MS', type: 'number', default: 1_000 },
});

const log = createLogger('mts');

const tracer = createTracer({
  service: 'mts',
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
      // Migrations go here, in order, once written: `migrate(pool, [ownTablesMigration, ...])`.
      // Every table carries channel_id (AGENTS.md §5.3); the outbox table is the exception.
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

// The worker is this process: MTS is the platform's scale-to-many service (mts.md §8), and a
// replica is one pod running one job at a time. `hostname` is the pod name in Kubernetes, which
// is exactly what an operator greps for when a job is slow.
const workerId = process.env['HOSTNAME'] ?? `mts-${process.pid}`;
const transcoder = ffmpegTranscoder({
  binary: config.ffmpegBinary,
  timeoutMs: config.transcodeTimeoutMs,
});
const store = pgJobStore(pool);
const service = new MtsService({
  store,
  transcoder,
  workRoot: config.workRoot,
  maxAttempts: config.maxAttempts,
  workerId,
});

const health = new HealthRegistry()
  .register(
    'ffmpeg',
    () => transcoder.available(),
    // Critical: a deployment whose image lost the binary can accept jobs and fail every one of
    // them. Better to be visibly not-ready than quietly useless — and the image installs it
    // (infra/docker/Dockerfile, APK_PACKAGES=ffmpeg).
    { critical: true },
  )
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

const policies = new PolicyClient({ origin: config.iamOrigin, ttlMs: config.policyTtlMs });

const app = await buildMtsApp({
  service,
  policyFor: (userId) => policies.policyFor(userId),
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
    broker = await NatsBroker.connect({ servers: config.natsUrl, service: 'mts' });
  } catch (err) {
    // Retry rather than exit. A broker that is slow to start would otherwise crash-loop this
    // service, and it does not need the broker to serve requests.
    log.warn('broker unavailable, retrying', { error: (err as Error).message });
    retryTimer = setTimeout(() => void startBroker(), 5_000);
    return;
  }

  // EP-16.1: the command queue. A `transcode.job.create` becomes a queued ROW and is acked in
  // milliseconds; the worker loop below is what spends minutes in FFmpeg. See jobs.ts for why
  // those are two things.
  startJobConsumer({
    broker,
    service,
    onQueued: (subject) => log.info('job queued from command', { subject }),
    onDuplicate: (subject) => log.info('job command redelivered', { subject }),
    onError: (err, msg) =>
      log.warn('job command refused', {
        subject: msg.subject,
        messageId: msg.id,
        error: (err as Error).message,
      }),
  });

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

await app.listen({ port: config.port, host: config.host });
log.info('mts listening', { port: config.port, host: config.host });

// --- the worker -------------------------------------------------------------------------------
//
// In this process, not a second deployable: a pod that serves `GET /jobs/{id}` and runs the
// encode is one thing to scale, and scaling it IS the design (mts.md §8). The abort controller is
// what SIGTERM reaches — an interrupted job goes back to the queue with its attempt returned,
// rather than counting a rollout against its retry budget.
const draining = new AbortController();
const worker = runWorker({
  service,
  signal: draining.signal,
  idleMs: config.idleMs,
  staleAfterMs: config.staleAfterMs,
  onRun: (outcome) => {
    if (outcome !== 'idle') log.info('job run', { outcome, workerId });
  },
  onError: (err) => log.error('worker loop error', { error: (err as Error).message }),
});
log.info('transcode worker started', { workerId, workRoot: config.workRoot });

// Kubernetes stops routing and sends SIGTERM at the same moment, so a request already in flight
// can still arrive; draining Fastify is what stops every rollout dropping requests. The manifest's
// terminationGracePeriodSeconds gives this 30s.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info(`${signal} received, draining`);
    if (retryTimer) clearTimeout(retryTimer);
    // The running transcode is killed and its job requeued before Fastify stops accepting: the
    // pod is going away either way, and a job left `running` waits out the whole stale sweep.
    draining.abort();
    void worker
      .then(() => app.close())
      // After Fastify closes, so spans for in-flight requests make the final batch.
      .then(() => tracer.shutdown())
      .then(() => broker?.close())
      .then(() => pool.end())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}
