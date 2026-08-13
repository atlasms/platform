// Wires the whole spine together in one process.
//
// The gateway normally reaches a service over HTTP. Here its `fetch` is pointed at the service's
// own Fastify instance via `inject()`, so the entire chain runs headlessly — no ports, no
// sockets, no flakiness — while still exercising the real request path, real headers and the real
// auth code. Production swaps one function; nothing else changes.

import { buildGateway, type GatewayOptions } from '@atlas/api-gateway';
import { InMemoryBroker, OutboxRelay } from '@atlas/messaging';
import { ConnectionRegistry, startBridge } from '@atlas/websocket';
import type { EffectivePolicy } from '@atlas/policy';
import type { Tracer } from '@atlas/service-kit';
import type { FastifyInstance } from 'fastify';
import { buildAssetService, type AssetService } from './asset-service.ts';

export interface Spine {
  gateway: FastifyInstance;
  service: AssetService;
  broker: InMemoryBroker;
  relay: OutboxRelay;
  sockets: ConnectionRegistry;
  /** Drain the outbox and let the broker fan out — one "tick" of the async path. */
  settle: () => Promise<number>;
}

export interface SpineOptions {
  jwks: GatewayOptions['jwks'];
  policyFor: (userId: string) => EffectivePolicy | undefined;
  issuer?: string;
  audience?: string;
  /**
   * ONE tracer for the whole spine (EP-13.3).
   *
   * Passing the same instance to the gateway, the service and the bridge is what makes a single
   * trace span all four hops in this process. In production they are separate processes with
   * separate tracers, and the trace still joins up — because it joins on the WIRE, through
   * `traceparent`, not through a shared object.
   */
  tracer?: Tracer;
}

export function buildSpine(options: SpineOptions): Spine {
  const tracerOpt = options.tracer !== undefined ? { tracer: options.tracer } : {};
  const service = buildAssetService({ policyFor: options.policyFor, ...tracerOpt });
  const broker = new InMemoryBroker();
  const relay = new OutboxRelay(service.outbox, broker);
  const sockets = new ConnectionRegistry();

  startBridge({ broker, registry: sockets, ...tracerOpt });

  const gateway = buildGateway({
    jwks: options.jwks,
    ...(options.issuer !== undefined ? { issuer: options.issuer } : {}),
    ...(options.audience !== undefined ? { audience: options.audience } : {}),
    routes: [
      { service: 'iam', origin: 'http://iam', prefix: '/auth', public: true },
      { service: 'assets', origin: 'http://assets', prefix: '/api/v1/assets' },
    ],
    fetchImpl: injectInto(service.app),
    ...tracerOpt,
  });

  return {
    gateway,
    service,
    broker,
    relay,
    sockets,
    settle: () => relay.drain(),
  };
}

/** Adapt a Fastify instance to the `fetch` signature the gateway proxies through. */
function injectInto(app: FastifyInstance): typeof fetch {
  return (async (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => {
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET',
      url: new URL(url, 'http://internal').pathname + new URL(url, 'http://internal').search,
      headers: init?.headers ?? {},
      ...(init?.body !== undefined ? { payload: init.body } : {}),
    });
    return {
      status: res.statusCode,
      ok: res.statusCode < 400,
      statusText: String(res.statusCode),
      headers: { get: (h: string) => res.headers[h.toLowerCase()] ?? null },
      text: async () => res.body,
      json: async () => res.json(),
    };
  }) as unknown as typeof fetch;
}
