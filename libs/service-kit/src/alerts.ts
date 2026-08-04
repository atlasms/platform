// Alert routing skeleton (EP-12.4): a condition trips, an `alert.raised` payload is produced, a
// sink delivers it.
//
// Payloads match `docs/architecture/schemas/events/alert.raised.payload.schema.json`. This module
// stays free of @atlas/contracts and @atlas/messaging deliberately — service-kit is a dependency
// of everything, and the envelope-and-publish step belongs to the caller, which already has both.
// Logging & Analytics owns the real rule set (EP-19); what is here is the mechanism.

/**
 * The platform-wide severity scale.
 *
 * Exactly the values in `common.schema.json#/$defs/Severity` — **there is no `error`**. An earlier
 * version of this type invented one, and the payload was rejected the moment it was validated
 * against the shipped schema. The schema is the contract; this is only its TypeScript shadow.
 */
export type Severity = 'info' | 'warning' | 'critical';

/**
 * Matches the alert.raised payload contract.
 *
 * A `type`, not an `interface`, on purpose: an interface has no implicit index signature, so it
 * cannot be passed where a `Record<string, unknown>` is expected — which is exactly what
 * `buildEnvelope` takes. Since the whole point of this shape is to become an event payload, the
 * alias is what makes it usable without a cast.
 */
export type AlertRaised = {
  alertId: string;
  source: string;
  kind: string;
  severity: Severity;
  message: string;
  metric?: { name: string; value: number; threshold: number };
  raisedAt: string;
};

export interface AlertRule {
  /** Rule id, e.g. `dlq-depth`. Becomes `kind` on the payload. */
  kind: string;
  severity: Severity;
  /** Read the current value of whatever is being watched. */
  sample: () => number | Promise<number>;
  /** Trips when the sample crosses this. */
  threshold: number;
  /** `above` (default) trips on `>`; `below` trips on `<`. */
  direction?: 'above' | 'below';
  metricName?: string;
  message?: (value: number, threshold: number) => string;
  /**
   * How long a tripped condition must persist before firing, in evaluation ticks.
   *
   * A single sample over the line is usually a spike, not an incident. Requiring N consecutive
   * breaches is the cheapest way to stop an alert channel becoming noise people learn to ignore.
   */
  forTicks?: number;
}

export interface AlertSink {
  (alert: AlertRaised): void | Promise<void>;
}

export interface AlertEvaluatorOptions {
  source: string;
  rules: readonly AlertRule[];
  sink: AlertSink;
  /** Injected so tests are deterministic. */
  now?: () => Date;
  newId?: () => string;
}

interface RuleState {
  consecutiveBreaches: number;
  firing: boolean;
}

/**
 * Evaluates rules on demand and fires at most one alert per rule per episode.
 *
 * **Edge-triggered, not level-triggered.** A rule that stays breached fires once, not once per
 * tick — the difference between an alert and a flood. It re-arms only after recovering, and
 * recovery is reported too, because an alert nobody is told has ended is an alert nobody trusts.
 */
export class AlertEvaluator {
  private readonly state = new Map<string, RuleState>();
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly options: AlertEvaluatorOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? defaultId;
  }

  /** Evaluate every rule once. Returns the alerts fired on this tick. */
  async evaluate(): Promise<AlertRaised[]> {
    const fired: AlertRaised[] = [];

    for (const rule of this.options.rules) {
      const value = await rule.sample();
      const breached = isBreached(value, rule);
      const state = this.state.get(rule.kind) ?? { consecutiveBreaches: 0, firing: false };

      if (!breached) {
        if (state.firing) {
          const recovery = this.build(rule, value, 'info', `${rule.kind} recovered (${value})`);
          fired.push(recovery);
          await this.options.sink(recovery);
        }
        this.state.set(rule.kind, { consecutiveBreaches: 0, firing: false });
        continue;
      }

      const breaches = state.consecutiveBreaches + 1;
      const required = rule.forTicks ?? 1;

      if (!state.firing && breaches >= required) {
        const alert = this.build(rule, value, rule.severity, this.messageFor(rule, value));
        fired.push(alert);
        await this.options.sink(alert);
        this.state.set(rule.kind, { consecutiveBreaches: breaches, firing: true });
        continue;
      }

      this.state.set(rule.kind, { consecutiveBreaches: breaches, firing: state.firing });
    }

    return fired;
  }

  /** Whether a rule is currently in an alerting episode. */
  isFiring(kind: string): boolean {
    return this.state.get(kind)?.firing ?? false;
  }

  private messageFor(rule: AlertRule, value: number): string {
    if (rule.message) return rule.message(value, rule.threshold);
    const comparison = (rule.direction ?? 'above') === 'above' ? 'above' : 'below';
    return `${rule.kind}: ${value} is ${comparison} the threshold of ${rule.threshold}`;
  }

  private build(rule: AlertRule, value: number, severity: Severity, message: string): AlertRaised {
    return {
      alertId: this.newId(),
      source: this.options.source,
      kind: rule.kind,
      severity,
      message,
      ...(rule.metricName !== undefined
        ? { metric: { name: rule.metricName, value, threshold: rule.threshold } }
        : {}),
      raisedAt: this.now().toISOString(),
    };
  }
}

function isBreached(value: number, rule: AlertRule): boolean {
  return (rule.direction ?? 'above') === 'above' ? value > rule.threshold : value < rule.threshold;
}

/** Good enough for an id when the caller has not supplied @atlas/contracts' ULID generator. */
function defaultId(): string {
  return `alert-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
