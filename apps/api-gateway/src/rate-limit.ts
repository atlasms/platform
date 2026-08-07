// Rate limiting (EP-08.3). api-gateway.md §10 — "per-principal quotas blunt abuse" — and §11,
// which makes the policies configuration rather than constants.
//
// WHAT THIS IS FOR, and what it is NOT for.
//
// This is a blunt abuse brake protecting the gateway and the services behind it: one client must
// not be able to saturate the platform. It is deliberately NOT the anti-brute-force mechanism —
// that is IAM's per-account lockout (#240), and the split is not arbitrary.
//
// Atlas installs in broadcast facilities. Everyone in a newsroom arrives from ONE public address,
// so a source-address limit tight enough to stop password guessing would lock out the whole gallery
// at shift change. Source address here means "a building", not "a person". The per-account lockout
// is the one that can afford to be strict, because it is keyed on the thing actually under attack.
//
// A token bucket rather than a fixed window: a fixed window lets a client spend its whole allowance
// in the last millisecond of one window and again in the first of the next, which is twice the
// intended rate at exactly the moment a burst hurts most.

/** Requests per window, refilled continuously. `limit` doubles as the burst size. */
export interface RateLimitPolicy {
  limit: number;
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Whole tokens left after this request. */
  remaining: number;
  /** Milliseconds until one token is available. Zero when allowed. */
  retryAfterMs: number;
  /**
   * True when the limiter declined to TRACK this key because it was full — see the fail-open note
   * on {@link RateLimiter}. Surfaced so it can be counted rather than silently ignored.
   */
  untracked?: boolean;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimiterOptions {
  /**
   * How many distinct keys may be tracked at once.
   *
   * Load-bearing, not a tuning knob. The key is a source address or a subject, and an attacker
   * chooses how many of those to present — an unbounded map is memory whose size the ATTACKER
   * picks, which is a denial of service against the component whose job is preventing one.
   */
  maxKeys?: number;
  now?: () => number;
}

const DEFAULT_MAX_KEYS = 20_000;

export class RateLimiter {
  readonly policy: RateLimitPolicy;
  readonly #buckets = new Map<string, Bucket>();
  readonly #maxKeys: number;
  readonly #now: () => number;
  /** Tokens per millisecond. */
  readonly #rate: number;

  constructor(policy: RateLimitPolicy, options: RateLimiterOptions = {}) {
    if (policy.limit <= 0 || policy.windowMs <= 0) {
      // A zero limit would refuse everything forever, which is a configuration mistake that should
      // fail at startup rather than take the platform off the air at the first request.
      throw new Error(`invalid rate-limit policy: ${policy.limit} per ${policy.windowMs}ms`);
    }
    this.policy = policy;
    this.#maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
    this.#now = options.now ?? Date.now;
    this.#rate = policy.limit / policy.windowMs;
  }

  /** Spend one token for `key`. */
  check(key: string): RateLimitDecision {
    const now = this.#now();
    const bucket = this.#buckets.get(key);

    if (bucket === undefined && !this.#makeRoom()) {
      // FAIL OPEN. Refusing here would mean an attacker who fills the table can deny service to
      // everyone else — turning the protection into the attack it exists to stop. The keys already
      // being tracked stay limited; only genuinely new ones slip through, and the caller counts it.
      return { allowed: true, remaining: this.policy.limit - 1, retryAfterMs: 0, untracked: true };
    }

    const tokens = bucket === undefined ? this.policy.limit : this.#refill(bucket, now);

    if (tokens < 1) {
      // Not stored back as a fractional spend: the bucket is empty and the caller is told when one
      // token will exist. Rounded up, because reporting "retry in 0ms" invites a hot loop.
      this.#buckets.set(key, { tokens, updatedAt: now });
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.ceil((1 - tokens) / this.#rate),
      };
    }

    const left = tokens - 1;
    this.#buckets.set(key, { tokens: left, updatedAt: now });
    return { allowed: true, remaining: Math.floor(left), retryAfterMs: 0 };
  }

  /** Tracked keys. Exposed so a test can assert the bound actually holds. */
  get size(): number {
    return this.#buckets.size;
  }

  #refill(bucket: Bucket, now: number): number {
    const elapsed = Math.max(0, now - bucket.updatedAt);
    return Math.min(this.policy.limit, bucket.tokens + elapsed * this.#rate);
  }

  /**
   * Make space if the table is full. Returns false only when it could not.
   *
   * Dropping a FULL bucket is lossless: a bucket refilled to capacity is indistinguishable from
   * one that never existed, so an idle key costs nothing to forget and rediscover. That makes the
   * common case — many short-lived clients — free, and leaves the hard case to fail-open.
   */
  #makeRoom(): boolean {
    if (this.#buckets.size < this.#maxKeys) return true;

    const now = this.#now();
    for (const [key, bucket] of this.#buckets) {
      if (this.#refill(bucket, now) >= this.policy.limit) this.#buckets.delete(key);
    }
    return this.#buckets.size < this.#maxKeys;
  }
}

/**
 * The client address to key on.
 *
 * `x-forwarded-for` is ATTACKER-CONTROLLED unless something trusted sets it. When the gateway is
 * the edge — which it is today, exposed by NodePort with no ingress in `infra/k8s/base` — honouring
 * that header would let any client pick its own rate-limit key and rotate it per request, which is
 * indistinguishable from having no limiter at all. So it is off by default and switched on
 * deliberately, once a proxy that overwrites the header actually sits in front.
 */
export function clientAddress(
  req: { ip: string; headers: Record<string, string | string[] | undefined> },
  trustProxy: boolean,
): string {
  if (!trustProxy) return req.ip;
  const forwarded = req.headers['x-forwarded-for'];
  const first = typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined;
  return first !== undefined && first !== '' ? first : req.ip;
}
