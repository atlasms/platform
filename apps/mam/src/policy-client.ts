// Where a caller's permissions come from in a deployment.
//
// IAM owns grants; MAM enforces them. So MAM asks IAM for the compiled policy
// (`GET /api/v1/users/me/effective-permissions`) and caches it briefly — the alternative, one
// authorization round trip per request, puts IAM on the critical path of every read.

import type { EffectivePolicy } from '@atlas/policy';

export interface PolicyClientOptions {
  /** IAM's base URL, e.g. `http://iam:3000`. */
  origin: string;
  /**
   * How long a compiled policy may be reused.
   *
   * This is a REVOCATION WINDOW, not a performance knob: a permission removed in IAM stays live
   * here until the entry expires. Short enough that "we revoked their access" is true within
   * seconds; long enough that a burst of requests is one fetch, not hundreds.
   */
  ttlMs?: number;
  /** Bound on cached subjects, so an unbounded set of ids cannot grow this without limit. */
  maxEntries?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface Entry {
  policy: EffectivePolicy;
  expiresAt: number;
}

export class PolicyClient {
  private readonly options: Required<Omit<PolicyClientOptions, 'fetchImpl' | 'now'>>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly cache = new Map<string, Entry>();
  /** In-flight fetches, so N concurrent requests for one subject make ONE call to IAM. */
  private readonly inflight = new Map<string, Promise<EffectivePolicy | undefined>>();

  constructor(options: PolicyClientOptions) {
    this.options = {
      origin: options.origin,
      ttlMs: options.ttlMs ?? 30_000,
      maxEntries: options.maxEntries ?? 5_000,
    };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /**
   * The caller's compiled policy, or `undefined` if it cannot be established.
   *
   * FAILS CLOSED. An unreachable IAM, a 500, a malformed body — all return undefined, which the
   * HTTP layer turns into 401. The tempting alternatives are both wrong: serving a stale entry
   * makes a revoked permission outlive its revocation for as long as IAM is down, and treating
   * "unknown" as "no rules" would quietly become "allowed" the moment anything defaults to lenient.
   */
  async policyFor(userId: string): Promise<EffectivePolicy | undefined> {
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > this.now()) return cached.policy;

    const existing = this.inflight.get(userId);
    if (existing) return existing;

    const pending = this.fetchPolicy(userId).finally(() => this.inflight.delete(userId));
    this.inflight.set(userId, pending);
    return pending;
  }

  /** Drop a subject's cached policy — for a permission-change event, once IAM emits one. */
  invalidate(userId?: string): void {
    if (userId === undefined) this.cache.clear();
    else this.cache.delete(userId);
  }

  private async fetchPolicy(userId: string): Promise<EffectivePolicy | undefined> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        new URL('/api/v1/users/me/effective-permissions', this.options.origin),
        // IAM identifies the subject from the gateway-established header, exactly as MAM does.
        // MAM is inside the trust boundary here; it is not presenting the user's token.
        { headers: { 'x-atlas-user': userId } },
      );
    } catch {
      return undefined;
    }
    if (!response.ok) return undefined;

    const body = (await response.json().catch(() => undefined)) as EffectivePolicy | undefined;
    // A body without rules is not an empty policy — it is a response we do not understand, and
    // guessing at its meaning is guessing about authorization.
    if (!body || !Array.isArray(body.rules) || typeof body.subjectId !== 'string') return undefined;

    this.store(userId, body);
    return body;
  }

  private store(userId: string, policy: EffectivePolicy): void {
    if (this.cache.size >= this.options.maxEntries && !this.cache.has(userId)) {
      // Map preserves insertion order, so the first key is the oldest write. Crude, and correct
      // enough: every entry expires on a timer anyway, so this only bounds memory.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(userId, { policy, expiresAt: this.now() + this.options.ttlMs });
  }
}
