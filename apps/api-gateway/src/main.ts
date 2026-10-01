// The gateway's container entrypoint (EP-01.4).

import {
  createTracer,
  createLogger,
  HealthRegistry,
  loadConfig,
  remoteJwks,
} from '@atlas/service-kit';
import { buildGateway } from './index.ts';
import { productionRoutes } from './routing.ts';

const config = loadConfig({
  port: { env: 'PORT', type: 'number', default: 8080 },
  host: { env: 'HOST', type: 'string', default: '0.0.0.0' },
  issuer: { env: 'ATLAS_ISSUER', type: 'string', default: 'atlas-iam' },
  audience: { env: 'ATLAS_AUDIENCE', type: 'string', default: 'atlas' },
  iamOrigin: { env: 'ATLAS_IAM_ORIGIN', type: 'string', default: 'http://iam:3000' },
  mamOrigin: { env: 'ATLAS_MAM_ORIGIN', type: 'string', default: 'http://mam:3000' },
  loggingOrigin: { env: 'ATLAS_LOGGING_ORIGIN', type: 'string', default: 'http://logging:3000' },
  rimOrigin: { env: 'ATLAS_RIM_ORIGIN', type: 'string', default: 'http://rim:3000' },
  mtsOrigin: { env: 'ATLAS_MTS_ORIGIN', type: 'string', default: 'http://mts:3000' },
  hsmOrigin: { env: 'ATLAS_HSM_ORIGIN', type: 'string', default: 'http://hsm:3000' },
  // A part of a chunked upload (EP-15.1) is 8 MiB by default (RIM's ATLAS_UPLOAD_PART_BYTES);
  // the gateway must let one through on the upload prefix without raising its cap everywhere.
  uploadBodyLimit: {
    env: 'ATLAS_UPLOAD_BODY_LIMIT_BYTES',
    type: 'number',
    default: 8 * 1024 * 1024,
  },
  schedulingOrigin: {
    env: 'ATLAS_SCHEDULING_ORIGIN',
    type: 'string',
    default: 'http://scheduling:3000',
  },
  jwksPath: { env: 'ATLAS_JWKS_PATH', type: 'string', default: '/.well-known/jwks.json' },
  // EP-08.3. api-gateway.md §11 makes these per-deployment configuration; the defaults live in
  // app.ts and are sized for a facility behind one NAT rather than for one browser.
  rateLimit: { env: 'ATLAS_RATE_LIMIT', type: 'number', default: 600 },
  rateLimitWindowMs: { env: 'ATLAS_RATE_LIMIT_WINDOW_MS', type: 'number', default: 60_000 },
  principalRateLimit: { env: 'ATLAS_PRINCIPAL_RATE_LIMIT', type: 'number', default: 300 },
  bodyLimit: { env: 'ATLAS_BODY_LIMIT_BYTES', type: 'number', default: 1024 * 1024 },
  // Off unless a proxy that OVERWRITES x-forwarded-for is in front. With the gateway exposed
  // directly, honouring the header lets a client choose its own rate-limit key — see rate-limit.ts.
  trustProxy: { env: 'ATLAS_TRUST_PROXY', type: 'boolean', default: false },
  // EP-04.7 / ADR-0004. No endpoint means no export: spans are still created and `traceparent`
  // still propagates, so a site without a collector pays only the cost of an id and its traces are
  // already joined up the day one appears.
  otlpEndpoint: { env: 'ATLAS_OTLP_ENDPOINT', type: 'string', default: '' },
  traceSampleRatio: { env: 'ATLAS_TRACE_SAMPLE_RATIO', type: 'number', default: 1 },
});

const log = createLogger('api-gateway');

const tracer = createTracer({
  service: 'api-gateway',
  ...(config.otlpEndpoint !== '' ? { endpoint: config.otlpEndpoint } : {}),
  sampleRatio: config.traceSampleRatio,
});

/**
 * Verification keys come from IAM's JWKS endpoint, fetched and cached by `jose` — the gateway
 * never calls IAM per request. Remote rather than baked into config so a key rotation propagates
 * without redeploying the gateway.
 */
const jwks = remoteJwks(new URL(config.jwksPath, config.iamOrigin));

const routes = productionRoutes({
  iam: config.iamOrigin,
  mam: config.mamOrigin,
  logging: config.loggingOrigin,
  scheduling: config.schedulingOrigin,
  rim: config.rimOrigin,
  mts: config.mtsOrigin,
  hsm: config.hsmOrigin,
  uploadBodyLimit: config.uploadBodyLimit,
});

// The table is `productionRoutes` in routing.ts — data, held by test/routes.test.ts to every path
// the deployed services' contracts declare. `defaultRoutes` there is a test fixture; a route added
// only to it is one the deployed gateway has never heard of.

const health = new HealthRegistry().register(
  'iam',
  async () => (await fetch(new URL('/healthz', config.iamOrigin)).catch(() => null))?.ok === true,
  // Critical: with IAM unreachable the gateway cannot verify a single token, so reporting ready
  // would just route traffic into failures.
  { critical: true },
);

// Services that own reference data (EP-08.5). Only MAM does so far; each entry is added when a
// service starts serving `GET /reference`, and a service that does not is simply absent — the
// aggregate is the union of what exists, not a list of what is planned.
const referenceSources = [
  { service: 'mam', url: new URL('/api/v1/reference', config.mamOrigin).toString() },
];

const app = buildGateway({
  jwks,
  routes,
  referenceSources,
  issuer: config.issuer,
  audience: config.audience,
  health,
  rateLimit: { limit: config.rateLimit, windowMs: config.rateLimitWindowMs },
  principalRateLimit: { limit: config.principalRateLimit, windowMs: config.rateLimitWindowMs },
  bodyLimit: config.bodyLimit,
  trustProxy: config.trustProxy,
  tracer,
  onAccessLog: (record) => log.info('access', { ...record }),
});

// The limits are PER REPLICA, and infra/k8s/base/api-gateway.yaml runs two — so the deployment
// tolerates 2× what is configured here. Stated at startup rather than buried in a README, because
// an operator who sets 600 and observes 1200 should find the explanation without reading source.
// A cluster-wide limit needs a shared counter (Redis or equivalent), which is new infrastructure
// and an ADR, not a config change.
log.info('rate limits are per replica', {
  addressLimit: config.rateLimit,
  principalLimit: config.principalRateLimit,
  windowMs: config.rateLimitWindowMs,
  trustProxy: config.trustProxy,
});

await app.listen({ port: config.port, host: config.host });
log.info('api-gateway listening', { port: config.port, host: config.host });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info(`${signal} received, draining`);
    // Flush AFTER Fastify closes, so spans for the requests that were still in flight are in the
    // batch. Those are the ones most worth keeping — they may be why the pod is being restarted.
    void app
      .close()
      .then(() => tracer.shutdown())
      .then(() => process.exit(0));
  });
}
