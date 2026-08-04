import {
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  type ApplicationConfig,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { routes } from './app.routes.ts';
import { SessionStore } from './core/session.store.ts';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    provideAppInitializer(() => {
      seedDevSession(inject(SessionStore));
    }),
  ],
};

/**
 * TEMPORARY — replaced by the real sign-in flow in EP-11.2.
 *
 * Studio cannot render anything meaningful without a policy, and there is no IAM round trip yet.
 * This seeds one so the permission-driven shell is actually exercisable: `asset:*` is granted but
 * `asset:delete`, `schedule:*` and `admin:*` are not, so several panels stay hidden and the
 * strict-mode delete button stays absent — which is the behaviour worth being able to see.
 *
 * Deliberately shaped as a `CompileInput` with a group, so `compile()` has real work to do and the
 * group-derived grant proves it flattened correctly.
 */
function seedDevSession(session: SessionStore): void {
  session.signIn({
    userId: 'dev-user',
    channelId: 'ch12',
    policy: {
      subjectId: 'dev-user',
      permVersion: 1,
      rules: [
        { id: 'own', permissions: ['asset:read', 'asset:write'], scope: { channelIds: ['ch12'] } },
      ],
      groups: [
        {
          id: 'editors',
          rules: [
            { id: 'grp-approve', permissions: ['asset:approve'], scope: { channelIds: ['ch12'] } },
          ],
        },
      ],
    },
  });
}
