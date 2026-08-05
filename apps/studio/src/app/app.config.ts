import { provideBrowserGlobalErrorListeners, type ApplicationConfig } from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { routes } from './app.routes.ts';
import { authInterceptor } from './core/auth.interceptor.ts';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withInterceptors([authInterceptor])),
  ],
};

// There is no app initializer here any more, and no seeded session.
//
// Studio now starts ANONYMOUS. The root route requires a session, so a cold load lands on /signin
// and everything downstream renders from the policy IAM actually returns — which is the point: a
// seeded policy meant the permission-driven shell was only ever exercised against grants we had
// written for ourselves.
//
// A reload signs the user out, because tokens are held in memory only. That is deliberate and the
// reasoning is in `core/auth.service.ts`: persisting the refresh token where script can read it
// trades a genuine credential for the convenience of surviving F5. The real fix is an httpOnly
// cookie from IAM, and it needs a server change.
