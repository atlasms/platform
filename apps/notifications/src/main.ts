// The Notifications service's container entrypoint.
//
// Run with plain `node`, no bundler and no tsx: Node 24 strips types natively, so the image ships
// the same source the tests run against — which is why nothing in this service's import graph may
// use syntax that EMITS (a constructor parameter property, an enum): AGENTS.md §6, and eslint.
//
// This file is the only one that reads the environment or touches real infrastructure. Everything
// it wires is injected into `buildNotificationsApp`, so the tests never see any of it.

import { migrate, openPool, PgOutboxStore } from '@atlas/data-pg';
import { OutboxRelay } from '@atlas/messaging';
import { NatsBroker } from '@atlas/messaging-nats';
import {
  createLogger,
  createTracer,
  HealthRegistry,
  internalKeys,
  loadConfig,
  MetricRegistry,
} from '@atlas/service-kit';
import {
  buildNotificationsApp,
  iamPrincipals,
  NotificationsService,
  pgInboxStore,
  pgMigrations,
  startConsumers,
  startPrincipalInvalidation,
  Messages,
  NotificationPipeline,
  TaskActions,
} from './index.ts';
import { PolicyClient } from '@atlas/policy/client';

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
  pgSchema: { env: 'ATLAS_PG_SCHEMA', type: 'string', default: 'notifications' },
  natsUrl: { env: 'ATLAS_NATS_URL', type: 'string', default: 'nats://nats:4222' },
  // The keys this service signs its question to IAM with (iam-read-keys; ADR-0008, EP-25.3): who a
  // user is as an addressee. The first signs. Unset, the inbox holds tasks offered by name only.
  iamReadKeys: { env: 'ATLAS_IAM_READ_KEYS', type: 'string', default: '' },
  // How long a caller's compiled policy is reused (EP-25.2's task actions are authorized with it).
  policyTtlMs: { env: 'ATLAS_POLICY_TTL_MS', type: 'number', default: 30_000 },
  relayIntervalMs: { env: 'ATLAS_RELAY_INTERVAL_MS', type: 'number', default: 250 },
  // EP-04.7 / ADR-0004. No endpoint means no export: spans are still created and `traceparent`
  // still propagates, so a site without a collector pays only the cost of an id.
  otlpEndpoint: { env: 'ATLAS_OTLP_ENDPOINT', type: 'string', default: '' },
  traceSampleRatio: { env: 'ATLAS_TRACE_SAMPLE_RATIO', type: 'number', default: 1 },
});

const log = createLogger('notifications');

const tracer = createTracer({
  service: 'notifications',
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
      // Every table carries channel_id (AGENTS.md §5.3); the outbox and the seen-mark are the
      // exceptions schema:check knows about.
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

const store = pgInboxStore(pool);
const readKey = internalKeys(config.iamReadKeys)[0];
const principals =
  readKey !== undefined ? iamPrincipals({ origin: config.iamOrigin, key: readKey }) : undefined;
if (!principals) log.warn('no iam-read-keys: inboxes hold tasks offered by name only');
const policies = new PolicyClient({ origin: config.iamOrigin, ttlMs: config.policyTtlMs });
const service = new NotificationsService({
  store,
  // EP-25.5: an alert reaches whoever holds ops:read — by their own policy, when they read.
  policyFor: (userId) => policies.policyFor(userId),
  ...(principals ? { principals } : {}),
  onPrincipalsUnavailable: (err, userId) =>
    log.warn('principals unavailable; inbox partial', { userId, error: (err as Error).message }),
});

const tasks = new TaskActions({ store, ...(principals ? { principals } : {}) });
// EP-25.5: every recipient re-checked against their own policy, from IAM, before they are told.
const pipeline = new NotificationPipeline({
  store,
  policyFor: (userId) => policies.policyFor(userId),
  ...(principals ? { principals } : {}),
});
const messages = new Messages({
  store,
  ...(principals ? { principals } : {}),
  onPrincipalsUnavailable: (err, userId) =>
    log.warn('principals unavailable: messages to groups left out', {
      userId,
      error: (err as Error).message,
    }),
});

const app = await buildNotificationsApp({
  service,
  tasks,
  messages,
  pipeline,
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
    broker = await NatsBroker.connect({ servers: config.natsUrl, service: 'notifications' });
  } catch (err) {
    // Retry rather than exit. A broker that is slow to start would otherwise crash-loop this
    // service, and it does not need the broker to serve requests.
    log.warn('broker unavailable, retrying', { error: (err as Error).message });
    retryTimer = setTimeout(() => void startBroker(), 5_000);
    return;
  }

  // EP-25.3: a user's grants or memberships changed — forget who they were as an addressee.
  if (principals) startPrincipalInvalidation({ broker, principals });

  // EP-25.1: workflow tasks and lapsed approvals become inbox items.
  startConsumers({
    broker,
    service,
    pipeline,
    onOutcome: (subject, outcome) => log.info('event consumed', { subject, outcome }),
    onError: (err, msg) =>
      log.warn('event refused', {
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
log.info('notifications listening', { port: config.port, host: config.host });

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
