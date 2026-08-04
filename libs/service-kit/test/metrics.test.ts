import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AlertEvaluator,
  goldenSignals,
  MetricRegistry,
  normaliseRoute,
  statusClass,
  type AlertRaised,
} from '../src/index.ts';

// =============================================================================
// Exposition format — the contract with every scraper. Asserted exactly, because a format bug
// does not throw: it silently produces metrics nobody can query.
// =============================================================================

test('counters render name, HELP, TYPE and value', () => {
  const registry = new MetricRegistry();
  const requests = registry.counter({ name: 'atlas_jobs_total', help: 'Jobs run.' });

  requests.inc();
  requests.inc({}, 4);

  assert.equal(
    registry.expose(),
    '# HELP atlas_jobs_total Jobs run.\n# TYPE atlas_jobs_total counter\natlas_jobs_total 5\n',
  );
});

test('labels render as a sorted-by-declaration set, one series each', () => {
  const registry = new MetricRegistry();
  const c = registry.counter({
    name: 'atlas_events_total',
    help: 'Events.',
    labelNames: ['kind', 'channel'],
  });

  c.inc({ kind: 'created', channel: 'ch12' });
  c.inc({ kind: 'created', channel: 'ch12' });
  c.inc({ kind: 'deleted', channel: 'ch12' });

  const out = registry.expose();
  assert.match(out, /atlas_events_total\{kind="created",channel="ch12"\} 2/);
  assert.match(out, /atlas_events_total\{kind="deleted",channel="ch12"\} 1/);
});

test('an undeclared label cannot fork a series', () => {
  // Otherwise a stray field at one call site silently splits a metric in two, and the totals stop
  // adding up for reasons nobody can find.
  const registry = new MetricRegistry();
  const c = registry.counter({ name: 'atlas_x_total', help: 'x', labelNames: ['a'] });

  c.inc({ a: '1' });
  c.inc({ a: '1', stray: 'whatever' });

  assert.equal(c.get({ a: '1' }), 2);
  assert.equal(
    registry
      .expose()
      .split('\n')
      .filter((l) => l.startsWith('atlas_x_total')).length,
    1,
  );
});

