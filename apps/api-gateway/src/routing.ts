// Path -> owning service. Deliberately data, not code: the routing table is the one thing that
// changes every time a service ships, and it should not require editing request handling.
//
// Spec: docs/architecture/services/api-gateway.md §4 — the gateway exposes every service's public
// API under one host and adds no domain endpoints of its own.

import type { RateLimitPolicy } from './rate-limit.ts';

export interface RouteTarget {
  /** Service name, used in logs and metrics. */
  service: string;
  /** Base URL of the upstream, e.g. "http://mam:3000". */
  origin: string;
  /** Requests to this prefix are proxied. */
  prefix: string;
  /**
   * The path must also END with this — for a resource one service owns inside another's prefix:
   * `/api/v1/assets/{id}/location` is HSM's (ADR-0009) while the rest of `/api/v1/assets` is MAM's.
   * A matching suffix route beats every prefix-only route; the path is split on `/`, so `/location`
   * never matches `/relocation`.
   */
  suffix?: string;
  /** When true the route is reachable without an access token (login, JWKS). */
  public?: boolean;
  /**
   * Per-route source-address policy, overriding the gateway default (api-gateway.md §11).
   *
   * Left unset on `/auth` ON PURPOSE. Tightening the login route is the obvious move and the wrong
   * one here: a facility shares one public address, so a limit strict enough to matter against
   * password guessing locks out the building at shift change. IAM's per-account lockout (#240) is
   * the mechanism for that. An operator whose clients have distinct addresses can set it.
   */
  rateLimit?: RateLimitPolicy;
  /**
   * A body cap for this prefix, overriding the gateway's default (1 MiB). The upload prefix is
   * the reason it exists: a chunked upload's parts are the one body larger than the JSON cap, and
   * raising the cap everywhere to admit them would hand every JSON route the same slack.
   */
  bodyLimit?: number;
}

export type RoutingTable = RouteTarget[];

/**
 * Longest-prefix match, so `/api/v1/assets/{id}/versions` and `/api/v1/assets` can be owned by
 * different services if they ever diverge, and the more specific entry always wins regardless
 * of declaration order.
 */
export function matchRoute(table: RoutingTable, path: string): RouteTarget | undefined {
  let best: RouteTarget | undefined;
  const rank = (r: RouteTarget): [number, number] => [r.suffix ? 1 : 0, r.prefix.length];
  for (const route of table) {
    if (!path.startsWith(route.prefix)) continue;
    if (route.suffix !== undefined) {
      const suffix = route.suffix.startsWith('/') ? route.suffix : `/${route.suffix}`;
      if (!path.endsWith(suffix) || path.length <= route.prefix.length + suffix.length) continue;
    }
    if (!best) {
      best = route;
      continue;
    }
    const [s1, p1] = rank(route);
    const [s0, p0] = rank(best);
    if (s1 > s0 || (s1 === s0 && p1 > p0)) best = route;
  }
  return best;
}

/** Where each deployed service listens — `main.ts` reads these from config. */
export interface ProductionOrigins {
  iam: string;
  mam: string;
  logging: string;
  scheduling: string;
  rim: string;
  mts: string;
  hsm: string;
  /** The upload prefix's body cap (a chunked upload's part; EP-15.1). */
  uploadBodyLimit: number;
}

/**
 * THE production routing table: every path the deployed services' contracts declare, to the
 * service that owns it. Held to the contracts by test/routes.test.ts — a path in `mam.yaml` that no
 * route reaches is a test failure here, not a 404 a person finds in Studio.
 *
 * That is not hypothetical. Until EP-21.1 this table lived inline in `main.ts`, written by hand one
 * service at a time, and it had no route for `/api/v1/search`, `/api/v1/tags` or
 * `/api/v1/field-schemas` — MAM served all three, Studio's Search panel, tag cloud and asset
 * editor called them, every unit test was green, and the deployed gateway answered `no route`.
 * Found by the MVP acceptance journey searching for the asset it had just ingested.
 *
 * A path a contract declares and its service does not serve yet is routed all the same: the owner
 * answers its own 404, and the day it ships nothing here has to remember it.
 */
