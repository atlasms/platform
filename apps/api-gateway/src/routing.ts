// Path -> owning service. Deliberately data, not code: the routing table is the one thing that
// changes every time a service ships, and it should not require editing request handling.
//
// Spec: docs/architecture/services/api-gateway.md §4 — the gateway exposes every service's public
// API under one host and adds no domain endpoints of its own.

export interface RouteTarget {
  /** Service name, used in logs and metrics. */
  service: string;
  /** Base URL of the upstream, e.g. "http://mam:3000". */
  origin: string;
  /** Requests to this prefix are proxied. */
  prefix: string;
  /** When true the route is reachable without an access token (login, JWKS). */
  public?: boolean;
}

export type RoutingTable = RouteTarget[];

/**
 * Longest-prefix match, so `/api/v1/assets/{id}/versions` and `/api/v1/assets` can be owned by
 * different services if they ever diverge, and the more specific entry always wins regardless
 * of declaration order.
 */
export function matchRoute(table: RoutingTable, path: string): RouteTarget | undefined {
  let best: RouteTarget | undefined;
  for (const route of table) {
    if (!path.startsWith(route.prefix)) continue;
    if (!best || route.prefix.length > best.prefix.length) best = route;
  }
  return best;
}

/** The default table for the services that exist so far. Config, not a constant, in deployment. */
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
];
