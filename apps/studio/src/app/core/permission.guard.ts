import { inject } from '@angular/core';
import { Router, type CanMatchFn } from '@angular/router';
import { PermissionService } from './permission.service.ts';
import { SessionStore } from './session.store.ts';

/**
 * Refuse a route the user has no permission for.
 *
 * `CanMatch` rather than `CanActivate` on purpose: a non-matching route is skipped entirely, so
 * the router falls through to the next match instead of navigating and then bouncing. Lazy chunks
 * for panels the user cannot open are never fetched either.
 *
 * Like every check in Studio this is UX, not enforcement — the panel's data comes from services
 * that authorize independently.
 */
export function requirePermission(permission: string): CanMatchFn {
  return () => {
    const session = inject(SessionStore);
    const permissions = inject(PermissionService);
    const router = inject(Router);

    if (!session.isAuthenticated()) {
      return router.createUrlTree(['/signin']);
    }
    // No redirect on a permission failure: falling through lets a later route match, and the
    // catch-all renders "not available" rather than pretending the URL does not exist.
    return permissions.can(permission);
  };
}

/** Any authenticated session, regardless of grants. */
export const requireSession: CanMatchFn = () => {
  const session = inject(SessionStore);
  const router = inject(Router);
  return session.isAuthenticated() ? true : router.createUrlTree(['/signin']);
};