export function productionRoutes(o: ProductionOrigins): RoutingTable {
  const to = (service: keyof Omit<ProductionOrigins, 'uploadBodyLimit'>, prefixes: string[]) =>
    prefixes.map((prefix): RouteTarget => ({ service, origin: o[service], prefix }));
  return [
    // Public: obtaining a token cannot itself require one.
    { service: 'iam', origin: o.iam, prefix: '/auth', public: true },
    // Protected: the gateway verifies the token against IAM's JWKS and forwards the established
    // identity as internal headers. Every service re-authorizes — the gateway authenticates, it
    // does not authorize.
    ...to('iam', ['/api/v1/users', '/api/v1/groups', '/api/v1/roles']),
    // MAM: the catalogue. `/api/v1/reference` is NOT here — the gateway serves that itself, the
    // aggregate of every owner's reference data (EP-08.5).
    ...to('mam', [
      '/api/v1/assets',
      '/api/v1/search',
      '/api/v1/tags',
      '/api/v1/field-schemas',
      '/api/v1/categories',
      '/api/v1/subjects',
      '/api/v1/people',
      '/api/v1/vocabularies',
      '/api/v1/edit-projects',
      '/api/v1/settings',
    ]),
    // Logging (EP-19): the audit history, the log browse, retention; reports and visibility rules
    // are its later stories.
    ...to('logging', [
      '/api/v1/history',
      '/api/v1/logs',
      '/api/v1/retention-policies',
      '/api/v1/reports',
      '/api/v1/visibility-rules',
      '/api/v1/metrics',
    ]),
    // Scheduling (EP-18, EP-31): the program table, rights windows, export profiles.
    ...to('scheduling', ['/api/v1/schedules', '/api/v1/rights-windows', '/api/v1/export-profiles']),
    // RIM (EP-15.1): the chunked upload. Its parts are the one body on this platform larger than
    // the JSON cap, so this prefix carries its own.
    { service: 'rim', origin: o.rim, prefix: '/api/v1/uploads', bodyLimit: o.uploadBodyLimit },
    // RIM (EP-15.2–15.6, EP-39): the queue and its review, rules, watchers, recorders. JSON.
    ...to('rim', [
      '/api/v1/ingest',
      '/api/v1/acceptance-rules',
      '/api/v1/watchers',
      '/api/v1/recorders',
    ]),
    // HSM (EP-14; ADR-0009): where an asset's files are and their restore (SUFFIX routes — the rest
    // of /api/v1/assets is MAM's), an operation's progress, the storage targets, playout exports.
    { service: 'hsm', origin: o.hsm, prefix: '/api/v1/assets/', suffix: '/location' },
    { service: 'hsm', origin: o.hsm, prefix: '/api/v1/assets/', suffix: '/restore' },
    ...to('hsm', ['/api/v1/operations', '/api/v1/storage-targets', '/api/v1/playout']),
    // NEVER a route for `/internal/`: those are services calling each other, signed (ADR-0008),
    // and must be unreachable from outside. Each refuses them unsigned anyway.
    // MTS (EP-16): enqueue a transcode and poll it; the profile registry; the worker pool.
    ...to('mts', ['/api/v1/jobs', '/api/v1/profiles', '/api/v1/workers']),
  ];
}

/**
 * The table `buildGateway` uses when none is given — TESTS, and the walking skeleton. It is NOT the
 * production table: `main.ts` builds that from config origins, and only for services that exist.
 * The entries here for services that do not (hsm, mts, scheduling) are the routing plan, exercised
 * by tests. Adding a real service means main.ts; this list is for the tests that need it.
 */
export const defaultRoutes: RoutingTable = [
  { service: 'iam', origin: 'http://iam:3000', prefix: '/auth', public: true },
  { service: 'iam', origin: 'http://iam:3000', prefix: '/.well-known/jwks.json', public: true },
  { service: 'iam', origin: 'http://iam:3000', prefix: '/api/v1/users' },
  { service: 'iam', origin: 'http://iam:3000', prefix: '/api/v1/groups' },
  { service: 'iam', origin: 'http://iam:3000', prefix: '/api/v1/roles' },
  { service: 'mam', origin: 'http://mam:3000', prefix: '/api/v1/assets' },
  { service: 'mam', origin: 'http://mam:3000', prefix: '/api/v1/search' },
  { service: 'mam', origin: 'http://mam:3000', prefix: '/api/v1/categories' },
  { service: 'hsm', origin: 'http://hsm:3000', prefix: '/api/v1/files' },
  { service: 'mts', origin: 'http://mts:3000', prefix: '/api/v1/jobs' },
  { service: 'scheduling', origin: 'http://scheduling:3000', prefix: '/api/v1/schedules' },
  // EP-19: the audit sink's read surface. `/history` exists (19.1); `/logs` is 19.3.
  { service: 'logging', origin: 'http://logging:3000', prefix: '/api/v1/history' },
  { service: 'logging', origin: 'http://logging:3000', prefix: '/api/v1/logs' },
];
