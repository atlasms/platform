// The Bms service's container entrypoint.
//
// Run with plain `node`, no bundler and no tsx: Node 24 strips types natively, so the image ships
// the same source the tests run against — which is why nothing in this service's import graph may
// use syntax that EMITS (a constructor parameter property, an enum): AGENTS.md §6, and eslint.
//
// This file is the only one that reads the environment or touches real infrastructure. Everything
// it wires is injected into `buildBmsApp`, so the tests never see any of it.

import { migrate, openPool, PgOutboxStore } from '@atlas/data-pg';
import { OutboxRelay } from '@atlas/messaging';
import { NatsBroker } from '@atlas/messaging-nats';
import { PolicyClient } from '@atlas/policy/client';
import {
  createLogger,
  createTracer,
  currentTraceparent,
  HealthRegistry,
  loadConfig,
  MetricRegistry,
} from '@atlas/service-kit';
import {
  BmsRuntime,
  BmsService,
  buildBmsApp,
  pgMigrations,
  pgWorkflowStore,
  type InstanceRunner,
} from './index.ts';
import { CompletionRouter, startCompletionRouter } from './router.ts';
import { EVENT_BUFFER_DAYS } from './instance.ts';
import { TriggerStarter, triggerPatterns } from './trigger.ts';
import { connectTemporal, type TemporalRuntime } from './temporal/runner.ts';

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
  pgSchema: { env: 'ATLAS_PG_SCHEMA', type: 'string', default: 'bms' },
  natsUrl: { env: 'ATLAS_NATS_URL', type: 'string', default: 'nats://nats:4222' },
  relayIntervalMs: { env: 'ATLAS_RELAY_INTERVAL_MS', type: 'number', default: 250 },
  policyTtlMs: { env: 'ATLAS_POLICY_TTL_MS', type: 'number', default: 30_000 },
  // ADR-0010: the workflow runtime. Only BMS is given this address — Temporal's frontend has no
  // authentication of its own (runbook §5.1).
  temporalAddress: { env: 'ATLAS_TEMPORAL_ADDRESS', type: 'string', default: 'temporal:7233' },
  temporalNamespace: { env: 'ATLAS_TEMPORAL_NAMESPACE', type: 'string', default: 'atlas' },
  // EP-04.7 / ADR-0004. No endpoint means no export: spans are still created and `traceparent`
  // still propagates, so a site without a collector pays only the cost of an id.
  otlpEndpoint: { env: 'ATLAS_OTLP_ENDPOINT', type: 'string', default: '' },
  traceSampleRatio: { env: 'ATLAS_TRACE_SAMPLE_RATIO', type: 'number', default: 1 },
});

const log = createLogger('bms');

