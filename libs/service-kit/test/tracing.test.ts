// EP-04.7 / ADR-0004 — W3C Trace Context and OTLP, written by hand.
//
// Writing it means owning the correctness, and this file is the price of that decision. Every
// failure mode below is SILENT: nothing throws, requests still succeed, and the only symptom is a
// trace that does not join up — discovered weeks later by whoever needed it during an incident.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTracer,
  currentContext,
  formatTraceparent,
  isTraceable,
  newSpanId,
  newTraceId,
  parseTraceparent,
  runWithContext,
  SpanKind,
  type Span,
} from '../src/index.ts';

const VALID = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT = '00f067aa0ba902b7';

// =============================================================================
// The header
// =============================================================================

test('a well-formed traceparent parses into its three parts', () => {
  const ctx = parseTraceparent(VALID);
  assert.deepEqual(ctx, { traceId: TRACE, spanId: PARENT, sampled: true });
});

test('the sampled flag is read as a BIT, not compared to a string', () => {
  // Only bit 0 is `sampled`; the rest are reserved. Comparing the octet to "01" would read a
  // caller that sets any future flag as UNSAMPLED, and its trace would silently stop being
  // recorded the day something upstream upgrades.
  assert.equal(parseTraceparent(`00-${TRACE}-${PARENT}-00`)?.sampled, false);
  assert.equal(parseTraceparent(`00-${TRACE}-${PARENT}-01`)?.sampled, true);
  assert.equal(
    parseTraceparent(`00-${TRACE}-${PARENT}-03`)?.sampled,
    true,
    'bit 0 set among others',
  );
  assert.equal(parseTraceparent(`00-${TRACE}-${PARENT}-02`)?.sampled, false, 'bit 0 clear');
});

test('a malformed header starts a NEW trace instead of throwing or propagating garbage', () => {
  // It must never throw: a cosmetic header problem turning into a failed request would be a far
  // worse outcome than a missing trace.
  for (const bad of [
    undefined,
    '',
    'garbage',
    `00-${TRACE}-${PARENT}`, // too few parts
    `00-${TRACE.slice(0, 31)}-${PARENT}-01`, // trace id one short
    `00-${TRACE}-${PARENT.slice(0, 15)}-01`, // span id one short
    `00-${TRACE.toUpperCase()}-${PARENT}-01`, // hex must be lowercase
    `00-${TRACE}-${PARENT}-0g`, // not hex
    123,
    {},
  ]) {
    assert.equal(parseTraceparent(bad), undefined, `accepted ${JSON.stringify(bad)}`);
  }
});

test('all-zero ids are refused', () => {
  // The spec forbids them, and they are also exactly what a naive implementation emits when it has
  // nothing to say — accepting them would merge every such caller's requests into one huge trace.
  assert.equal(parseTraceparent(`00-${'0'.repeat(32)}-${PARENT}-01`), undefined);
  assert.equal(parseTraceparent(`00-${TRACE}-${'0'.repeat(16)}-01`), undefined);
});

test('version ff is refused; other unknown versions are CONTINUED', () => {
  // Forward compatibility is required by the spec, and it matters: dropping an unknown version
  // would break every trace the day anything upstream upgrades. ff alone is explicitly invalid.
  assert.equal(parseTraceparent(`ff-${TRACE}-${PARENT}-01`), undefined);
  assert.equal(parseTraceparent(`01-${TRACE}-${PARENT}-01`)?.traceId, TRACE);
});

test('format round-trips, and pads the flags octet', () => {
  assert.equal(formatTraceparent({ traceId: TRACE, spanId: PARENT, sampled: true }), VALID);
  assert.match(formatTraceparent({ traceId: TRACE, spanId: PARENT, sampled: false }), /-00$/);
  assert.deepEqual(parseTraceparent(formatTraceparent(parseTraceparent(VALID)!)), {
    traceId: TRACE,
    spanId: PARENT,
    sampled: true,
  });
});

