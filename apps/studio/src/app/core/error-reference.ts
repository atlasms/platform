import { Injectable, signal } from '@angular/core';
import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';

/**
 * The reference of the last request the platform refused or failed (EP-21.5).
 *
 * Every service answers an error with a problem document carrying its `correlationId` — the id the
 * gateway minted for the request, on every log line, span and audit record it produced. Studio
 * never showed it: a pilot user could only report "saving failed at about ten", and whoever triaged
 * it had nothing to search for. The status bar now shows the last one, copyable, so a report can
 * carry the one string that finds the whole flow in the logs (docs/operations/pilot-feedback.md).
 */
export interface ErrorReference {
  readonly correlationId: string;
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly at: string;
}

@Injectable({ providedIn: 'root' })
export class ErrorReferenceStore {
  private readonly current = signal<ErrorReference | undefined>(undefined);
  readonly last = this.current.asReadonly();

  record(reference: ErrorReference): void {
    this.current.set(reference);
  }

  clear(): void {
    this.current.set(undefined);
  }
}

/**
 * Records the reference of every failed request — 4xx and 5xx alike, since "the save was refused"
 * is a report too — except a 401, which the auth interceptor resolves by refreshing, and a response
 * that never reached the platform (status 0: nothing was logged, so there is nothing to find).
 *
 * Registered OUTSIDE the auth interceptor, so it sees the outcome after a refresh-and-retry rather
 * than the 401 that started it. The error itself goes on to the caller unchanged.
 */
export const errorReferenceInterceptor: HttpInterceptorFn = (request, next) => {
  const store = inject(ErrorReferenceStore);
  return next(request).pipe(
    catchError((error: unknown) => {
      if (error instanceof HttpErrorResponse && error.status >= 400 && error.status !== 401) {
        const fromBody = (error.error as { correlationId?: unknown } | null)?.correlationId;
        const correlationId =
          typeof fromBody === 'string' ? fromBody : error.headers.get('x-correlation-id');
        if (correlationId) {
          store.record({
            correlationId,
            status: error.status,
            method: request.method,
            path: new URL(request.urlWithParams, 'http://studio.local').pathname,
            at: new Date().toISOString(),
          });
        }
      }
      return throwError(() => error);
    }),
  );
};
