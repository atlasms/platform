// A small error taxonomy shared by every service. Domain code throws these; the HTTP edge maps
// them to a consistent problem+JSON body, and event consumers use the same codes.
export type ErrorCode =
  | 'VALIDATION' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL';

export interface Problem { code: ErrorCode; status: number; message: string; details?: unknown; correlationId?: string; }

export class AppError extends Error {
  constructor(public code: ErrorCode, public status: number, message: string, public details?: unknown) {
    super(message);
    this.name = new.target.name;
  }
  toProblem(correlationId?: string): Problem {
    return { code: this.code, status: this.status, message: this.message, details: this.details, correlationId };
  }
}

export class ValidationError extends AppError { constructor(m = 'Validation failed', d?: unknown) { super('VALIDATION', 422, m, d); } }
export class Unauthorized extends AppError { constructor(m = 'Unauthorized') { super('UNAUTHORIZED', 401, m); } }
export class Forbidden extends AppError { constructor(m = 'Forbidden') { super('FORBIDDEN', 403, m); } }
export class NotFound extends AppError { constructor(m = 'Not found') { super('NOT_FOUND', 404, m); } }
export class Conflict extends AppError { constructor(m = 'Conflict', d?: unknown) { super('CONFLICT', 409, m, d); } }
export class Internal extends AppError { constructor(m = 'Internal error') { super('INTERNAL', 500, m); } }

/** Normalize any thrown value to a Problem — the single mapping the HTTP edge uses. */
export function toProblem(err: unknown, correlationId?: string): Problem {
  if (err instanceof AppError) return err.toProblem(correlationId);
  return { code: 'INTERNAL', status: 500, message: 'Internal error', correlationId };
}