test('generated ids are the right width and do not repeat', () => {
  const traces = new Set<string>();
  for (let i = 0; i < 500; i += 1) {
    const id = newTraceId();
    assert.match(id, /^[0-9a-f]{32}$/);
    traces.add(id);
  }
  assert.equal(traces.size, 500, 'trace ids collided — two requests would merge into one trace');
  assert.match(newSpanId(), /^[0-9a-f]{16}$/);
});

// =============================================================================
// Spans
// =============================================================================

type Overrides = Omit<Partial<Parameters<typeof createTracer>[0]>, 'endpoint'> & {
  /** `false` means "configure no endpoint at all" — not the same as an empty one. */
  endpoint?: string | false;
};

/** A tracer whose exports land in an array instead of on the network. */
function tracer(over: Overrides = {}) {
  const sent: unknown[] = [];
  let clock = 1_000;
  const { endpoint = 'http://collector:4318', ...rest } = over;
  const t = createTracer({
    service: 'mam',
    // Omitted rather than set to undefined: `exactOptionalPropertyTypes` treats those as different
    // things, and so does the tracer — an absent endpoint is what disables export.
    ...(endpoint === false ? {} : { endpoint }),
    flushIntervalMs: 1_000_000, // never on a timer; the tests flush explicitly
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(init?.body as string));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch,
    now: () => clock,
    ...rest,
  });
  return { t, sent, advance: (ms: number) => (clock += ms) };
}

const spans = (sent: unknown[]): Record<string, never>[] =>
  sent.flatMap(
    (b) =>
      (b as { resourceSpans: { scopeSpans: { spans: Record<string, never>[] }[] }[] })
        .resourceSpans[0]?.scopeSpans[0]?.spans ?? [],
  );

test('a server span continues an inbound trace and becomes its child', () => {
  const { t } = tracer();
  const span = t.server('GET /x', { traceparent: VALID }, { adoptRemote: true }, (s) => s);

  assert.equal(span.traceId, TRACE, 'same trace');
  assert.equal(span.parentSpanId, PARENT, 'the caller is our parent');
  assert.notEqual(span.spanId, PARENT, 'but we are a new span');
});

test('SECURITY: adoptRemote=false ignores the inbound header and starts a fresh trace', () => {
  // What the gateway does, per api-gateway.md §12 — "the gateway STARTS the trace". It is also
  // what stops a public client pinning every request to one trace id, or setting sampled on every
  // request to flood the collector.
  const { t } = tracer();
  const span = t.server('GET /x', { traceparent: VALID }, { adoptRemote: false }, (s) => s);

  assert.notEqual(span.traceId, TRACE, 'the client does not choose our trace id');
  assert.equal(span.parentSpanId, undefined, 'and does not become our parent');
});

test('DANGER: the UPSTREAM sampling decision is honoured, never re-decided', () => {
  // Re-sampling at each hop is the classic way to produce traces with holes in the middle: the
  // gateway records, the next service rolls the dice again and does not, and the trace ends where
  // the interesting part begins.
  const { t } = tracer({ sampleRatio: 0 }); // this service would never sample on its own
  const adopted = t.server(
    'GET /x',
    { traceparent: `00-${TRACE}-${PARENT}-01` },
    { adoptRemote: true },
    (s) => s,
  );
  assert.equal(adopted.sampled, true, 'upstream said record, so we record');

  const declined = t.server(
    'GET /y',
    { traceparent: `00-${TRACE}-${PARENT}-00` },
    { adoptRemote: true },
    (s) => s,
  );
  assert.equal(declined.sampled, false, 'and upstream said skip, so we skip');
});

test('a child span joins its parent through the ambient context', () => {
  const { t } = tracer();
  let child: Span | undefined;
  const parent = t.server('GET /x', {}, { adoptRemote: true }, (s) => {
    child = t.start('db.query', SpanKind.CLIENT);
    return s;
  });

  assert.equal(child?.traceId, parent.traceId, 'same trace');
  assert.equal(child?.parentSpanId, parent.spanId, 'nested under the request span');
});

