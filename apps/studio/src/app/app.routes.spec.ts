// The route table, as the Router sees it. Nothing else builds the Router from the REAL `routes`:
// every panel spec drives its component, and the guards are tested as functions. So a route
// configuration the Router refuses — Angular 22's NG04014, a guard on a redirect — was a startup
// crash in the browser and green everywhere else. Constructing the Router here is the test.

import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';
import { routes } from './app.routes.ts';
import { SessionStore } from './core/session.store.ts';

function setup() {
  TestBed.configureTestingModule({ providers: [provideRouter(routes)] });
  // Constructing the Router validates the whole table — this is where NG04014 would throw.
  const router = TestBed.inject(Router);
  const session = TestBed.inject(SessionStore);
  return { router, session };
}

describe('routes', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('is a configuration the Router accepts', () => {
    expect(() => setup()).not.toThrow();
  });

  it('sends a signed-out caller from the root to /signin — through media, whose guard does the check', async () => {
    const { router } = setup();
    await router.navigateByUrl('/');
    expect(router.url).toBe('/signin');
  });

  it('lands a signed-in caller with asset:read on /media', async () => {
    const { router, session } = setup();
    session.signIn({
      userId: 'u1',
      channelId: 'ch12',
      policy: {
        subjectId: 'u1',
        permVersion: 1,
        rules: [{ id: 'r', permissions: ['asset:read'] }],
      },
    });
    await router.navigateByUrl('/');
    expect(router.url).toBe('/media');
  });

  it('a signed-in caller without the grant falls through to the catch-all, not to /signin', async () => {
    const { router, session } = setup();
    session.signIn({
      userId: 'u1',
      channelId: 'ch12',
      policy: {
        subjectId: 'u1',
        permVersion: 1,
        rules: [{ id: 'r', permissions: ['schedule:read'] }],
      },
    });
    await router.navigateByUrl('/ingest');
    // The URL is kept — the catch-all renders "not available" for it — rather than bouncing.
    expect(router.url).toBe('/ingest');
  });
});
