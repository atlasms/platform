import { inject } from '@angular/core';
import { Router, type CanMatchFn } from '@angular/router';
import { PermissionService } from './permission.service.ts';
import { SessionStore } from './session.store.ts';

/**
 * Where a signed-out caller goes: /signin, carrying the URL they asked for so the sign-in can
 * bring them back. The root itself is not worth carrying.
 */
function toSignIn(router: Router) {
  // `currentNavigation()` is the signal; `getCurrentNavigation()` is deprecated since 20.2.
  const wanted = router.currentNavigation()?.extractedUrl.toString() ?? '/';
  return router.createUrlTree(
    ['/signin'],
    wanted !== '/' ? { queryParams: { returnUrl: wanted } } : {},
  );
}

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
      return toSignIn(router);
    }
    // No redirect on a permission failure: falling through lets a later route match, and the
    // catch-all renders "not available" rather than pretending the URL does not exist.
    return permissions.can(permission);
  };
}

/**
 * The workbench's guard: any authenticated session, regardless of grants. On the SHELL, not on
 * each panel — so without a session there is no frame at all, not a frame with an empty side bar.
 */
export const requireSession: CanMatchFn = () => {
  const session = inject(SessionStore);
  const router = inject(Router);
  return session.isAuthenticated() ? true : toSignIn(router);
};

/** The sign-in screen's guard, the other way round: a session has no business there. */
export const redirectSignedIn: CanMatchFn = () => {
  const session = inject(SessionStore);
  const router = inject(Router);
  return session.isAuthenticated() ? router.createUrlTree(['/']) : true;
};