test('the trace context lands in the SAME store as the correlation id', () => {
  // One store, so a log line and a span can never disagree about which request they belong to.
  const { t } = tracer();
  runWithContext({ correlationId: 'corr-1' }, () => {
    t.server('GET /x', { traceparent: VALID }, { adoptRemote: true }, () => {
      const ctx = currentContext();
      assert.equal(ctx?.correlationId, 'corr-1', 'the existing correlation id survives');
      assert.equal(ctx?.traceId, TRACE);
      assert.equal(ctx?.sampled, true);
    });
  });
});

test('an unsampled span still propagates but is never exported', () => {
  // Otherwise sampling would be a lie: the header must keep flowing so downstream agrees, while
  // nothing is recorded.
  const { t, sent } = tracer({ sampleRatio: 0 });
  const span = t.server('GET /x', {}, { adoptRemote: true }, (s) => s);
  span.end();
  void t.flush();

  assert.equal(span.sampled, false);
  assert.match(span.traceparent(), /-00$/, 'the flag propagates as unsampled');
  assert.equal(sent.length, 0, 'and nothing was sent');
});

test('ending a span twice records it once', () => {
  // `finally { span.end() }` around a handler that already ended it is a normal shape, and double
  // counting would corrupt every duration derived from the span.
  const { t, sent } = tracer();
  const span = t.server('GET /x', {}, { adoptRemote: true }, (s) => s);
  span.end();
  span.end();
  void t.flush();

  assert.equal(spans(sent).length, 1);
});

// =============================================================================
// Export
// =============================================================================

test('the OTLP payload has the shape a collector expects', async () => {
  const { t, sent, advance } = tracer();
  const span = t.server(
    'GET /assets',
    {},
    { adoptRemote: true, attributes: { 'http.route': '/assets' } },
    (s) => s,
  );
  span.setAttribute('http.status_code', 200);
  advance(42);
  span.end();
  await t.flush();

  const body = sent[0] as {
    resourceSpans: { resource: { attributes: { key: string; value: unknown }[] } }[];
  };
  assert.deepEqual(body.resourceSpans[0]?.resource.attributes, [
    { key: 'service.name', value: { stringValue: 'mam' } },
  ]);

  const [s] = spans(sent) as unknown as Record<string, string | number>[];
  assert.match(
    String(s?.['traceId']),
    /^[0-9a-f]{32}$/,
    'hex string, not base64 — the JSON encoding',
  );
  assert.equal(s?.['name'], 'GET /assets');
  assert.equal(s?.['kind'], SpanKind.SERVER);
  // Nanoseconds exceed 2^53, so OTLP/JSON requires them as strings; a number would silently lose
  // precision and every duration would be subtly wrong.
  assert.equal(typeof s?.['startTimeUnixNano'], 'string');
  assert.equal(
    BigInt(String(s?.['endTimeUnixNano'])) - BigInt(String(s?.['startTimeUnixNano'])),
    42_000_000n,
    '42ms in nanoseconds',
  );
});

test('attributes keep their types, and an error becomes status 2', async () => {
  const { t, sent } = tracer();
  const span = t.server('GET /x', {}, { adoptRemote: true }, (s) => s);
  span.setAttribute('str', 'a');
  span.setAttribute('int', 7);
  span.setAttribute('float', 1.5);
  span.setAttribute('bool', true);
  span.setError('upstream unreachable');
  span.end();
  await t.flush();

  const [s] = spans(sent) as unknown as {
    attributes: { key: string; value: Record<string, unknown> }[];
    status: { code: number; message?: string };
  }[];
  const by = Object.fromEntries((s?.attributes ?? []).map((a) => [a.key, a.value]));
  assert.deepEqual(by['str'], { stringValue: 'a' });
  assert.deepEqual(by['int'], { intValue: '7' }, 'ints are strings in OTLP/JSON');
  assert.deepEqual(by['float'], { doubleValue: 1.5 });
  assert.deepEqual(by['bool'], { boolValue: true });
  assert.equal(s?.status.code, 2);
});

