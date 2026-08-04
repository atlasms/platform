// The four golden signals — latency, traffic, errors, saturation — as one reusable instrument set
// (EP-12.2). Every service records the same names, so one dashboard works for all of them.

import {
  DEFAULT_BUCKETS,
  type Counter,
  type Gauge,
  type Histogram,
  type MetricRegistry,
} from './metrics.ts';

export interface GoldenSignals {
  /** Traffic + errors: one counter, split by outcome. */
  readonly requests: Counter;
  /** Latency. */
  readonly duration: Histogram;
  /** Saturation: how many requests are in flight right now. */
  readonly inFlight: Gauge;
  /** Record one finished request. */
  observe(sample: RequestSample): void;
  /** Wrap a handler: counts in-flight, records duration, classifies the outcome. */
  track<T>(request: { method: string; route: string }, fn: () => Promise<T>): Promise<T>;
}

export interface RequestSample {
  method: string;
  /** The route TEMPLATE, never the raw path — see `normaliseRoute`. */
  route: string;
  status: number;
  /** Seconds. */
  duration: number;
}

export function goldenSignals(registry: MetricRegistry, service: string): GoldenSignals {
  const requests = registry.counter({
    name: 'atlas_http_requests_total',
    help: 'HTTP requests handled, by method, route template and status class.',
    labelNames: ['service', 'method', 'route', 'status'],
  });

  const duration = registry.histogram({
    name: 'atlas_http_request_duration_seconds',
    help: 'HTTP request duration in seconds.',
    labelNames: ['service', 'method', 'route'],
    buckets: DEFAULT_BUCKETS,
  });

  const inFlight = registry.gauge({
    name: 'atlas_http_requests_in_flight',
    help: 'HTTP requests currently being handled.',
    labelNames: ['service'],
  });

  const observe = (sample: RequestSample): void => {
    const route = normaliseRoute(sample.route);
    requests.inc({
      service,
      method: sample.method.toUpperCase(),
      route,
      // The status CLASS, not the code: 2xx/4xx/5xx is what alerts and dashboards ask about, and
      // it keeps this label at five values instead of dozens.
      status: statusClass(sample.status),
    });
    duration.observe({ service, method: sample.method.toUpperCase(), route }, sample.duration);
  };

  return {
    requests,
    duration,
    inFlight,
    observe,
    async track<T>(request: { method: string; route: string }, fn: () => Promise<T>): Promise<T> {
      inFlight.inc({ service });
      const started = performance.now();
      let status = 200;
      try {
        return await fn();
      } catch (err) {
        // An unhandled throw is a 500 as far as the caller is concerned; recording it as anything
        // else would make the error rate look better than it is.
        status = 500;
        throw err;
      } finally {
        inFlight.dec({ service });
        observe({
          method: request.method,
          route: request.route,
          status,
          duration: (performance.now() - started) / 1000,
        });
      }
    },
  };
}

export const statusClass = (status: number): string => `${Math.floor(status / 100)}xx`;

/**
 * Reduce a path to a bounded route template.
 *
 * THE cardinality hazard. `/api/v1/assets/01H2XK…` as a label mints a new time series per asset,
 * and a busy service will take the metrics store down within a day. Frameworks that expose a route
 * template should pass it directly; this is the fallback for when only a raw path is available.
 *
 * Segments that look like identifiers — ULIDs, UUIDs, numbers, long hex — collapse to `:id`.
 */
export function normaliseRoute(route: string): string {
  if (route === '') return '/';
  return route
    .split('/')
    .map((segment) => (looksLikeId(segment) ? ':id' : segment))
    .join('/');
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^\d+$/;
const LONG_HEX = /^[0-9a-f]{16,}$/i;

function looksLikeId(segment: string): boolean {
  return (
    ULID.test(segment) || UUID.test(segment) || NUMERIC.test(segment) || LONG_HEX.test(segment)
  );
}
