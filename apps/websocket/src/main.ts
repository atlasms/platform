// The WebSocket service's container entrypoint (EP-13.2).
//
// Run with plain `node`, no bundler and no tsx: Node 24 strips types natively, so the image ships
// the same source the tests run against.
//
// This is the last hop of the walking skeleton. Everything before it already works — a write goes
// through MAM's outbox, the relay publishes it to JetStream, and the bridge has been able to fan a
// message out to eligible connections since EP-09.3. What did not exist was a connection: the
// registry had no server in front of it, so `apps/websocket` was a library nothing ran.

import { NatsBroker } from '@atlas/messaging-nats';
import { PolicyClient } from '@atlas/policy/client';
import {
  createLogger,
  createTracer,
  HealthRegistry,
  loadConfig,
  MetricRegistry,
  remoteJwks,
} from '@atlas/service-kit';
import { buildWebsocketApp, ConnectionRegistry, startBridge } from './index.ts';

const config = loadConfig({
  port: { env: 'PORT', type: 'number', default: 3000 },
  host: { env: 'HOST', type: 'string', default: '0.0.0.0' },
  iamOrigin: { env: 'ATLAS_IAM_ORIGIN', type: 'string', default: 'http://iam:3000' },
  jwksPath: { env: 'ATLAS_JWKS_PATH', type: 'string', default: '/.well-known/jwks.json' },
  issuer: { env: 'ATLAS_ISSUER', type: 'string', default: 'atlas-iam' },
  audience: { env: 'ATLAS_AUDIENCE', type: 'string', default: 'atlas' },
  natsUrl: { env: 'ATLAS_NATS_URL', type: 'string', default: 'nats://nats:4222' },
  policyTtlMs: { env: 'ATLAS_POLICY_TTL_MS', type: 'number', default: 30_000 },
  // websocket.md §11 calls the heartbeat out as configuration. It is the only thing that
  // distinguishes an idle client from a half-open TCP connection at this layer.
  heartbeatIntervalMs: { env: 'ATLAS_WS_HEARTBEAT_MS', type: 'number', default: 30_000 },
  // EP-04.7 / ADR-0004. No endpoint means no export: spans are still created and `traceparent`
  // still propagates, so a site without a collector pays only the cost of an id.
  otlpEndpoint: { env: 'ATLAS_OTLP_ENDPOINT', type: 'string', default: '' },
  traceSampleRatio: { env: 'ATLAS_TRACE_SAMPLE_RATIO', type: 'number', default: 1 },
});

const log = createLogger('websocket');

const tracer = createTracer({
  service: 'websocket',
  ...(config.otlpEndpoint !== '' ? { endpoint: config.otlpEndpoint } : {}),
  sampleRatio: config.traceSampleRatio,
});

const registry = new ConnectionRegistry();
const policies = new PolicyClient({ origin: config.iamOrigin, ttlMs: config.policyTtlMs });
const jwks = remoteJwks(new URL(config.jwksPath, config.iamOrigin));

// Shared with the app so the bridge's delivery counters land in the same exposition as its HTTP
// ones. Labelled by SERVICE only — never by subject: a subject carries the channel id, so a label
// on it is one time series per tenant per action, which is the cardinality trap #205 already
// closed once for auth metrics.
const metrics = new MetricRegistry();
const bridged = metrics.counter({
  name: 'atlas_ws_events_bridged_total',
  help: 'Messages taken off the broker and offered to the registry.',
  labelNames: ['service'],
});
const delivered = metrics.counter({
  name: 'atlas_ws_events_delivered_total',
  help: 'Event frames actually written to a connection. Divided by bridged, the fan-out ratio.',
  labelNames: ['service'],
});

const health = new HealthRegistry().register(
  'iam',
  async () => (await fetch(new URL('/healthz', config.iamOrigin)).catch(() => null))?.ok === true,
  // Critical: without IAM no token can be verified and no policy resolved, so every upgrade is a
  // 401. Reporting ready would only route connection attempts into refusals.
  { critical: true },
);

const app = await buildWebsocketApp({
  registry,
  jwks,
  policyFor: (userId) => policies.policyFor(userId),
  issuer: config.issuer,
  audience: config.audience,
  health,
  metrics,
  heartbeatIntervalMs: config.heartbeatIntervalMs,
  onConnectionLog: (record) => log.info('connection', { ...record }),
  onError: (err, ctx) =>
    log.error('unhandled error', {
      ...ctx,
      error: (err as Error).message,
      stack: (err as Error).stack,
    }),
});

// --- the broker bridge ------------------------------------------------------
//
// NOT a readiness check, on the same reasoning MAM applies to its relay. With NATS down the service
// still accepts connections and still answers subscribes; what stops is live delivery, and Studio's
// panels already reconcile by refetching. Failing readiness would take the socket out of service to
// protect the broadcast, which inverts the priority.

let broker: NatsBroker | undefined;
let retry: NodeJS.Timeout | undefined;

async function startBroker(): Promise<void> {
  try {
    broker = await NatsBroker.connect({ servers: config.natsUrl, service: 'websocket' });
  } catch (err) {
    log.warn('broker unavailable, retrying', { error: (err as Error).message });
    retry = setTimeout(() => void startBroker(), 5_000);
    return;
  }

  startBridge({
    broker,
    registry,
    tracer,
    onDelivered: (_subject, count) => {
      bridged.inc({ service: 'websocket' });
      if (count > 0) delivered.inc({ service: 'websocket' }, count);
    },
    /**
     * A revoked grant has to reach an OPEN socket (websocket.md §6.3).
     *
     * The cached policy is dropped FIRST and then refetched, because the point of the event is
     * that what we hold is stale — reading through the cache here would re-apply exactly the
     * policy the revocation was announcing the end of.
     */
    onPermissionsChanged: async (userId) => {
      policies.invalidate(userId);
      const policy = await policies.policyFor(userId);
      if (!policy) {
        // IAM cannot say what this user may now do. Closing their connections is the only safe
        // answer: keeping them open would keep delivering under the grants we already know are
        // out of date, which is the failure this event exists to prevent.
        const closed = registry.disconnectUser(userId, 'permissions changed');
        log.warn('policy unavailable after permissions.changed; closed connections', {
          userId,
          closed,
        });
        return;
      }
      const { dropped } = registry.applyPolicyChange(userId, policy);
      if (dropped.length > 0) log.info('subscriptions dropped', { userId, dropped });
    },
  });

  log.info('bridge started', { patterns: 'atlas.>, user.>' });
}

void startBroker();

await app.listen({ port: config.port, host: config.host });
log.info('websocket listening', { port: config.port, host: config.host });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info(`${signal} received, draining`);
    if (retry) clearTimeout(retry);
    void app
      .close()
      // After Fastify closes, so spans for in-flight upgrades make the final batch, and before the
      // broker so a slow collector cannot hold that connection open.
      .then(() => tracer.shutdown())
      .then(() => broker?.close())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}
