// A small error taxonomy shared by every service. Domain code throws these; the HTTP edge maps
// them to a consistent problem+JSON body, and event consumers use the same codes.
export type ErrorCode =
  | 'VALIDATION'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export interface Problem {
  code: ErrorCode;
  status: number;
  message: string;
  details?: unknown;
  correlationId?: string;
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
    // Optional keys are OMITTED rather than set to undefined (exactOptionalPropertyTypes).
    // That is also the shape we want on the wire: no null-ish noise in problem+JSON.
    return {
      code: this.code,
      status: this.status,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
      ...(correlationId !== undefined ? { correlationId } : {}),
    };
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

export class Internal extends AppError {
  constructor(m = 'Internal error') {
    super('INTERNAL', 500, m);
  }
}

/** Normalize any thrown value to a Problem — the single mapping the HTTP edge uses. */
export function toProblem(err: unknown, correlationId?: string): Problem {
  if (err instanceof AppError) return err.toProblem(correlationId);
  return {
    code: 'INTERNAL',
    status: 500,
    message: 'Internal error',
    ...(correlationId !== undefined ? { correlationId } : {}),
  };
}
