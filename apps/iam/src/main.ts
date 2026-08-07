// IAM's container entrypoint (EP-01.4).
//
// Run with plain `node`, no bundler and no tsx: Node 24 strips types natively, so the image ships
// the same source the tests run against. One fewer build artefact to keep honest.

import { createLogger, HealthRegistry, loadConfig } from '@atlas/service-kit';
import { buildIamApp, DEFAULT_LOCKOUT, IamService, KeyRing, seedStarterRoles } from './index.ts';

const config = loadConfig({
  port: { env: 'PORT', type: 'number', default: 3000 },
  host: { env: 'HOST', type: 'string', default: '0.0.0.0' },
  issuer: { env: 'ATLAS_ISSUER', type: 'string', default: 'atlas-iam' },
  audience: { env: 'ATLAS_AUDIENCE', type: 'string', default: 'atlas' },
  accessTokenTtl: { env: 'ATLAS_ACCESS_TOKEN_TTL', type: 'string', default: '15m' },
  // iam.md §11 calls these out as configuration, and a site with an unusual threat model will want
  // them. The defaults come from DEFAULT_LOCKOUT rather than being restated, so there is one place
  // that decides what "ten in fifteen minutes" means.
  lockoutThreshold: {
    env: 'ATLAS_LOCKOUT_THRESHOLD',
    type: 'number',
    default: DEFAULT_LOCKOUT.threshold,
  },
  lockoutWindowMs: {
    env: 'ATLAS_LOCKOUT_WINDOW_MS',
    type: 'number',
    default: DEFAULT_LOCKOUT.windowMs,
  },
  lockoutDurationMs: {
    env: 'ATLAS_LOCKOUT_DURATION_MS',
    type: 'number',
    default: DEFAULT_LOCKOUT.durationMs,
  },
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
  lockout: {
    threshold: config.lockoutThreshold,
    windowMs: config.lockoutWindowMs,
    durationMs: config.lockoutDurationMs,
  },
});

// Optional bootstrap account, and deliberately opt-in: it only happens when BOTH variables are
// set, so a production deployment that forgets to unset something cannot silently acquire a
// known-username account. IAM's store is in-memory today, so this runs on every start.
// The shipped role catalogue (EP-10.7, authorization-model.md §9). Inert until something is
// assigned to a subject — registering them only makes them available to assign.
log.info('starter roles registered', { added: seedStarterRoles(service.store.roles) });

const seedUser = process.env['ATLAS_SEED_USERNAME'];
const seedPassword = process.env['ATLAS_SEED_PASSWORD'];
if (seedUser && seedPassword) {
  const channelId = process.env['ATLAS_SEED_CHANNEL'] ?? 'ch12';
  const user = await service.createUser({ username: seedUser, password: seedPassword, channelId });

  // A grant, or the account can log in and do nothing. CHANNEL-SCOPED rather than an unscoped
  // assignment of the starter roles: the starter roles ship unscoped for an operator to narrow,
  // and a bootstrap account that could write in every channel is not a useful default even in
  // dev — it would also make cross-tenant refusal untestable in a deployed environment.
  service.store.assignments.push({
    userId: user.id,
    rule: {
      id: 'seed-grant',
      description: 'dev bootstrap: full asset lifecycle within the seeded channel',
      permissions: ['asset:read', 'asset:write', 'asset:approve', 'taxonomy:read'],
      scope: { channelIds: [channelId] },
    },
  });

  log.warn('seeded a bootstrap user from the environment — never do this in production', {
    username: seedUser,
    channelId,
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
