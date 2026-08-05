import { inject } from '@angular/core';
import {
  HttpErrorResponse,
  type HttpEvent,
  type HttpHandlerFn,
  type HttpInterceptorFn,
  type HttpRequest,
} from '@angular/common/http';
import { catchError, from, switchMap, throwError, type Observable } from 'rxjs';
import { AuthService, SKIP_AUTH } from './auth.service.ts';

/**
 * Attach the bearer, and recover ONCE from an expired one.
 *
 * Access tokens are short-lived by design, so expiry mid-session is the normal case rather than an
 * error — without this, every screen would have to handle a 401 that means nothing more than "the
 * clock moved".
 *
 * **Retried exactly once.** If the retry also comes back 401 the answer is genuine — the grant was
 * revoked, or the session is over — and retrying again would loop against a server that has already
 * said no.
 */
export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const auth = inject(AuthService);

  // The auth endpoints opt out: a 401 from /auth/refresh means the session is over, and refreshing
  // in response to it would recurse.
  if (request.context.get(SKIP_AUTH)) return next(request);

  return next(withBearer(request, auth.token())).pipe(
    catchError((error: unknown) => {
      if (!(error instanceof HttpErrorResponse) || error.status !== 401) {
        return throwError(() => error);
      }

      return from(auth.refresh()).pipe(
        switchMap((token): Observable<HttpEvent<unknown>> => {
          // No new token means the session is genuinely over. Surface the ORIGINAL 401 rather than
          // a refresh failure — the caller asked for a resource, and that is the answer to report.
          if (token === null) return throwError(() => error);
          return next(withBearer(request, token));
        }),
      );
    }),
  );
};

function withBearer(request: HttpRequest<unknown>, token: string | null): HttpRequest<unknown> {
  if (token === null) return request;
  return request.clone({ setHeaders: { authorization: `Bearer ${token}` } });
}

/** Exported for the spec, which drives the interceptor directly rather than through HttpClient. */
export type { HttpHandlerFn };