test('a span can be renamed once routing knows what it is', async () => {
  // Found by running it end to end: the gateway's Fastify route template is the catch-all `/*`, so
  // EVERY proxied request in the platform arrived at the collector as `POST /*` — one
  // indistinguishable operation in the trace UI. The useful name exists only after the routing
  // table has matched, which is after the span has already started.
  const { t, sent } = tracer();
  const span = t.server('POST /*', {}, { adoptRemote: true }, (s) => s);
  span.setName('POST /auth → iam');
  span.end();
  await t.flush();

  assert.equal((spans(sent)[0] as unknown as { name: string }).name, 'POST /auth → iam');
});

test('a span that merely succeeded is UNSET, not OK', async () => {
  // OK means "explicitly marked successful". Claiming it for everything that did not throw makes
  // the flag meaningless, and makes a real OK indistinguishable from an unexamined one.
  const { t, sent } = tracer();
  t.server('GET /x', {}, { adoptRemote: true }, (s) => s).end();
  await t.flush();

  const [s] = spans(sent) as unknown as { status: { code: number } }[];
  assert.equal(s?.status.code, 0);
});

test('with no endpoint configured, spans are created but nothing is sent or accumulated', async () => {
  // A site with no collector must pay only the cost of an id — and must not grow a queue forever.
  const { t, sent } = tracer({ endpoint: false });
  const span = t.server('GET /x', {}, { adoptRemote: true }, (s) => s);
  span.end();
  assert.ok(span.traceparent(), 'propagation still works');

  await t.flush();
  assert.equal(sent.length, 0);
  assert.equal(t.pending, 0, 'the queue did not grow');
});

test('DANGER: the queue is bounded and drops the OLDEST', async () => {
  // The collector is a remote service that can be slow or gone. An unbounded queue turns its
  // outage into this service's out-of-memory kill — telemetry must never take down the thing it
  // is observing. Newest spans are kept because they describe the incident in progress.
  const { t, sent } = tracer({ maxQueue: 10 });
  for (let i = 0; i < 25; i += 1) {
    const s = t.server(`req-${i}`, {}, { adoptRemote: true }, (x) => x);
    s.end();
  }
  assert.equal(t.pending, 10);
  assert.equal(t.dropped, 15);

  await t.flush();
  const names = spans(sent).map((s) => (s as unknown as { name: string }).name);
  assert.deepEqual(
    names,
    [...Array(10).keys()].map((i) => `req-${i + 15}`),
    'the newest ten',
  );
});

test('a collector that is down loses spans rather than retrying forever', async () => {
  // Re-queueing would spend memory and retry budget on telemetry while the service does real work,
  // and would fill the queue anyway. Losing spans during a collector outage is the correct trade —
  // counted, so it is visible rather than silent.
  const { t } = tracer({
    fetchImpl: (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch,
  });
  t.server('GET /x', {}, { adoptRemote: true }, (s) => s).end();
  await t.flush();

  assert.equal(t.pending, 0, 'not re-queued');
  assert.equal(t.dropped, 1, 'and the loss is counted');
});

test('DANGER: probes and the scraper are not traceable', async () => {
  // Found by looking at a real Tempo instance: liveness fires every few seconds per pod and the
  // scraper every fifteen, so within minutes EVERY trace in the store was a probe — twenty out of
  // twenty in the search results. That is not just noise. It crowds real requests out of search and
  // spends the entire 7-day retention window on the least interesting traffic in the platform.
  for (const route of ['/healthz', '/readyz', '/metrics']) {
    assert.equal(isTraceable(route), false, `${route} must not be traced`);
  }
  for (const route of ['/auth/login', '/api/v1/assets', '/api/v1/assets/:id', '/*']) {
    assert.equal(isTraceable(route), true, `${route} must be traced`);
  }
});

test('shutdown flushes what is queued', async () => {
  // SIGTERM arrives, the pod has a grace period, and the spans describing the last requests are
  // exactly the ones worth keeping — they may explain why it is being restarted.
  const { t, sent } = tracer();
  t.server('GET /x', {}, { adoptRemote: true }, (s) => s).end();
  await t.shutdown();

  assert.equal(spans(sent).length, 1);
});