const tracer = createTracer({
  service: 'bms',
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
  // NOT critical: authoring definitions needs no runtime, so BMS stays in service without it —
  // starting an instance answers 503 until it is back. Reported, so an operator sees which.
  .register('temporal', async () => (temporal ? await temporal.healthy() : false));

// --- the workflow runtime (ADR-0010) -------------------------------------------------------------
//
// Connected in the background and retried, like the broker: a Temporal that is slow to start must
// not crash-loop the service that authors definitions. Once connected, the worker runs every
// instance from here; if it dies, the process exits and Kubernetes restarts it — an instance never
// waits on a worker that is not polling.
const store = pgWorkflowStore(pool);
const runtime = new BmsRuntime({ store });
let temporal: TemporalRuntime | undefined;
let temporalTimer: NodeJS.Timeout | undefined;

const runner: InstanceRunner = {
  start: async (input) => {
    if (!temporal) throw new Error('the workflow runtime is not connected yet');
    await temporal.runner.start(input);
  },
  signal: async (instanceId, signal) => {
    if (!temporal) throw new Error('the workflow runtime is not connected yet');
    await temporal.runner.signal(instanceId, signal);
  },
};

async function startTemporal(): Promise<void> {
  try {
    temporal = await connectTemporal({
      address: config.temporalAddress,
      namespace: config.temporalNamespace,
      runtime,
      log: (message, fields) => log.info(message, fields ?? {}),
    });
  } catch (err) {
    log.warn('temporal unavailable, retrying', {
      address: config.temporalAddress,
      error: (err as Error).message,
    });
    temporalTimer = setTimeout(() => void startTemporal(), 5_000);
    return;
  }
  temporal.run().then(
    () => log.info('temporal worker stopped'),
    (err: unknown) => {
      log.error('temporal worker failed', { error: (err as Error).message });
      process.exit(1);
    },
  );
}

const service = new BmsService({
  store,
  runner,
  onRunnerError: (err, ctx) =>
    log.warn('workflow runtime refused', { ...ctx, error: (err as Error).message }),
  // The trace context is captured where the event is CREATED, inside the request (EP-13.3): the
  // relay publishes later on a timer with no ambient context at all.
  traceHeaders: () => {
    const traceparent = currentTraceparent();
    return traceparent ? { traceparent } : undefined;
  },
});
const policies = new PolicyClient({ origin: config.iamOrigin, ttlMs: config.policyTtlMs });

const app = await buildBmsApp({
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
    broker = await NatsBroker.connect({ servers: config.natsUrl, service: 'bms' });
  } catch (err) {
    // Retry rather than exit. A broker that is slow to start would otherwise crash-loop this
    // service, and it does not need the broker to serve requests.
    log.warn('broker unavailable, retrying', { error: (err as Error).message });
    retryTimer = setTimeout(() => void startBroker(), 5_000);
    return;
  }

  // EP-22.4: the answers to the commands command steps issued, delivered to the waiting step. A
  // runtime that is not connected yet throws, and the broker redelivers.
  startCompletionRouter({
    broker,
    router: new CompletionRouter({ store, runner }),
    onOutcome: (subject, outcome) => {
      if (outcome !== 'ignored') log.info('command answer routed', { subject, outcome });
    },
    onError: (err, msg) =>
      log.warn('command answer not routed', {
        subject: msg.subject,
        messageId: msg.id,
        error: (err as Error).message,
      }),
  });

  // EP-22.7: an event that starts workflows — every matching active one of its channel, once.
  const triggers = new TriggerStarter({ store, service, runner });
  for (const pattern of triggerPatterns())
    broker.subscribe(
      pattern,
      async (msg) => {
        try {
          const outcome = await triggers.handle(msg);
          if (outcome.started.length > 0 || outcome.filtered.length > 0)
            log.info('trigger handled', { subject: msg.subject, ...outcome });
        } catch (err) {
          log.warn('trigger not handled', {
            subject: msg.subject,
            messageId: msg.id,
            error: (err as Error).message,
          });
          throw err; // the broker redelivers: the runtime away, or the store
        }
      },
      { maxAttempts: 10 },
    );

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
void startTemporal();

// EP-22.7: the waitable events are kept EVENT_BUFFER_DAYS for a step that has not started waiting
// yet; older ones are forgotten hourly. Any replica may prune — the DELETE is the same either way.
const pruneTimer = setInterval(() => {
  const before = new Date(Date.now() - EVENT_BUFFER_DAYS * 86_400_000).toISOString();
  store
    .transaction((tx) => tx.pruneEventBuffer(before))
    .then((n) => {
      if (n > 0) log.info('event buffer pruned', { count: n });
    })
    .catch((err: unknown) =>
      log.warn('event buffer prune failed', { error: (err as Error).message }),
    );
}, 3_600_000);
pruneTimer.unref();

await app.listen({ port: config.port, host: config.host });
log.info('bms listening', { port: config.port, host: config.host });

// Kubernetes stops routing and sends SIGTERM at the same moment, so a request already in flight
// can still arrive; draining Fastify is what stops every rollout dropping requests. The manifest's
// terminationGracePeriodSeconds gives this 30s.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info(`${signal} received, draining`);
    if (retryTimer) clearTimeout(retryTimer);
    if (temporalTimer) clearTimeout(temporalTimer);
    void app
      .close()
      // The worker finishes the activities it holds before the pool closes under them.
      .then(() => temporal?.shutdown())
      // After Fastify closes, so spans for in-flight requests make the final batch.
      .then(() => tracer.shutdown())
      .then(() => broker?.close())
      .then(() => pool.end())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}
