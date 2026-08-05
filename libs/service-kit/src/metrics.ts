// Prometheus-compatible metrics, written directly rather than pulled from a library.
//
// The exposition format is small, stable and fully specified, and service-kit is a dependency of
// every service — so this keeps the offline bundle (A9 / FR-PLat-7) smaller and gives us control
// over the one thing that actually breaks metrics in production: label cardinality.
//
// Emitting Prometheus text does NOT lock the platform into Prometheus. It is the de-facto scrape
// format; which store and dashboards consume it is EP-12.2's infrastructure half.

/** Label values are strings. Numbers are coerced at the call site so cardinality stays visible. */
export type Labels = Readonly<Record<string, string>>;

export interface MetricOptions {
  name: string;
  help: string;
  labelNames?: readonly string[];
}

export interface HistogramOptions extends MetricOptions {
  /** Upper bounds, ascending. `+Inf` is added automatically. */
  buckets?: readonly number[];
}

/**
 * Default buckets, in **seconds**, tuned for HTTP handlers: dense where healthy requests live,
 * sparse out to the timeouts. Prometheus histograms cannot be re-bucketed after the fact, so the
 * shape here is a lasting decision.
 */
export const DEFAULT_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

/**
 * How many distinct label combinations one metric may hold before new ones are refused.
 *
 * Unbounded cardinality is the classic way to take down a metrics store: put a user id or a raw
 * URL path in a label and every request mints a new time series. Refusing beyond a cap keeps the
 * damage local to one metric, and the refusals are themselves counted so the problem is visible
 * rather than silent.
 */
export const DEFAULT_MAX_SERIES = 1000;

interface Series {
  labels: Labels;
  value: number;
  /** Histograms only. */
  buckets?: number[];
  sum?: number;
  count?: number;
}

type MetricType = 'counter' | 'gauge' | 'histogram';

abstract class Metric {
  readonly name: string;
  readonly help: string;
  readonly labelNames: readonly string[];
  protected readonly series = new Map<string, Series>();
  protected onDrop?: () => void;

  readonly type: MetricType;
  private readonly maxSeries: number;

  constructor(options: MetricOptions, type: MetricType, maxSeries: number) {
    this.name = options.name;
    this.help = options.help;
    this.labelNames = options.labelNames ?? [];
    this.type = type;
    this.maxSeries = maxSeries;
  }

  /** Called by the registry so refusals can be counted centrally. */
  setDropHandler(handler: () => void): void {
    this.onDrop = handler;
  }

  protected resolve(labels: Labels = {}): Series | undefined {
    const key = seriesKey(labels, this.labelNames);
    const existing = this.series.get(key);
    if (existing) return existing;

    if (this.series.size >= this.maxSeries) {
      this.onDrop?.();
      return undefined;
    }
    const created: Series = { labels: pick(labels, this.labelNames), value: 0 };
    this.series.set(key, created);
    return created;
  }

  entries(): readonly Series[] {
    return [...this.series.values()];
  }

  reset(): void {
    this.series.clear();
  }
}

/** Monotonic. Prometheus convention is a `_total` suffix, which the registry checks. */
export class Counter extends Metric {
  constructor(options: MetricOptions, maxSeries = DEFAULT_MAX_SERIES) {
    super(options, 'counter', maxSeries);
  }

  inc(labels: Labels = {}, amount = 1): void {
    if (amount < 0) throw new Error(`counter ${this.name} cannot decrease`);
    const series = this.resolve(labels);
    if (series) series.value += amount;
  }

  get(labels: Labels = {}): number {
    return this.series.get(seriesKey(labels, this.labelNames))?.value ?? 0;
  }
}

/** Goes up and down: queue depth, in-flight requests, connection counts. */
export class Gauge extends Metric {
  constructor(options: MetricOptions, maxSeries = DEFAULT_MAX_SERIES) {
    super(options, 'gauge', maxSeries);
  }

  set(labels: Labels, value: number): void {
    const series = this.resolve(labels);
    if (series) series.value = value;
  }

  inc(labels: Labels = {}, amount = 1): void {
    const series = this.resolve(labels);
    if (series) series.value += amount;
  }

  dec(labels: Labels = {}, amount = 1): void {
    this.inc(labels, -amount);
  }

  get(labels: Labels = {}): number {
    return this.series.get(seriesKey(labels, this.labelNames))?.value ?? 0;
  }
}

/** Cumulative buckets plus `_sum` and `_count`, so quantiles are computable at query time. */
export class Histogram extends Metric {
  readonly buckets: readonly number[];

  constructor(options: HistogramOptions, maxSeries = DEFAULT_MAX_SERIES) {
    super(options, 'histogram', maxSeries);
    this.buckets = [...(options.buckets ?? DEFAULT_BUCKETS)].sort((a, b) => a - b);
  }

