import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { API_BASE_URL } from './api.ts';
import { ApiClient, urlOf } from './api-client.ts';
import { skipAuth, SKIP_AUTH } from './auth.service.ts';
import { IamOperations } from './generated/iam.operations.ts';
import { MamOperations } from './generated/mam.operations.ts';

describe('urlOf', () => {
  it('substitutes every path parameter, percent-encoded', () => {
    expect(urlOf('/gw', MamOperations.getAsset, { params: { id: 'asset/with slash?x#y' } })).toBe(
      '/gw/api/v1/assets/asset%2Fwith%20slash%3Fx%23y',
    );
  });

  it('takes no parameters for a path that has none', () => {
    expect(urlOf('', MamOperations.listAssets)).toBe('/api/v1/assets');
  });

  it('is a thrown error, not a literal "{id}" on the wire, when a value is missing', () => {
    // The type forbids this; the runtime check is for a caller that has cast its way past it.
    expect(() =>
      urlOf('', MamOperations.getAsset, { params: { id: undefined as unknown as string } }),
    ).toThrow(/missing path param id/);
  });

  it('serves the auth operations at the root, as the gateway does (path-level servers)', () => {
    expect(urlOf('', IamOperations.login)).toBe('/auth/login');
    expect(urlOf('', IamOperations.getJwks)).toBe('/.well-known/jwks.json');
    expect(urlOf('', IamOperations.getEffectivePermissions, { params: { id: 'me' } })).toBe(
      '/api/v1/users/me/effective-permissions',
    );
  });

  it('holds the parameter contract at the type level', () => {
    // @ts-expect-error — /assets/{id} needs an id
    void (() => urlOf('', MamOperations.getAsset));
    // @ts-expect-error — the parameter is `id`, not `assetId`
    void (() => urlOf('', MamOperations.getAsset, { params: { assetId: 'x' } }));
    // @ts-expect-error — /assets has no parameters to fill
    void (() => urlOf('', MamOperations.listAssets, { params: { id: 'x' } }));
  });
});

describe('ApiClient', () => {
  function setup() {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/gateway' },
      ],
    });
    return { api: TestBed.inject(ApiClient), http: TestBed.inject(HttpTestingController) };
  }

  it('takes the verb and the path from the operation, and skips a query value that is undefined', () => {
    const { api, http } = setup();
    let body: unknown;
    api
      .call(MamOperations.listAssets, { query: { limit: 20, cursor: undefined, order: 'desc' } })
      .as<{ items: unknown[] }>()
      .subscribe((b) => (body = b));
    const req = http.expectOne(
      (c) =>
        c.url === '/gateway/api/v1/assets' &&
        c.params.get('limit') === '20' &&
        c.params.get('order') === 'desc' &&
        !c.params.has('cursor'),
    );
    expect(req.request.method).toBe('GET');
    req.flush({ items: [] });
    expect(body).toEqual({ items: [] });
    http.verify();
  });

  it('sends the body and the request context through', () => {
    const { api, http } = setup();
    api
      .call(IamOperations.login, { body: { username: 'u', password: 'p' }, context: skipAuth() })
      .as<unknown>()
      .subscribe();
    const req = http.expectOne('/gateway/auth/login');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ username: 'u', password: 'p' });
    expect(req.request.context.get(SKIP_AUTH)).toBe(true);
    req.flush({});
    http.verify();
  });

  it('is cold: nothing is sent until the caller subscribes', () => {
    const { api, http } = setup();
    api
      .call(MamOperations.updateAsset, { params: { id: 'a' }, body: { title: 'x' } })
      .as<unknown>();
    http.expectNone('/gateway/api/v1/assets/a');
    http.verify();
  });
});
