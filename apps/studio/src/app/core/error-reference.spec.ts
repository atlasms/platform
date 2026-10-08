// EP-21.5 — the reference a pilot user can quote: the correlation id of the last refused request.

import { TestBed } from '@angular/core/testing';
import { HttpClient, HttpHeaders, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { ErrorReferenceStore, errorReferenceInterceptor } from './error-reference.ts';

const ID = '01K8ZQ0A1B2C3D4E5F6G7H8J9K';

function setup() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([errorReferenceInterceptor])),
      provideHttpClientTesting(),
    ],
  });
  return {
    http: TestBed.inject(HttpClient),
    backend: TestBed.inject(HttpTestingController),
    store: TestBed.inject(ErrorReferenceStore),
  };
}

const fail = (ctx: ReturnType<typeof setup>, url: string, method = 'GET') => {
  let caught: unknown;
  ctx.http.request(method, url).subscribe({ error: (e: unknown) => (caught = e) });
  return { req: ctx.backend.expectOne(url), caught: () => caught };
};

describe('ErrorReferenceStore + errorReferenceInterceptor', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('records the problem document’s correlation id, and the caller still gets the error', () => {
    const { req, caught } = fail(ctx, '/api/v1/assets/a1?x=1', 'PATCH');
    req.flush(
      { code: 'CONFLICT', message: 'changed', correlationId: ID },
      { status: 409, statusText: 'Conflict' },
    );
    expect(ctx.store.last()).toMatchObject({
      correlationId: ID,
      status: 409,
      method: 'PATCH',
      path: '/api/v1/assets/a1',
    });
    expect(caught()).toBeTruthy();
  });

  it('falls back to the x-correlation-id header when the body is not a problem document', () => {
    const { req } = fail(ctx, '/api/v1/schedules');
    req.flush('upstream exploded', {
      status: 502,
      statusText: 'Bad Gateway',
      headers: new HttpHeaders({ 'x-correlation-id': ID }),
    });
    expect(ctx.store.last()?.correlationId).toBe(ID);
  });

  it('ignores a 401 (the auth interceptor’s), a success, and an error with no reference', () => {
    fail(ctx, '/api/v1/a').req.flush(
      { correlationId: ID },
      { status: 401, statusText: 'Unauthorized' },
    );
    ctx.http.get('/api/v1/b').subscribe();
    ctx.backend.expectOne('/api/v1/b').flush({ ok: true });
    fail(ctx, '/api/v1/c').req.flush('no id', { status: 500, statusText: 'Server Error' });
    expect(ctx.store.last()).toBeUndefined();
  });

  it('keeps the LAST one, and clears', () => {
    fail(ctx, '/api/v1/one').req.flush(
      { correlationId: 'first' },
      { status: 500, statusText: 'x' },
    );
    fail(ctx, '/api/v1/two').req.flush(
      { correlationId: 'second' },
      { status: 422, statusText: 'x' },
    );
    expect(ctx.store.last()?.correlationId).toBe('second');
    ctx.store.clear();
    expect(ctx.store.last()).toBeUndefined();
  });
});
