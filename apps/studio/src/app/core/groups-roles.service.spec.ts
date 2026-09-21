// The groups and roles services: every call on the contract's operation, by method and URL —
// including the member removal, which carries the user id as a QUERY parameter.

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { API_BASE_URL } from './api.ts';
import { GroupsService } from './groups.service.ts';
import { RolesService } from './roles.service.ts';

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: API_BASE_URL, useValue: '/gateway' },
    ],
  });
  return {
    groups: TestBed.inject(GroupsService),
    roles: TestBed.inject(RolesService),
    http: TestBed.inject(HttpTestingController),
  };
}

describe('GroupsService / RolesService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('groups: list, get, create, patch, delete, and members added by body and removed by query', () => {
    const { groups, http } = setup();
    groups.list().subscribe();
    http.expectOne({ method: 'GET', url: '/gateway/api/v1/groups' }).flush([]);
    groups.get('01H0000000000000000000000G').subscribe();
    http
      .expectOne({ method: 'GET', url: '/gateway/api/v1/groups/01H0000000000000000000000G' })
      .flush({});
    groups.create({ name: 'Newsroom' }).subscribe();
    const created = http.expectOne({ method: 'POST', url: '/gateway/api/v1/groups' });
    expect(created.request.body).toEqual({ name: 'Newsroom' });
    created.flush({}, { status: 201, statusText: 'Created' });
    groups.update('01H0000000000000000000000G', { roleIds: ['editor'] }).subscribe();
    http
      .expectOne({ method: 'PATCH', url: '/gateway/api/v1/groups/01H0000000000000000000000G' })
      .flush({});
    groups.addMember('01H0000000000000000000000G', '01H0000000000000000000000U').subscribe();
    const added = http.expectOne({
      method: 'POST',
      url: '/gateway/api/v1/groups/01H0000000000000000000000G/members',
    });
    expect(added.request.body).toEqual({ userId: '01H0000000000000000000000U' });
    added.flush(null, { status: 204, statusText: 'No Content' });
    groups.removeMember('01H0000000000000000000000G', '01H0000000000000000000000U').subscribe();
    http
      .expectOne(
        '/gateway/api/v1/groups/01H0000000000000000000000G/members?userId=01H0000000000000000000000U',
      )
      .flush(null, { status: 204, statusText: 'No Content' });
    groups.delete('01H0000000000000000000000G').subscribe();
    http
      .expectOne({ method: 'DELETE', url: '/gateway/api/v1/groups/01H0000000000000000000000G' })
      .flush(null, { status: 204, statusText: 'No Content' });
    http.verify();
  });

  it('roles: list, get, create, patch, delete on the contract path', () => {
    const { roles, http } = setup();
    roles.list().subscribe();
    http.expectOne({ method: 'GET', url: '/gateway/api/v1/roles' }).flush([]);
    roles.get('editor').subscribe();
    http.expectOne({ method: 'GET', url: '/gateway/api/v1/roles/editor' }).flush({});
    roles.create({ id: 'editor', name: 'Editor', rules: [] }).subscribe();
    http
      .expectOne({ method: 'POST', url: '/gateway/api/v1/roles' })
      .flush({}, { status: 201, statusText: 'Created' });
    roles.update('editor', { name: 'Senior editor' }).subscribe();
    http.expectOne({ method: 'PATCH', url: '/gateway/api/v1/roles/editor' }).flush({});
    roles.delete('editor').subscribe();
    http
      .expectOne({ method: 'DELETE', url: '/gateway/api/v1/roles/editor' })
      .flush(null, { status: 204, statusText: 'No Content' });
    http.verify();
  });
});
