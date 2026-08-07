// Spans, and getting them to a collector (EP-04.7, ADR-0004).
//
// The span model here is deliberately the OTLP one rather than an Atlas invention, so the exporter
// is a rename rather than a translation and anything downstream understands it without a shim.

import { currentContext, runWithContext, type RequestContext } from './correlation.ts';
import {
  formatTraceparent,
  newSpanId,
  newTraceId,
  parseTraceparent,
  TRACEPARENT_HEADER,
  type TraceContext,
} from './trace-context.ts';

/** OTLP span kinds. Only the three Atlas actually produces are named. */
export const SpanKind = {
  /** Handling an inbound request. */
  SERVER: 2,
  /** Making an outbound call. */
  CLIENT: 3,
  /** Consuming a message from the broker. */
  CONSUMER: 5,
} as const;
export type SpanKindValue = (typeof SpanKind)[keyof typeof SpanKind];

export type AttributeValue = string | number | boolean;

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly sampled: boolean;
  setAttribute(key: string, value: AttributeValue): void;
  /**
   * Rename the span after routing has decided what it actually is.
   *
   * The gateway needs this: its Fastify route template is the catch-all `/*`, so a span named at
   * request time is `POST /*` for every proxied request in the platform — one indistinguishable
   * operation in every trace UI. The useful name is only known once the routing table has matched.
   */
  setName(name: string): void;
  /** Mark the span as failed. `message` is for a human reading the trace, not for matching on. */
  setError(message: string): void;
  /** Finish the span and queue it for export. Idempotent — a double end is ignored, not doubled. */
  end(): void;
  /** The header a downstream hop should receive to continue this trace. */
  traceparent(): string;
}

interface FinishedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKindValue;
  startNanos: bigint;
  endNanos: bigint;
  attributes: Record<string, AttributeValue>;
  error?: string;
}

