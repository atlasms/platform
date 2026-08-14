// Per-request access records (#245).
//
// The gateway has logged one line per request since EP-08.6. Nothing else did, so "show me
// everything for this request" — the panel the whole correlation-id apparatus exists for — returned
// exactly ONE line for an ordinary request, however many services it touched.
//
// THE VOLUME DECISION, made deliberately because the issue asks for it to be.
//
// An access line per service multiplies log volume by roughly the number of hops, and ADR-0003
// already names footprint as the main argument against shipping the observability stack at all. So
// the default is NOT "log everything":
//
//   - Every non-2xx is logged. That is when the correlation view is actually read, and it is the
//     case where a complete picture is worth paying for.
//   - Every SLOW request is logged, whatever its status. A 200 that took four seconds is the one an
//     operator is hunting, and it is invisible to a status filter.
//   - Everything else is sampled, defaulting to OFF.
//
// The reasoning behind that default: a successful, fast request is already fully described by the
// golden signals — rate, status class, and a latency histogram, per route. A log line for it adds
// volume and says nothing the histogram does not. Logs answer "what happened to THIS request";
// metrics answer "what is happening in aggregate", and duplicating the second in the first is how
// a log bill grows without anyone getting a better answer.
//
// The GATEWAY keeps logging every request, and that difference is intentional: it is the edge, so
// its log is the one place every request appears exactly once, and it is the record an operator
// reaches for when asking what the outside world sent.

/** One finished request, in the shape the gateway already emits. */
export interface AccessRecord {
  requestId: string;
  method: string;
  /** The route TEMPLATE, never the raw path — see the note on {@link accessRecord}. */
  route: string;
  status: number;
  latencyMs: number;
  userId?: string;
  traceId?: string;
  at: string;
}

export interface AccessLogPolicy {
  /** Always log at or above this status. Default 400 — every refusal and every failure. */
  minStatus?: number;
  /** Always log a request slower than this, whatever its status. Default 1000ms. */
  slowMs?: number;
  /**
   * Fraction of everything else to log, 0..1. Default 0.
   *
   * Raise it when a specific investigation needs the happy path; leave it at 0 the rest of the
   * time, because the golden signals already cover it.
   */
  sampleRatio?: number;
}

export const DEFAULT_ACCESS_POLICY: Required<AccessLogPolicy> = {
  minStatus: 400,
  slowMs: 1_000,
  sampleRatio: 0,
};

/**
 * Should this request be written to the access log?
 *
 * `random` is injectable so the sampling decision is testable — a sampled logger tested against a
 * real RNG either asserts nothing or is flaky, and both end with the sampling never being verified.
 */
export function shouldLogAccess(
  record: Pick<AccessRecord, 'status' | 'latencyMs'>,
  policy: AccessLogPolicy = {},
  random: () => number = Math.random,
): boolean {
  const { minStatus, slowMs, sampleRatio } = { ...DEFAULT_ACCESS_POLICY, ...policy };
  if (record.status >= minStatus) return true;
  if (record.latencyMs >= slowMs) return true;
  return sampleRatio > 0 && random() < sampleRatio;
}

/**
 * Build the record.
 *
 * `route` must be the TEMPLATE. A raw path puts a ULID in a log field that operators then filter
 * on, which is the Loki version of the cardinality trap the metrics already avoid — and it makes
 * "how slow is GET /assets/:id" unanswerable, because every request is its own route.
 */
export function accessRecord(input: {
  requestId: string;
  method: string;
  route: string;
  status: number;
  latencyMs: number;
  userId?: string;
  traceId?: string;
  now?: () => number;
}): AccessRecord {
  return {
    requestId: input.requestId,
    method: input.method,
    route: input.route,
    status: input.status,
    latencyMs: input.latencyMs,
    // Omitted rather than set to undefined: a JSON log line with `"userId": null` invites a query
    // that matches it, and an unauthenticated request has no user rather than a null one.
    ...(input.userId !== undefined ? { userId: input.userId } : {}),
    ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
    at: new Date((input.now ?? Date.now)()).toISOString(),
  };
}