  observe(labels: Labels, value: number): void {
    const series = this.resolve(labels);
    if (!series) return;
    series.buckets ??= new Array<number>(this.buckets.length).fill(0);
    series.sum = (series.sum ?? 0) + value;
    series.count = (series.count ?? 0) + 1;
    for (const [i, bound] of this.buckets.entries()) {
      // Every bucket whose bound the value satisfies — buckets are cumulative, not exclusive.
      if (value <= bound) series.buckets[i] = (series.buckets[i] ?? 0) + 1;
    }
  }

  /** Time a function, recording seconds. Records on failure too — errors have latency as well. */
  async time<T>(labels: Labels, fn: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await fn();
    } finally {
      this.observe(labels, (performance.now() - started) / 1000);
    }
  }
}

/**
 * The service's metric registry.
 *
 * One per process. `expose()` renders the Prometheus text format for a `/metrics` endpoint.
 */
export class MetricRegistry {
  private readonly metrics = new Map<string, Metric>();
  private readonly droppedSeries: Counter;

  private readonly maxSeries: number;

  constructor(maxSeries = DEFAULT_MAX_SERIES) {
    this.maxSeries = maxSeries;
    // Registered first and by hand: it must exist before anything can be dropped, and it must not
    // be able to drop itself.
    this.droppedSeries = new Counter(
      {
        name: 'atlas_metrics_series_dropped_total',
        help: 'Series refused because a metric hit its cardinality cap.',
        labelNames: ['metric'],
      },
      Number.MAX_SAFE_INTEGER,
    );
    this.metrics.set(this.droppedSeries.name, this.droppedSeries);
  }

  counter(options: MetricOptions): Counter {
    return this.register(new Counter(options, this.maxSeries));
  }

  gauge(options: MetricOptions): Gauge {
    return this.register(new Gauge(options, this.maxSeries));
  }

  histogram(options: HistogramOptions): Histogram {
    return this.register(new Histogram(options, this.maxSeries));
  }

  private register<T extends Metric>(metric: T): T {
    if (this.metrics.has(metric.name)) {
      // Two metrics under one name silently interleave their series and produce nonsense.
      throw new Error(`metric "${metric.name}" is already registered`);
    }
    if (!VALID_NAME.test(metric.name)) {
      throw new Error(`invalid metric name "${metric.name}"`);
    }
    if (metric.type === 'counter' && !metric.name.endsWith('_total')) {
      // Convention, but load-bearing: rate() over a non-_total counter is a common query mistake.
      throw new Error(`counter "${metric.name}" must end in _total`);
    }
    metric.setDropHandler(() => this.droppedSeries.inc({ metric: metric.name }));
    this.metrics.set(metric.name, metric);
    return metric;
  }

  get contentType(): string {
    return 'text/plain; version=0.0.4; charset=utf-8';
  }

  /** Render every metric in the Prometheus text exposition format. */
  expose(): string {
    const lines: string[] = [];
    for (const metric of this.metrics.values()) {
      const entries = metric.entries();
      if (entries.length === 0) continue;

      lines.push(`# HELP ${metric.name} ${escapeHelp(metric.help)}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);

      if (metric instanceof Histogram) {
        for (const series of entries) {
          let cumulative = 0;
          for (const [i, bound] of metric.buckets.entries()) {
            cumulative = series.buckets?.[i] ?? 0;
            lines.push(
              `${metric.name}_bucket${renderLabels({ ...series.labels, le: formatNumber(bound) })} ${cumulative}`,
            );
          }
          lines.push(
            `${metric.name}_bucket${renderLabels({ ...series.labels, le: '+Inf' })} ${series.count ?? 0}`,
          );
          lines.push(`${metric.name}_sum${renderLabels(series.labels)} ${series.sum ?? 0}`);
          lines.push(`${metric.name}_count${renderLabels(series.labels)} ${series.count ?? 0}`);
        }
        continue;
      }

      for (const series of entries) {
        lines.push(`${metric.name}${renderLabels(series.labels)} ${formatNumber(series.value)}`);
      }
    }
    // The format requires a trailing newline.
    return lines.length > 0 ? lines.join('\n') + '\n' : '';
  }

  resetAll(): void {
    for (const metric of this.metrics.values()) metric.reset();
  }
}

const VALID_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

/** Identity of a series. Only declared labels count, so a stray one cannot fork a series. */
function seriesKey(labels: Labels, labelNames: readonly string[]): string {
  return labelNames.map((n) => `${n}=${labels[n] ?? ''}`).join(',');
}

function pick(labels: Labels, labelNames: readonly string[]): Labels {
  const out: Record<string, string> = {};
  for (const name of labelNames) out[name] = labels[name] ?? '';
  return out;
}

function renderLabels(labels: Labels): string {
  const pairs = Object.entries(labels);
  if (pairs.length === 0) return '';
  return `{${pairs.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',')}}`;
}

/** Backslash, double quote and newline must be escaped, or the exposition is unparseable. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** HELP escapes backslash and newline only — a quote is legal there. */
function escapeHelp(help: string): string {
  return help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/** Prometheus wants `+Inf`/`NaN` spelled out, and no exponent surprises for integers. */
function formatNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  return String(value);
}
