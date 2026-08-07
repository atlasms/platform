// W3C Trace Context — the one header that makes a trace span services (EP-04.7, ADR-0004).
//
// Spec: https://www.w3.org/TR/trace-context/. Small, fully specified, and stable — which is why
// ADR-0004 chose to implement it rather than take a 27 MB dependency to parse one header.
//
// The format is fixed-width and unforgiving:
//
//   traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
//                ^^ ^------------ 32 hex -----------^ ^--- 16 hex ---^ ^^
//                version          trace id            span id          flags
//
// Getting any of this subtly wrong does not throw — it produces traces that silently do not join
// up, which is the failure mode tracing exists to prevent. Hence the tests.

/** A parsed, VALID trace context. Constructing one of these means the header was well-formed. */
export interface TraceContext {
  /** 32 lowercase hex characters, never all zero. */
  traceId: string;
  /** 16 lowercase hex characters, never all zero. The caller's span — our parent. */
  spanId: string;
  /** The `sampled` flag (bit 0 of the trace-flags octet). */
  sampled: boolean;
}

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

export const TRACEPARENT_HEADER = 'traceparent';

/**
 * Parse a `traceparent`, or return undefined if it is not one we can safely continue.
 *
 * **Never throws, and never partially trusts.** A malformed header means "start a new trace", not
 * "propagate garbage" — a trace id that fails validation downstream would break the trace anyway,
 * and an exception here would turn a cosmetic header problem into a failed request.
 */
export function parseTraceparent(value: unknown): TraceContext | undefined {
  if (typeof value !== 'string') return undefined;

  const match = TRACEPARENT.exec(value.trim());
  if (!match) return undefined;

  const [, version, traceId, spanId, flags] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];

  // Version ff is explicitly forbidden by the spec. Any OTHER unknown version is forward
  // compatible: the spec requires parsing the known fields and continuing the trace, so a future
  // version-01 caller is honoured rather than dropped — dropping it would silently break traces
  // the day anything upstream upgrades.
  if (version === 'ff') return undefined;

  // All-zero ids are invalid. They are also what a naive implementation emits when it has nothing
  // to say, so accepting them would merge every such caller's requests into one enormous trace.
  if (traceId === ZERO_TRACE || spanId === ZERO_SPAN) return undefined;

  return {
    traceId,
    spanId,
    // Bit 0 of the flags octet. The other bits are reserved — masking rather than comparing to
    // "01" keeps a caller that sets a future flag from being read as unsampled.
    sampled: (Number.parseInt(flags, 16) & 0x01) === 0x01,
  };
}

/** Render the header a downstream hop should receive. */
export function formatTraceparent(ctx: TraceContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.sampled ? '01' : '00'}`;
}

/**
 * Random ids, from a cryptographic source.
 *
 * Not for secrecy — for collision resistance. `Math.random()` in Node is a shared xorshift stream
 * that is neither seeded per process nor guaranteed distinct across forks, and two services minting
 * the same trace id merges two unrelated requests into one trace that makes no sense.
 */
export const newTraceId = (): string => randomHex(16);
export const newSpanId = (): string => randomHex(8);

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = '';
  for (const b of buf) out += b.toString(16).padStart(2, '0');
  return out;
}
