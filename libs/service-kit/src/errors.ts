// A small error taxonomy shared by every service. Domain code throws these; the HTTP edge maps
// them to ONE problem document — RFC 9457 (Problem Details for HTTP APIs), served as
// `application/problem+json` — and event consumers use the same codes.
//
// The document is RFC 9457 ADDITIVELY (EP-04.6, #72). `type`, `title`, `status`, `detail` and
// `instance` are the RFC's members; `code`, `message` and `correlationId` predate them and stay,
// because every client, every test and every smoke assertion on this platform reads `code` as the
// machine key — a closed enum is a better one than a URI — and `message` as the text. The RFC
// members are derived from them, so the two views cannot disagree.
export type ErrorCode =
  | 'VALIDATION'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'INTERNAL';

/** The media type every problem document is served as (RFC 9457 §3). */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/**
 * `type` is a URI that identifies the problem KIND — one per `ErrorCode`, stable, and a client may
 * key on it. It is not required to resolve; RFC 9457 §3.1.1 says so. The host is the platform's
 * documentation namespace, the same one the JSON Schemas' `$id`s use.
 */
export const PROBLEM_TYPE_BASE = 'https://atlas.example/problems/';

/** RFC 9457 `title`: a short, human-readable summary of the problem type — the same for every occurrence. */
export const PROBLEM_TITLES: Record<ErrorCode, string> = {
  VALIDATION: 'Request is not valid',
  UNAUTHORIZED: 'Authentication required',
  FORBIDDEN: 'Not permitted',
  NOT_FOUND: 'Not found',
  CONFLICT: 'Conflicts with current state',
  PAYLOAD_TOO_LARGE: 'Payload too large',
  RATE_LIMITED: 'Too many requests',
  UNAVAILABLE: 'Temporarily unavailable',
  INTERNAL: 'Internal error',
};

export interface Problem {
  /** RFC 9457 §3.1.1 — a URI for the problem type; `PROBLEM_TYPE_BASE + code.toLowerCase()`. */
  type: string;
  /** RFC 9457 §3.1.2 — the type's summary; constant per `code`. */
  title: string;
  /** RFC 9457 §3.1.3 — the HTTP status, repeated here for a client that has lost the response line. */
  status: number;
  /** RFC 9457 §3.1.4 — this occurrence's explanation; always equal to `message`. */
  detail: string;
  /** RFC 9457 §3.1.5 — this occurrence's identifier; a URN over the correlation id, when there is one. */
  instance?: string;
  /** The platform's machine key. A closed enum; the thing a client switches on. */
  code: ErrorCode;
  /** The platform's text. Always equal to `detail`. */
  message: string;
  details?: unknown;
  correlationId?: string;
}

/** Build the document from its platform half. Exported so a responder that is not an AppError can use it. */
export function problemOf(input: {
  code: ErrorCode;
  status: number;
  message: string;
  details?: unknown;
  correlationId?: string;
}): Problem {
  return {
    type: PROBLEM_TYPE_BASE + input.code.toLowerCase(),
    title: PROBLEM_TITLES[input.code],
    status: input.status,
    detail: input.message,
    ...(input.correlationId !== undefined
      ? { instance: `urn:atlas:correlation:${input.correlationId}` }
      : {}),
    code: input.code,
    message: input.message,
    // Optional keys are OMITTED rather than set to undefined (exactOptionalPropertyTypes). That is
    // also the shape we want on the wire: no null-ish noise in the document.
    ...(input.details !== undefined ? { details: input.details } : {}),
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  };
}

export class AppError extends Error {
  // Assigned in the body rather than declared as constructor parameter properties: those EMIT
  // code, and Node's native TypeScript support is strip-only. Keeping every file strip-only means
  // production runs `node src/main.ts` with no transform, no flag and no build step
  // (infra/docker/Dockerfile). An eslint rule enforces it.
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, status: number, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
    this.name = new.target.name;
  }
  toProblem(correlationId?: string): Problem {
    return problemOf({
      code: this.code,
      status: this.status,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
      ...(correlationId !== undefined ? { correlationId } : {}),
    });
  }
}

export class ValidationError extends AppError {
  constructor(m = 'Validation failed', d?: unknown) {
    super('VALIDATION', 422, m, d);
  }
}
export class Unauthorized extends AppError {
  constructor(m = 'Unauthorized') {
    super('UNAUTHORIZED', 401, m);
  }
}
export class Forbidden extends AppError {
  constructor(m = 'Forbidden') {
    super('FORBIDDEN', 403, m);
  }
}
export class NotFound extends AppError {
  constructor(m = 'Not found') {
    super('NOT_FOUND', 404, m);
  }
}
export class Conflict extends AppError {
  constructor(m = 'Conflict', d?: unknown) {
    super('CONFLICT', 409, m, d);
  }
}
/**
 * The body exceeded the configured cap.
 *
 * A real member of the taxonomy rather than something the edge invents, because Fastify raises
 * `FST_ERR_CTP_BODY_TOO_LARGE` with a 413 on its own and `toProblem` maps anything it does not
 * recognise to INTERNAL/500 — so without this the caller is told the SERVER broke when in fact
 * they sent too much, and an operator sees a 5xx spike from ordinary oversized uploads.
 */
export class PayloadTooLarge extends AppError {
  constructor(m = 'Request body too large') {
    super('PAYLOAD_TOO_LARGE', 413, m);
  }
}

/** Too many requests. `Retry-After` belongs on the response; this carries the taxonomy half. */
export class TooManyRequests extends AppError {
  constructor(m = 'Too many requests', d?: unknown) {
    super('RATE_LIMITED', 429, m, d);
  }
}

/**
 * A dependency this request needs is down — the hot index, say — and the request itself is fine:
 * retry it later. Distinct from INTERNAL because a 500 says "the server broke" and gets logged as
 * such, while this is an outage the health registry already reports; and distinct on the wire so
 * a client can back off rather than surface an error.
 */
export class Unavailable extends AppError {
  constructor(m = 'Temporarily unavailable') {
    super('UNAVAILABLE', 503, m);
  }
}

export class Internal extends AppError {
  constructor(m = 'Internal error') {
    super('INTERNAL', 500, m);
  }
}

/** Normalize any thrown value to a Problem — the single mapping the HTTP edge uses. */
export function toProblem(err: unknown, correlationId?: string): Problem {
  if (err instanceof AppError) return err.toProblem(correlationId);
  return problemOf({
    code: 'INTERNAL',
    status: 500,
    message: 'Internal error',
    ...(correlationId !== undefined ? { correlationId } : {}),
  });
}