test('label values escape backslash, quote and newline', () => {
  // An unescaped quote makes the whole exposition unparseable, so the scrape fails wholesale
  // rather than losing one metric.
  const registry = new MetricRegistry();
  const c = registry.counter({ name: 'atlas_paths_total', help: 'Paths.', labelNames: ['path'] });

  c.inc({ path: 'a\\b"c\nd' });

  assert.match(registry.expose(), /atlas_paths_total\{path="a\\\\b\\"c\\nd"\} 1/);
});

test('HELP escapes backslash and newline, but not quotes', () => {
  const registry = new MetricRegistry();
  registry.counter({ name: 'atlas_h_total', help: 'a "quoted" thing\nwith a break' }).inc();
  assert.match(registry.expose(), /# HELP atlas_h_total a "quoted" thing\\nwith a break/);
});

test('gauges go up and down', () => {
  const registry = new MetricRegistry();
  const g = registry.gauge({ name: 'atlas_queue_depth', help: 'Depth.' });

  g.set({}, 10);
  g.dec();
  g.inc({}, 3);

  assert.equal(g.get(), 12);
  assert.match(registry.expose(), /atlas_queue_depth 12/);
});

test('histogram buckets are CUMULATIVE and carry _sum, _count and +Inf', () => {
  const registry = new MetricRegistry();
  const h = registry.histogram({
    name: 'atlas_op_seconds',
    help: 'Op duration.',
    buckets: [0.1, 0.5, 1],
  });

  h.observe({}, 0.05); // <= every bucket
  h.observe({}, 0.4); // <= 0.5 and 1
  h.observe({}, 2); // > all bounds, but still counted in +Inf

  const out = registry.expose();
  assert.match(out, /atlas_op_seconds_bucket\{le="0\.1"\} 1/);
  assert.match(out, /atlas_op_seconds_bucket\{le="0\.5"\} 2/);
  assert.match(out, /atlas_op_seconds_bucket\{le="1"\} 2/);
  assert.match(out, /atlas_op_seconds_bucket\{le="\+Inf"\} 3/);
  assert.match(out, /atlas_op_seconds_count 3/);
  assert.match(out, /atlas_op_seconds_sum 2\.45/);
});

test('buckets are sorted even when declared out of order', () => {
  const registry = new MetricRegistry();
  const h = registry.histogram({ name: 'atlas_s', help: 's', buckets: [1, 0.1, 0.5] });
  assert.deepEqual([...h.buckets], [0.1, 0.5, 1]);
});

test('an empty metric emits nothing rather than a bare header', () => {
  const registry = new MetricRegistry();
  registry.counter({ name: 'atlas_unused_total', help: 'Never touched.' });
  assert.equal(registry.expose(), '');
});

// --- registration guards -----------------------------------------------------

test('registering the same name twice is refused', () => {
  const registry = new MetricRegistry();
  registry.counter({ name: 'atlas_dup_total', help: 'x' });
  // Two metrics under one name interleave their series and produce nonsense.
  assert.throws(
    () => registry.counter({ name: 'atlas_dup_total', help: 'y' }),
    /already registered/,
  );
});

test('a counter must end in _total', () => {
  const registry = new MetricRegistry();
  assert.throws(() => registry.counter({ name: 'atlas_requests', help: 'x' }), /_total/);
});

test('invalid metric names are refused', () => {
  const registry = new MetricRegistry();
  assert.throws(() => registry.gauge({ name: 'has-a-dash', help: 'x' }), /invalid metric name/);
});

test('counters cannot decrease', () => {
  const registry = new MetricRegistry();
  const c = registry.counter({ name: 'atlas_c_total', help: 'x' });
  assert.throws(() => c.inc({}, -1), /cannot decrease/);
});

// --- the cardinality guard ---------------------------------------------------

test('SATURATION: a metric stops minting series at its cap, and the refusals are counted', () => {
  // Unbounded cardinality is how a metrics store dies. Refusing keeps the damage to one metric,
  // and counting the refusals makes it visible instead of silent.
  const registry = new MetricRegistry(3);
  const c = registry.counter({ name: 'atlas_wide_total', help: 'x', labelNames: ['id'] });

  for (let i = 0; i < 10; i++) c.inc({ id: String(i) });

  const series = registry
    .expose()
    .split('\n')
    .filter((l) => l.startsWith('atlas_wide_total{'));
  assert.equal(series.length, 3, 'only the first three label sets survive');

  assert.match(
    registry.expose(),
    /atlas_metrics_series_dropped_total\{metric="atlas_wide_total"\} 7/,
  );
});

test('existing series keep recording after the cap is hit', () => {
  // The cap must not turn a busy metric into a dead one.
  const registry = new MetricRegistry(1);
  const c = registry.counter({ name: 'atlas_capped_total', help: 'x', labelNames: ['id'] });

  c.inc({ id: 'first' });
  c.inc({ id: 'second' }); // refused
  c.inc({ id: 'first' });

  assert.equal(c.get({ id: 'first' }), 2);
});

// =============================================================================
// Golden signals
// =============================================================================

test('golden signals record traffic, errors, latency and saturation', () => {
  const registry = new MetricRegistry();
  const signals = goldenSignals(registry, 'mam');

  signals.observe({ method: 'get', route: '/api/v1/assets', status: 200, duration: 0.02 });
  signals.observe({ method: 'GET', route: '/api/v1/assets', status: 500, duration: 1.5 });

  const out = registry.expose();
  assert.match(
    out,
    /atlas_http_requests_total\{service="mam",method="GET",route="\/api\/v1\/assets",status="2xx"\} 1/,
  );
  assert.match(
    out,
    /atlas_http_requests_total\{service="mam",method="GET",route="\/api\/v1\/assets",status="5xx"\} 1/,
  );
  assert.match(
    out,
    /atlas_http_request_duration_seconds_count\{service="mam",method="GET",route="\/api\/v1\/assets"\} 2/,
  );
});

test('status is recorded as a CLASS, keeping that label at five values', () => {
  assert.equal(statusClass(201), '2xx');
  assert.equal(statusClass(404), '4xx');
  assert.equal(statusClass(503), '5xx');
});

test('track() counts in-flight and returns to zero — including when the handler throws', async () => {
  const registry = new MetricRegistry();
  const signals = goldenSignals(registry, 'mam');

  let observedInFlight = 0;
  await signals.track({ method: 'GET', route: '/x' }, async () => {
    observedInFlight = signals.inFlight.get({ service: 'mam' });
  });

  assert.equal(observedInFlight, 1, 'in flight while running');
  assert.equal(signals.inFlight.get({ service: 'mam' }), 0, 'released after');

  await assert.rejects(
    signals.track({ method: 'GET', route: '/x' }, async () => {
      throw new Error('boom');
    }),
  );
  // A leaked gauge here would show permanent fake load and eventually trip saturation alerts.
  assert.equal(signals.inFlight.get({ service: 'mam' }), 0, 'released after a throw too');
});

test('an unhandled throw is recorded as 5xx, not as success', () => {
  const registry = new MetricRegistry();
  const signals = goldenSignals(registry, 'mam');

  return signals
    .track({ method: 'POST', route: '/x' }, async () => {
      throw new Error('boom');
    })
    .catch(() => {
      assert.match(registry.expose(), /route="\/x",status="5xx"\} 1/);
    });
});

test('CARDINALITY: route templates collapse ids', () => {
  // The single biggest way to kill a metrics store: an id in a label mints a series per request.
  assert.equal(normaliseRoute('/api/v1/assets/01H2XKZQ4E5N6P7R8S9T0V1W2X'), '/api/v1/assets/:id');
  assert.equal(
    normaliseRoute('/api/v1/assets/9f8e7d6c-5b4a-4321-8765-0a1b2c3d4e5f/files'),
    '/api/v1/assets/:id/files',
  );
  assert.equal(normaliseRoute('/api/v1/assets/42'), '/api/v1/assets/:id');
  assert.equal(normaliseRoute('/api/v1/assets/deadbeefdeadbeef99'), '/api/v1/assets/:id');

  // Real path segments must survive — collapsing them would merge unrelated endpoints.
  assert.equal(normaliseRoute('/api/v1/assets'), '/api/v1/assets');
  assert.equal(normaliseRoute('/healthz'), '/healthz');
  assert.equal(normaliseRoute(''), '/');
});

// =============================================================================
// EP-12.4 — alert routing
// =============================================================================

function evaluator(sample: () => number): { evaluator: AlertEvaluator; fired: AlertRaised[] } {
  const fired: AlertRaised[] = [];
  return {
    fired,
    evaluator: new AlertEvaluator({
      source: 'messaging',
      sink: (a) => {
        fired.push(a);
      },
      now: () => new Date('2026-08-04T10:00:00.000Z'),
      newId: () => 'alert-1',
      rules: [
        {
          kind: 'dlq-depth',
          severity: 'critical',
          sample,
          threshold: 10,
          metricName: 'atlas_dlq_depth',
        },
      ],
    }),
  };
}

test('a rule fires when its threshold is crossed, with a schema-shaped payload', async () => {
  let depth = 0;
  const { evaluator: ev, fired } = evaluator(() => depth);

  assert.deepEqual(await ev.evaluate(), []);

  depth = 25;
  const alerts = await ev.evaluate();

  assert.equal(alerts.length, 1);
  assert.deepEqual(fired[0], {
    alertId: 'alert-1',
    source: 'messaging',
    kind: 'dlq-depth',
    severity: 'critical',
    message: 'dlq-depth: 25 is above the threshold of 10',
    metric: { name: 'atlas_dlq_depth', value: 25, threshold: 10 },
    raisedAt: '2026-08-04T10:00:00.000Z',
  });
});

test('EDGE-TRIGGERED: a sustained breach fires once, not once per tick', async () => {
  // Level-triggered alerting is how a channel becomes noise people mute.
  let depth = 50;
  const { evaluator: ev, fired } = evaluator(() => depth);

  await ev.evaluate();
  await ev.evaluate();
  await ev.evaluate();

  assert.equal(fired.length, 1);
  assert.equal(ev.isFiring('dlq-depth'), true);

  depth = 0;
  await ev.evaluate();
  assert.equal(ev.isFiring('dlq-depth'), false);
});

test('recovery is reported, and re-arms the rule', async () => {
  // An alert nobody is told has ended is an alert nobody trusts.
  let depth = 50;
  const { evaluator: ev, fired } = evaluator(() => depth);

  await ev.evaluate();
  depth = 1;
  await ev.evaluate();

  assert.equal(fired.length, 2);
  assert.equal(fired[1]?.severity, 'info');
  assert.match(fired[1]?.message ?? '', /recovered/);

  depth = 99;
  await ev.evaluate();
  assert.equal(fired.length, 3, 'the rule re-arms after recovering');
});

test('forTicks suppresses a single-sample spike', async () => {
  const fired: AlertRaised[] = [];
  let value = 0;
  const ev = new AlertEvaluator({
    source: 'mts',
    sink: (a) => {
      fired.push(a);
    },
    rules: [
      { kind: 'spiky', severity: 'warning', sample: () => value, threshold: 10, forTicks: 3 },
    ],
  });

  value = 50;
  await ev.evaluate();
  await ev.evaluate();
  assert.equal(fired.length, 0, 'not yet — the breach has not persisted');

  await ev.evaluate();
  assert.equal(fired.length, 1, 'fires on the third consecutive breach');
});

test('a below-threshold rule trips in the other direction', async () => {
  const fired: AlertRaised[] = [];
  const ev = new AlertEvaluator({
    source: 'hsm',
    sink: (a) => {
      fired.push(a);
    },
    rules: [
      {
        kind: 'free-space',
        severity: 'critical',
        sample: () => 5,
        threshold: 20,
        direction: 'below',
      },
    ],
  });

  await ev.evaluate();
  assert.equal(fired.length, 1);
  assert.match(fired[0]?.message ?? '', /below the threshold/);
});

test('alerts can be driven straight off a metric', async () => {
  // The intended wiring: metrics are the sample source, so alert thresholds and dashboards agree.
  const registry = new MetricRegistry();
  const depth = registry.gauge({ name: 'atlas_dlq_depth', help: 'Dead letters waiting.' });
  depth.set({}, 42);

  const fired: AlertRaised[] = [];
  const ev = new AlertEvaluator({
    source: 'messaging',
    sink: (a) => {
      fired.push(a);
    },
    rules: [{ kind: 'dlq-depth', severity: 'critical', sample: () => depth.get(), threshold: 10 }],
  });

  await ev.evaluate();
  assert.equal(fired.length, 1);
});
