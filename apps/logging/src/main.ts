// The Logging service's container entrypoint.
//
// Run with plain `node`, no bundler and no tsx: Node 24 strips types natively, so the image ships
// the same source the tests run against — which is why nothing in this service's import graph may
// use syntax that EMITS (a constructor parameter property, an enum): AGENTS.md §6, and eslint.
//
// This file is the only one that reads the environment or touches real infrastructure. Everything
// it wires is injected into `buildLoggingApp`, so the tests never see any of it.

import { migrate, openPool } from '@atlas/data-pg';
import { NatsBroker } from '@atlas/messaging-nats';
import { PolicyClient } from '@atlas/policy/client';
import {
  createLogger,
  createTracer,
  HealthRegistry,
  loadConfig,
  MetricRegistry,
} from '@atlas/service-kit';
import { buildLoggingApp, pgAuditStore, pgMigrations, startSink } from './index.ts';

const config = loadConfig({
  port: { env: 'PORT', type: 'number', default: 3000 },
  host: { env: 'HOST', type: 'string', default: '0.0.0.0' },
  iamOrigin: { env: 'ATLAS_IAM_ORIGIN', type: 'string', default: 'http://iam:3000' },
  databaseUrl: {
    env: 'ATLAS_PG_URL',
    type: 'string',
    default: 'postgres://atlas:atlas@postgres:5432/atlas',
  },
  natsUrl: { env: 'ATLAS_NATS_URL', type: 'string', default: 'nats://nats:4222' },
  policyTtlMs: { env: 'ATLAS_POLICY_TTL_MS', type: 'number', default: 30_000 },
  // EP-04.7 / ADR-0004. No endpoint means no export: spans are still created and `traceparent`
  // still propagates, so a site without a collector pays only the cost of an id.
  otlpEndpoint: { env: 'ATLAS_OTLP_ENDPOINT', type: 'string', default: '' },
  traceSampleRatio: { env: 'ATLAS_TRACE_SAMPLE_RATIO', type: 'number', default: 1 },
});

const log = createLogger('logging');

const tracer = createTracer({
  service: 'logging',
  ...(config.otlpEndpoint !== '' ? { endpoint: config.otlpEndpoint } : {}),
  sampleRatio: config.traceSampleRatio,
});

const metrics = new MetricRegistry();

const pool = openPool({ connectionString: config.databaseUrl });

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
      // The seen table (EP-03.3), the append-only log and the history projection. Every row is
      // channel-scoped; the log is hash-chained per channel.
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

const store = pgAuditStore(pool);
const policies = new PolicyClient({ origin: config.iamOrigin, ttlMs: config.policyTtlMs });

const sunk = metrics.counter({
  name: 'atlas_audit_events_appended_total',
  help: 'Envelopes appended to the audit log.',
  labelNames: ['service'],
});
const duplicates = metrics.counter({
  name: 'atlas_audit_events_duplicate_total',
  help: 'Redeliveries that were already in the log — at-least-once, exactly-once appended.',
  labelNames: ['service'],
});
const refused = metrics.counter({
  name: 'atlas_audit_events_refused_total',
  help: 'Messages the sink threw on: not an envelope, or an audit record failing its schema. They dead-letter.',
  labelNames: ['service'],
});

const app = await buildLoggingApp({
  store,
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

// --- the broker: the sink ---------------------------------------------------------------------------
//
// NOT a readiness check. With NATS down this service still answers history reads from what it has;
// what it has not yet seen waits in the stream — JetStream retains it, and the durable consumer
// resumes where it left off. Failing readiness here would take the read surface out of service to
// protect the ingest, which inverts the priority.

let broker: NatsBroker | undefined;
let retryTimer: NodeJS.Timeout | undefined;

async function startBroker(): Promise<void> {
  try {
    broker = await NatsBroker.connect({ servers: config.natsUrl, service: 'logging' });
  } catch (err) {
    log.warn('broker unavailable, retrying', { error: (err as Error).message });
    retryTimer = setTimeout(() => void startBroker(), 5_000);
    return;
  }

  // One durable per (service, pattern): `logging` + `atlas.>`. The websocket service subscribes to
  // the same pattern under ITS durable, so both see every message — a shared durable would split
  // the stream between them (AGENTS.md §6).
  startSink({
    broker,
    store,
    onAppended: () => sunk.inc({ service: 'logging' }),
    onDuplicate: () => duplicates.inc({ service: 'logging' }),
    onError: (err, msg) => {
      refused.inc({ service: 'logging' });
      log.error('message refused by the sink', {
        subject: msg.subject,
        messageId: msg.id,
        error: (err as Error).message,
      });
    },
  });
  log.info('audit sink started', { patterns: 'atlas.>' });
}

void startBroker();

await app.listen({ port: config.port, host: config.host });
log.info('logging listening', { port: config.port, host: config.host });

// Kubernetes stops routing and sends SIGTERM at the same moment, so a request already in flight
// can still arrive; draining Fastify is what stops every rollout dropping requests. The manifest's
// terminationGracePeriodSeconds gives this 30s.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info(`${signal} received, draining`);
    if (retryTimer) clearTimeout(retryTimer);
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
