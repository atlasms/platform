import { TestBed } from '@angular/core/testing';
import {
  HttpClient,
  provideHttpClient,
  withInterceptors,
  type HttpErrorResponse,
} from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService, readClaims } from './auth.service.ts';
import { authInterceptor } from './auth.interceptor.ts';
import { SessionStore } from './session.store.ts';

/**
 * Let every pending microtask AND the promise chains inside the interceptor settle.
 *
 * A bare `await Promise.resolve()` only drains one tick, which is not enough: a refresh-and-retry
 * runs a fetch promise, a `finally`, and an rxjs `switchMap` before the retried request is issued.
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A syntactically real JWT. Unsigned — Studio decodes claims, it never verifies them. */
function fakeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'RS256' })}.${b64(claims)}.signature-not-checked-here`;
}

const ACCESS = fakeJwt({ sub: 'u1', channelId: 'ch12', permVersion: 1 });
const ACCESS_2 = fakeJwt({ sub: 'u1', channelId: 'ch12', permVersion: 2 });

const POLICY = {
  subjectId: 'u1',
  permVersion: 1,
  rules: [{ id: 'r', permissions: ['asset:read'], scope: { channelIds: ['ch12'] } }],
};

function setup() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideHttpClient(withInterceptors([authInterceptor])), provideHttpClientTesting()],
  });
  return {
    auth: TestBed.inject(AuthService),
    session: TestBed.inject(SessionStore),
    http: TestBed.inject(HttpTestingController),
  };
}

/** Answer login + the policy fetch that follows it, leaving a fully signed-in session. */
async function signIn(auth: AuthService, http: HttpTestingController): Promise<void> {
  const done = auth.signIn('dev', 'dev-password');
  http
    .expectOne('/auth/login')
    .flush({ accessToken: ACCESS, refreshToken: 'refresh-1', expiresIn: '15m', permVersion: 1 });
  await settle();
  http.expectOne('/api/v1/users/me/effective-permissions').flush(POLICY);
  await done;
}

describe('AuthService', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('signs in, then opens the session from the policy IAM returned', async () => {
    await signIn(ctx.auth, ctx.http);

    expect(ctx.session.isAuthenticated()).toBe(true);
    expect(ctx.session.userId()).toBe('u1');
    // The channel comes from the token's claims. Without it every permission check would be asked
    // too broadly — lenient evaluation reads a missing channelId as "any channel".
    expect(ctx.session.channelId()).toBe('ch12');
    expect(ctx.auth.token()).toBe(ACCESS);
  });

  it('a failed sign-in leaves no session at all', async () => {
    const attempt = ctx.auth.signIn('dev', 'wrong');
    ctx.http
      .expectOne('/auth/login')
      .flush({ code: 'UNAUTHORIZED' }, { status: 401, statusText: 'Unauthorized' });

    await expect(attempt).rejects.toBeDefined();
    expect(ctx.session.isAuthenticated()).toBe(false);
    expect(ctx.auth.token()).toBe(null);
    expect(ctx.auth.busy()).toBe(false);
  });

  it('DANGER: concurrent refreshes make ONE call — reuse revokes the whole family', async () => {
    // IAM rotates refresh tokens and treats a reused one as a breach signal, revoking every
    // session in the family. Two requests refreshing at once is the NORMAL case when a token
    // expires while a screen loads, so without single-flight this signs the user out everywhere.
    await signIn(ctx.auth, ctx.http);

    const both = Promise.all([ctx.auth.refresh(), ctx.auth.refresh()]);
    const requests = ctx.http.match('/auth/refresh');
    expect(requests.length).toBe(1);

    requests[0]!.flush({
      accessToken: ACCESS_2,
      refreshToken: 'refresh-2',
      expiresIn: '15m',
      permVersion: 1,
    });

    expect(await both).toEqual([ACCESS_2, ACCESS_2]);
    expect(ctx.auth.token()).toBe(ACCESS_2);
  });

  it('a second refresh AFTER the first settles presents the ROTATED token', async () => {
    // Rotation means the old token is spent. Sending it again is precisely what IAM reads as reuse.
    await signIn(ctx.auth, ctx.http);

    const first = ctx.auth.refresh();
    const r1 = ctx.http.expectOne('/auth/refresh');
    expect(r1.request.body.refreshToken).toBe('refresh-1');
    r1.flush({
      accessToken: ACCESS_2,
      refreshToken: 'refresh-2',
      expiresIn: '15m',
      permVersion: 1,
    });
    await first;

    const second = ctx.auth.refresh();
    const r2 = ctx.http.expectOne('/auth/refresh');
    expect(r2.request.body.refreshToken).toBe('refresh-2');
    r2.flush({ accessToken: ACCESS, refreshToken: 'refresh-3', expiresIn: '15m', permVersion: 1 });
    await second;
  });

  it('a rejected refresh ends the session rather than retrying a dead credential', async () => {
    await signIn(ctx.auth, ctx.http);

    const attempt = ctx.auth.refresh();
    ctx.http.expectOne('/auth/refresh').flush({}, { status: 401, statusText: 'Unauthorized' });

    expect(await attempt).toBe(null);
    expect(ctx.session.isAuthenticated()).toBe(false);
    // Nothing left to retry with. If the rejection WAS reuse detection, retrying is what turns one
    // revoked family into a loop against a server that has already said no.
    expect(await ctx.auth.refresh()).toBe(null);
    ctx.http.expectNone('/auth/refresh');
  });

  it('signing out clears the session even if the server call fails', async () => {
    await signIn(ctx.auth, ctx.http);

    const done = ctx.auth.signOut();
    ctx.http.expectOne('/auth/logout').error(new ProgressEvent('network'));
    await done;

    // The user asked to leave. A failed revocation must never leave the browser looking signed in.
    expect(ctx.session.isAuthenticated()).toBe(false);
    expect(ctx.auth.token()).toBe(null);
  });

  it('SECURITY: tokens are never written to browser storage', async () => {
    // localStorage and sessionStorage are readable by any script on the origin, so persisting the
    // refresh token there hands a long-lived credential to a single XSS.
    await signIn(ctx.auth, ctx.http);

    const dump = JSON.stringify([{ ...localStorage }, { ...sessionStorage }]);
    expect(dump).not.toContain('refresh-1');
    expect(dump).not.toContain(ACCESS);
  });
});

describe('readClaims', () => {
  it('reads the claims without pretending to verify them', () => {
    expect(readClaims(ACCESS)?.channelId).toBe('ch12');
  });

  it('returns null for anything that is not a token', () => {
    for (const bad of [null, '', 'not.a.token', 'a.b']) {
      expect(readClaims(bad)).toBe(null);
    }
  });
});

describe('authInterceptor', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('attaches the bearer to an API call', async () => {
    await signIn(ctx.auth, ctx.http);

    void fetchAssets();
    const req = ctx.http.expectOne('/api/v1/assets');
    expect(req.request.headers.get('authorization')).toBe(`Bearer ${ACCESS}`);
    req.flush([]);
  });

  it('refreshes once on a 401 and retries with the NEW token', async () => {
    // An access token expiring mid-session is the normal case, not an error. Without this every
    // screen would have to handle a 401 that means only "the clock moved".
    await signIn(ctx.auth, ctx.http);

    const result = fetchAssets();
    ctx.http.expectOne('/api/v1/assets').flush({}, { status: 401, statusText: 'Unauthorized' });
    await settle();

    ctx.http
      .expectOne('/auth/refresh')
      .flush({ accessToken: ACCESS_2, refreshToken: 'r2', expiresIn: '15m', permVersion: 1 });
    await settle();

    const retried = ctx.http.expectOne('/api/v1/assets');
    expect(retried.request.headers.get('authorization')).toBe(`Bearer ${ACCESS_2}`);
    retried.flush([{ id: 'a1' }]);

    expect(await result).toEqual([{ id: 'a1' }]);
  });

  it('DANGER: retries exactly once — a second 401 is a real answer', async () => {
    // Otherwise a revoked grant becomes an infinite refresh/retry loop against a server that has
    // already said no.
    await signIn(ctx.auth, ctx.http);

    const result: Promise<HttpErrorResponse> = fetchAssets().then(
      () => {
        throw new Error('the request was expected to fail');
      },
      (e: unknown) => e as HttpErrorResponse,
    );
    ctx.http.expectOne('/api/v1/assets').flush({}, { status: 401, statusText: 'Unauthorized' });
    await settle();

    ctx.http
      .expectOne('/auth/refresh')
      .flush({ accessToken: ACCESS_2, refreshToken: 'r2', expiresIn: '15m', permVersion: 1 });
    await settle();

    ctx.http.expectOne('/api/v1/assets').flush({}, { status: 401, statusText: 'Unauthorized' });

    expect((await result).status).toBe(401);
    ctx.http.expectNone('/api/v1/assets');
    ctx.http.expectNone('/auth/refresh');
  });

  it('leaves a non-401 alone', async () => {
    await signIn(ctx.auth, ctx.http);

    const result: Promise<HttpErrorResponse> = fetchAssets().then(
      () => {
        throw new Error('the request was expected to fail');
      },
      (e: unknown) => e as HttpErrorResponse,
    );
    ctx.http.expectOne('/api/v1/assets').flush({}, { status: 403, statusText: 'Forbidden' });

    expect((await result).status).toBe(403);
    // A 403 is the server's considered answer about permissions. Refreshing would be asking the
    // same question with a newer token and getting the same refusal.
    ctx.http.expectNone('/auth/refresh');
  });

  it('does not attempt a refresh for the auth endpoints themselves', async () => {
    // A 401 from /auth/login is the ANSWER, not an expired token.
    const attempt = ctx.auth.signIn('dev', 'wrong');
    ctx.http.expectOne('/auth/login').flush({}, { status: 401, statusText: 'Unauthorized' });

    await expect(attempt).rejects.toBeDefined();
    ctx.http.expectNone('/auth/refresh');
  });
});

/** A representative authenticated API call. */
function fetchAssets(): Promise<unknown> {
  const http = TestBed.inject(HttpClient);
  return new Promise((resolve, reject) => {
    http.get('/api/v1/assets').subscribe({ next: resolve, error: reject });
  });
}
