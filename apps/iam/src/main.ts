// IAM's container entrypoint (EP-01.4).
//
// Run with plain `node`, no bundler and no tsx: Node 24 strips types natively, so the image ships
// the same source the tests run against. One fewer build artefact to keep honest.

import { createLogger, HealthRegistry, loadConfig } from '@atlas/service-kit';
import { buildIamApp, IamService, KeyRing } from './index.ts';

const config = loadConfig({
  port: { env: 'PORT', type: 'number', default: 3000 },
  host: { env: 'HOST', type: 'string', default: '0.0.0.0' },
  issuer: { env: 'ATLAS_ISSUER', type: 'string', default: 'atlas-iam' },
  audience: { env: 'ATLAS_AUDIENCE', type: 'string', default: 'atlas' },
  accessTokenTtl: { env: 'ATLAS_ACCESS_TOKEN_TTL', type: 'string', default: '15m' },
});

const log = createLogger('iam');

// Generated per process for now. Production must load the ring from a secret so every replica
// signs with the SAME key — until that lands, a multi-replica IAM would reject its own tokens,
// which is why the dev manifest pins replicas to 1.
const keyRing = await KeyRing.create();

const health = new HealthRegistry();
const service = new IamService({
  keyRing,
  issuer: config.issuer,
  audience: config.audience,
  accessTokenTtl: config.accessTokenTtl,
});

// Optional bootstrap account, and deliberately opt-in: it only happens when BOTH variables are
// set, so a production deployment that forgets to unset something cannot silently acquire a
// known-username account. IAM's store is in-memory today, so this runs on every start.
const seedUser = process.env['ATLAS_SEED_USERNAME'];
const seedPassword = process.env['ATLAS_SEED_PASSWORD'];
if (seedUser && seedPassword) {
  await service.createUser({
    username: seedUser,
    password: seedPassword,
    channelId: process.env['ATLAS_SEED_CHANNEL'] ?? 'ch12',
  });
  log.warn('seeded a bootstrap user from the environment — never do this in production', {
    username: seedUser,
  });
}

const app = buildIamApp({ service, keyRing, health });

await app.listen({ port: config.port, host: config.host });
log.info('iam listening', { port: config.port, host: config.host });

// Kubernetes sends SIGTERM and waits terminationGracePeriodSeconds before SIGKILL. Closing
// Fastify lets in-flight requests finish; ignoring the signal drops requests on every rollout.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info(`${signal} received, draining`);
    void app.close().then(() => process.exit(0));
  });
}
