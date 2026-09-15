import type { Routes } from '@angular/router';
import { requirePermission, requireSession } from './core/permission.guard.ts';

/**
 * Panels are lazy and permission-matched.
 *
 * `canMatch` rather than `canActivate`: a route the user cannot open never matches, so the router
 * falls through to the catch-all instead of navigating and bouncing — and the panel's chunk is
 * never fetched. Enforcement still belongs to the services behind it.
 */
export const routes: Routes = [
  {
    // No guard: this is where an unauthenticated caller is SENT, so guarding it would loop.
    path: 'signin',
    loadComponent: () => import('./panels/signin.ts').then((m) => m.SignIn),
  },
  {
    path: 'media',
    canMatch: [requirePermission('asset:read')],
    loadComponent: () => import('./panels/media-panel.ts').then((m) => m.MediaPanel),
  },
  {
    path: 'search',
    canMatch: [requirePermission('asset:read')],
    loadComponent: () => import('./panels/search-panel.ts').then((m) => m.SearchPanel),
  },
  {
    path: 'schedule',
    canMatch: [requirePermission('schedule:read')],
    loadComponent: () => import('./panels/schedule-panel.ts').then((m) => m.SchedulePanel),
  },
  {
    path: 'ingest',
    canMatch: [requirePermission('ingest:read')],
    loadComponent: () => import('./panels/ingest-panel.ts').then((m) => m.IngestPanel),
  },
  {
    // The side bar's landing panel — the dashboard itself is an EDITOR TAB (studio-frontend.md
    // §3), opened by the workbench, not a route.
    path: '',
    pathMatch: 'full',
    canMatch: [requireSession],
    redirectTo: 'media',
  },
  {
    path: '**',
    loadComponent: () => import('./panels/not-available.ts').then((m) => m.NotAvailable),
  },
];
