// The gateway's container entrypoint (EP-01.4).

import { createLogger, HealthRegistry, loadConfig, remoteJwks } from '@atlas/service-kit';
import { buildGateway } from './index.ts';
import type { RoutingTable } from './routing.ts';

const config = loadConfig({
  port: { env: 'PORT', type: 'number', default: 8080 },
  host: { env: 'HOST', type: 'string', default: '0.0.0.0' },
  issuer: { env: 'ATLAS_ISSUER', type: 'string', default: 'atlas-iam' },
  audience: { env: 'ATLAS_AUDIENCE', type: 'string', default: 'atlas' },
  iamOrigin: { env: 'ATLAS_IAM_ORIGIN', type: 'string', default: 'http://iam:3000' },
  mamOrigin: { env: 'ATLAS_MAM_ORIGIN', type: 'string', default: 'http://mam:3000' },
  jwksPath: { env: 'ATLAS_JWKS_PATH', type: 'string', default: '/.well-known/jwks.json' },
});

const log = createLogger('api-gateway');

/**
 * Verification keys come from IAM's JWKS endpoint, fetched and cached by `jose` — the gateway
 * never calls IAM per request. Remote rather than baked into config so a key rotation propagates
 * without redeploying the gateway.
 */
const jwks = remoteJwks(new URL(config.jwksPath, config.iamOrigin));

const routes: RoutingTable = [
  // Public: obtaining a token cannot itself require one.
  { service: 'iam', origin: config.iamOrigin, prefix: '/auth', public: true },
  // Protected: the gateway verifies the token against IAM's JWKS and forwards the established
  // identity as internal headers. IAM re-authorizes — the gateway authenticates, it does not
  // authorize.
  { service: 'iam', origin: config.iamOrigin, prefix: '/api/v1/users' },
  // MAM. The gateway adds no domain endpoints of its own — it verifies the token, forwards the
  // established identity as internal headers, and MAM re-authorizes with its own resource context.
  { service: 'mam', origin: config.mamOrigin, prefix: '/api/v1/assets' },
];

const health = new HealthRegistry().register(
  'iam',
  async () => (await fetch(new URL('/healthz', config.iamOrigin)).catch(() => null))?.ok === true,
  // Critical: with IAM unreachable the gateway cannot verify a single token, so reporting ready
  // would just route traffic into failures.
  { critical: true },
);

const app = buildGateway({
  jwks,
  routes,
  issuer: config.issuer,
  audience: config.audience,
  health,
  onAccessLog: (record) => log.info('access', { ...record }),
});

await app.listen({ port: config.port, host: config.host });
log.info('api-gateway listening', { port: config.port, host: config.host });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info(`${signal} received, draining`);
    void app.close().then(() => process.exit(0));
  });
}
