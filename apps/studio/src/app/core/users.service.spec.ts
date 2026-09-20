// The admin surface's requests (EP-20.7), by method and URL, against the contract's operations
// — and the browser ULID a granted rule carries.

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { API_BASE_URL } from './api.ts';
import { ULID_RE, ulid } from './ulid.ts';
import { UsersService } from './users.service.ts';

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: API_BASE_URL, useValue: '/gateway' },
    ],
  });
  return { users: TestBed.inject(UsersService), http: TestBed.inject(HttpTestingController) };
}

describe('UsersService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('lists by keyset, creates, patches, and drives the grants — every call on the contract path', () => {
    const { users, http } = setup();
    users.list({ after: '01H0000000000000000000000A', limit: 50 }).subscribe();
    http.expectOne('/gateway/api/v1/users?after=01H0000000000000000000000A&limit=50').flush({
      items: [],
    });

    users.create({ username: 'ops', password: 'secret-pass-1' }).subscribe();
    const created = http.expectOne({ method: 'POST', url: '/gateway/api/v1/users' });
    expect(created.request.body).toEqual({ username: 'ops', password: 'secret-pass-1' });
    created.flush({}, { status: 201, statusText: 'Created' });

    users.update('01H0000000000000000000000B', { state: 'disabled' }).subscribe();
    const patched = http.expectOne({
      method: 'PATCH',
      url: '/gateway/api/v1/users/01H0000000000000000000000B',
    });
    expect(patched.request.body).toEqual({ state: 'disabled' });
    patched.flush({});

    users.assignments('01H0000000000000000000000B').subscribe();
    http
      .expectOne({
        method: 'GET',
        url: '/gateway/api/v1/users/01H0000000000000000000000B/assignments',
      })
      .flush([]);
    users.grant('01H0000000000000000000000B', { roleId: 'editor' }).subscribe();
    http
      .expectOne({
        method: 'POST',
        url: '/gateway/api/v1/users/01H0000000000000000000000B/assignments',
      })
      .flush({}, { status: 201, statusText: 'Created' });
    users.revoke('01H0000000000000000000000B', 'a1').subscribe();
    http
      .expectOne({
        method: 'DELETE',
        url: '/gateway/api/v1/users/01H0000000000000000000000B/assignments/a1',
      })
      .flush(null, { status: 204, statusText: 'No Content' });
    users.roles().subscribe();
    http.expectOne({ method: 'GET', url: '/gateway/api/v1/roles' }).flush([]);
    http.verify();
  });
});

describe('ulid (browser)', () => {
  it('is 26 Crockford characters, time-ordered, and never the same twice', () => {
    const a = ulid(1_000);
    const b = ulid(2_000);
    expect(a).toMatch(ULID_RE);
    expect(b).toMatch(ULID_RE);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
    expect(new Set(Array.from({ length: 50 }, () => ulid())).size).toBe(50);
  });
});
