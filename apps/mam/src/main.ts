// MAM's container entrypoint.
//
// Run with plain `node`, no bundler and no tsx: Node 24 strips types natively, so the image ships
// the same source the tests run against.

import { migrate, openPool } from '@atlas/data-pg';
import { OutboxRelay } from '@atlas/messaging';
import { NatsBroker } from '@atlas/messaging-nats';
import { PgOutboxStore } from '@atlas/data-pg';
import { createLogger, HealthRegistry, loadConfig } from '@atlas/service-kit';
import { buildMamApp, mamMigrations, MamService, pgAssetStore } from './index.ts';
import { PolicyClient } from './policy-client.ts';

const config = loadConfig({
  port: { env: 'PORT', type: 'number', default: 3000 },
  host: { env: 'HOST', type: 'string', default: '0.0.0.0' },
  databaseUrl: { env: 'ATLAS_PG_URL', type: 'string', required: true },
  iamOrigin: { env: 'ATLAS_IAM_ORIGIN', type: 'string', default: 'http://iam:3000' },
  natsUrl: { env: 'ATLAS_NATS_URL', type: 'string', default: 'nats://nats:4222' },
  policyTtlMs: { env: 'ATLAS_POLICY_TTL_MS', type: 'number', default: 30_000 },
  relayIntervalMs: { env: 'ATLAS_RELAY_INTERVAL_MS', type: 'number', default: 1_000 },
});

const log = createLogger('mam');

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
 * failure, and a service that retries one of those forever is a service that never tells anyone it
 * is misconfigured. After the budget we exit and let the pod report CrashLoopBackOff, which is the
 * signal an operator actually looks for.
 */
async function migrateWithRetry(budgetMs = 120_000, intervalMs = 2_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (let attempt = 1; ; attempt++) {
    try {
      const { applied } = await migrate(pool, mamMigrations);
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

const store = pgAssetStore(pool);
const service = new MamService({ store });
const policies = new PolicyClient({ origin: config.iamOrigin, ttlMs: config.policyTtlMs });

const health = new HealthRegistry()
  .register(
    'postgres',
    async () => (await pool.query('SELECT 1').catch(() => null)) !== null,
    // Critical: without the database MAM can answer nothing, so reporting ready would only route
    // traffic into failures.
    { critical: true },
  )
  .register(
    'iam',
    async () => (await fetch(new URL('/healthz', config.iamOrigin)).catch(() => null))?.ok === true,
    // Critical: no policy means every request is 401 — ready would be a lie.
    { critical: true },
  );

const app = buildMamApp({
  service,
  policyFor: (userId) => policies.policyFor(userId),
  health,
  onError: (err, ctx) =>
    log.error('unhandled error', {
      ...ctx,
      error: (err as Error).message,
      stack: (err as Error).stack,
    }),
});

// --- the outbox relay -------------------------------------------------------
//
// In-process for now: one fewer deployable, and it drains the same database the domain transaction
// committed to. EP-03.7 pipelines it; a standalone relay is a later question.
//
// NOTE the broker is NOT a readiness check. With NATS down, writes still commit and their events
// accumulate in the outbox to be relayed when it returns — that is precisely what the outbox is
// for. Failing readiness here would take MAM out of service to protect an announcement, which
// inverts the priority: the catalogue is the critical path, the broadcast of it is not.

const outbox = new PgOutboxStore(pool);
let broker: NatsBroker | undefined;
let relayTimer: NodeJS.Timeout | undefined;

async function startRelay(): Promise<void> {
  try {
    broker = await NatsBroker.connect({ servers: config.natsUrl, service: 'mam' });
  } catch (err) {
    // Retry rather than exit. A broker that is slow to start would otherwise crash-loop MAM, and
    // MAM does not need the broker to serve requests.
    log.warn('broker unavailable, retrying', { error: (err as Error).message });
    relayTimer = setTimeout(() => void startRelay(), 5_000);
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
      log.error('relay drain failed', { error: (err as Error).message });
    }
    relayTimer = setTimeout(() => void tick(), config.relayIntervalMs);
  };
  void tick();
}

void startRelay();

await app.listen({ port: config.port, host: config.host });
log.info('mam listening', { port: config.port, host: config.host });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info(`${signal} received, draining`);
    if (relayTimer) clearTimeout(relayTimer);
    void app
      .close()
      .then(() => broker?.close())
      .then(() => pool.end())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}
