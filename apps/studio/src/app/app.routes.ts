import type { Routes } from '@angular/router';
import { requirePermission } from './core/permission.guard.ts';

/**
 * Panels are lazy and permission-matched.
 *
 * `canMatch` rather than `canActivate`: a route the user cannot open never matches, so the router
 * falls through to the catch-all instead of navigating and bouncing — and the panel's chunk is
 * never fetched. Enforcement still belongs to the services behind it.
 */
export const routes: Routes = [
  {
    path: 'media',
    canMatch: [requirePermission('asset:read')],
    loadComponent: () => import('./panels/media-panel.ts').then((m) => m.MediaPanel),
  },
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./panels/welcome.ts').then((m) => m.Welcome),
  },
  {
    path: '**',
    loadComponent: () => import('./panels/not-available.ts').then((m) => m.NotAvailable),
  },
];
