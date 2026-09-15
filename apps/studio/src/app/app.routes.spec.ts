// The route table, as the Router sees it. Nothing else builds the Router from the REAL `routes`:
// every panel spec drives its component, and the guards are tested as functions. So a route
// configuration the Router refuses — Angular 22's NG04014, a guard on a redirect — was a startup
// crash in the browser and green everywhere else. Constructing the Router here is the test.
//
// And the shape: the workbench is the guarded parent of every panel, so without a session there
// is no frame at all — every URL lands on the full-screen /signin, carrying where it came from.

import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';
import { routes } from './app.routes.ts';
import { AuthService } from './core/auth.service.ts';
import { LocaleService } from './core/locale.service.ts';
import { SessionStore } from './core/session.store.ts';
import { Workbench } from './workbench/workbench.ts';

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideRouter(routes),
      // The workbench constructs when the shell route activates; its services stay headless.
      {
        provide: LocaleService,
        useValue: {
          t: (k: string) => k,
          locale: () => 'en',
          loading: () => false,
          direction: () => 'ltr',
        },
      },
      { provide: AuthService, useValue: { signOut: async () => undefined } },
    ],
  });
  // Constructing the Router validates the whole table — this is where NG04014 would throw.
  const router = TestBed.inject(Router);
  const session = TestBed.inject(SessionStore);
  return { router, session };
}

function signIn(session: SessionStore, permissions: string[]): void {
  session.signIn({
    userId: 'u1',
    channelId: 'ch12',
    policy: { subjectId: 'u1', permVersion: 1, rules: [{ id: 'r', permissions }] },
  });
}

describe('routes', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('is a configuration the Router accepts', () => {
    expect(() => setup()).not.toThrow();
  });

  it('the workbench is the parent of every panel, and nothing else is at the top', () => {
    const shell = routes.find((r) => r.component === Workbench);
    expect(shell?.path).toBe('');
    expect(shell?.canMatch?.length).toBe(1);
    const children = shell?.children?.map((c) => c.path) ?? [];
    expect(children).toEqual(['media', 'search', 'schedule', 'ingest', '', '**']);
    expect(routes.map((r) => r.path)).toEqual(['signin', '']);
  });

  it('SECURITY: signed out, every URL goes to /signin — the root bare, a deep link carried', async () => {
    const { router } = setup();
    await router.navigateByUrl('/');
    expect(router.url).toBe('/signin');
    await router.navigateByUrl('/schedule');
    expect(router.url).toBe('/signin?returnUrl=%2Fschedule');
    await router.navigateByUrl('/no-such-panel');
    expect(router.url).toBe('/signin?returnUrl=%2Fno-such-panel');
  });

  it('lands a signed-in caller with asset:read on /media, and keeps them off /signin', async () => {
    const { router, session } = setup();
    signIn(session, ['asset:read']);
    await router.navigateByUrl('/');
    expect(router.url).toBe('/media');
    await router.navigateByUrl('/signin');
    // A session has no business on the sign-in screen.
    expect(router.url).toBe('/media');
  });

  it('a signed-in caller without the grant falls through to the catch-all INSIDE the frame', async () => {
    const { router, session } = setup();
    signIn(session, ['schedule:read']);
    await router.navigateByUrl('/ingest');
    // The URL is kept — the side bar renders "not available" for it — rather than bouncing.
    expect(router.url).toBe('/ingest');
  });
});
