// A small error taxonomy shared by every service. Domain code throws these; the HTTP edge maps
// them to a consistent problem+JSON body, and event consumers use the same codes.
export type ErrorCode =
  'VALIDATION' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL';

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