export interface TracerOptions {
  /** Value of `service.name` on every span. */
  service: string;
  /**
   * OTLP/HTTP base URL, e.g. `http://alloy:4318`. **Omit and nothing is exported** — spans are
   * still created and `traceparent` still propagates, so a site with no collector pays only the
   * cost of an id, and the day one appears the traces are already joined up.
   */
  endpoint?: string;
  /**
   * Fraction of NEW traces to record, 0..1. Ignored when continuing a trace: that decision was
   * made upstream and re-deciding leaves holes.
   */
  sampleRatio?: number;
  /** How often the queue is flushed. */
  flushIntervalMs?: number;
  /**
   * Spans held before export drops the oldest.
   *
   * Bounded because the collector is a REMOTE service that can be slow or gone, and an unbounded
   * queue turns its outage into this service's out-of-memory kill. Telemetry must never be the
   * thing that takes down the thing it is observing.
   */
  maxQueue?: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Endpoints that exist for the infrastructure rather than for a user, and must not be traced.
 *
 * Found by looking at a real trace store: liveness and readiness fire every few seconds per pod and
 * the scraper every fifteen, so within minutes **every** trace in Tempo was a probe. That is not
 * merely noise — it crowds real requests out of search results and spends the whole retention
 * window on the least interesting traffic in the platform.
 *
 * They stay in the METRICS, where a probe is one increment on an existing series and costs nothing.
 * The difference is that a trace has a per-request cost, and probes are almost all the requests.
 */
export const UNTRACED_ROUTES: ReadonlySet<string> = new Set(['/healthz', '/readyz', '/metrics']);

/** Should this route template produce a span at all? */
export const isTraceable = (route: string): boolean => !UNTRACED_ROUTES.has(route);

const DEFAULT_FLUSH_MS = 5_000;
const DEFAULT_MAX_QUEUE = 2_048;
const MS_TO_NANOS = 1_000_000n;

export interface Tracer {
  /**
   * Start a span for an inbound request and run `fn` inside it.
   *
   * `headers` are the inbound request's. When `adoptRemote` is false the incoming `traceparent` is
   * IGNORED and a fresh trace begins — which is what the gateway does, per api-gateway.md §12,
   * because a public client must not be able to pin every request to one trace id or force the
   * sampled flag and flood the collector.
   */
  server<T>(
    name: string,
    headers: Record<string, string | string[] | undefined>,
    options: { adoptRemote: boolean; attributes?: Record<string, AttributeValue> },
    fn: (span: Span) => T,
  ): T;
  /** Start a child span of whatever is current, or a new trace if nothing is. */
  start(name: string, kind: SpanKindValue, attributes?: Record<string, AttributeValue>): Span;
  /** Spans finished but not yet sent. */
  readonly pending: number;
  /** Spans dropped because the queue was full — a real signal, not a curiosity. */
  readonly dropped: number;
  /** Send everything queued. Called on the flush timer and on shutdown. */
  flush(): Promise<void>;
  /** Stop the timer and flush once. */
  shutdown(): Promise<void>;
}

export function createTracer(options: TracerOptions): Tracer {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sampleRatio = options.sampleRatio ?? 1;
  const maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;

  let queue: FinishedSpan[] = [];
  let dropped = 0;

  const enqueue = (span: FinishedSpan): void => {
    if (queue.length >= maxQueue) {
      // Drop the OLDEST. Newer spans describe what is happening now, which is what an operator
      // watching an incident is looking at; the old ones are the least useful thing to keep.
      queue.shift();
      dropped += 1;
    }
    queue.push(span);
  };

  const makeSpan = (
    name: string,
    kind: SpanKindValue,
    ctx: TraceContext,
    parentSpanId: string | undefined,
    attributes: Record<string, AttributeValue>,
  ): Span => {
    const startNanos = BigInt(now()) * MS_TO_NANOS;
    const attrs = { ...attributes };
    let spanName = name;
    let error: string | undefined;
    let ended = false;

    return {
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      ...(parentSpanId !== undefined ? { parentSpanId } : {}),
      sampled: ctx.sampled,
      setAttribute: (key, value) => {
        attrs[key] = value;
      },
      setName: (next) => {
        spanName = next;
      },
      setError: (message) => {
        error = message;
      },
      end: () => {
        // Idempotent: `finally { span.end() }` around a handler that already ended the span is a
        // normal shape, and counting that span twice would corrupt every duration derived from it.
        if (ended) return;
        ended = true;
        // An unsampled span still exists for propagation — it is simply never sent. Recording it
        // would make sampling a lie.
        if (!ctx.sampled) return;
        enqueue({
          traceId: ctx.traceId,
          spanId: ctx.spanId,
          ...(parentSpanId !== undefined ? { parentSpanId } : {}),
          name: spanName,
          kind,
          startNanos,
          endNanos: BigInt(now()) * MS_TO_NANOS,
          attributes: attrs,
          ...(error !== undefined ? { error } : {}),
        });
      },
      traceparent: () => formatTraceparent({ ...ctx, spanId: ctx.spanId }),
    };
  };

  const flush = async (): Promise<void> => {
    if (queue.length === 0 || options.endpoint === undefined) {
      // No endpoint means no collector. Dropping rather than growing forever is the whole point of
      // being able to run without one.
      queue = [];
      return;
    }
    const batch = queue;
    queue = [];
    try {
      await doFetch(`${options.endpoint.replace(/\/$/, '')}/v1/traces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toOtlp(options.service, batch)),
      });
    } catch {
      // Swallowed on purpose, and NOT re-queued. A collector that is down would otherwise grow the
      // queue until the drop cap, spending memory and retry time on telemetry while the service it
      // is observing does real work. Losing spans during a collector outage is the correct trade.
      dropped += batch.length;
    }
  };

  const timer = setInterval(() => void flush(), options.flushIntervalMs ?? DEFAULT_FLUSH_MS);
  // Never hold the process open for telemetry.
  timer.unref?.();

  const tracer: Tracer = {
    server(name, headers, opts, fn) {
      const remote = opts.adoptRemote ? parseTraceparent(headers[TRACEPARENT_HEADER]) : undefined;
      const ctx: TraceContext = remote
        ? // Continuing: keep the trace id, keep the UPSTREAM's sampling decision, mint our own
          // span id. Re-sampling here is what produces traces with holes in the middle.
          { traceId: remote.traceId, spanId: newSpanId(), sampled: remote.sampled }
        : { traceId: newTraceId(), spanId: newSpanId(), sampled: Math.random() < sampleRatio };

      const span = makeSpan(name, SpanKind.SERVER, ctx, remote?.spanId, opts.attributes ?? {});
      const existing = currentContext();
      const next: RequestContext = {
        correlationId: existing?.correlationId ?? ctx.traceId,
        ...(existing?.actor !== undefined ? { actor: existing.actor } : {}),
        traceId: ctx.traceId,
        spanId: ctx.spanId,
        sampled: ctx.sampled,
      };
      return runWithContext(next, () => fn(span));
    },

    start(name, kind, attributes) {
      const parent = currentContext();
      const ctx: TraceContext =
        parent?.traceId !== undefined
          ? { traceId: parent.traceId, spanId: newSpanId(), sampled: parent.sampled === true }
          : { traceId: newTraceId(), spanId: newSpanId(), sampled: Math.random() < sampleRatio };
      return makeSpan(name, kind, ctx, parent?.spanId, attributes ?? {});
    },

    get pending() {
      return queue.length;
    },
    get dropped() {
      return dropped;
    },
    flush,
    async shutdown() {
      clearInterval(timer);
      await flush();
    },
  };

  return tracer;
}

/**
 * The OTLP/HTTP JSON shape.
 *
 * Ids are hex STRINGS here, not base64 — that is what the JSON encoding of OTLP specifies, and
 * getting it wrong produces spans a collector accepts with a 200 and then cannot correlate.
 */
function toOtlp(service: string, spans: readonly FinishedSpan[]): unknown {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: service } }],
        },
        scopeSpans: [
          {
            scope: { name: '@atlas/service-kit' },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId !== undefined ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: s.kind,
              // OTLP wants nanoseconds as a STRING — a nanosecond timestamp exceeds 2^53 and
              // would lose precision as a JSON number.
              startTimeUnixNano: s.startNanos.toString(),
              endTimeUnixNano: s.endNanos.toString(),
              attributes: Object.entries(s.attributes).map(([key, value]) => ({
                key,
                value: otlpValue(value),
              })),
              // 0 UNSET, 2 ERROR. Deliberately never 1 (OK): OK means "explicitly marked
              // successful", and claiming that for every span that merely did not throw would
              // make the flag meaningless.
              status: s.error !== undefined ? { code: 2, message: s.error } : { code: 0 },
            })),
          },
        ],
      },
    ],
  };
}

function otlpValue(value: AttributeValue): unknown {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
}
