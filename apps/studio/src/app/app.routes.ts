import type { Routes } from '@angular/router';
import { Workbench } from './workbench/workbench.ts';
import { redirectSignedIn, requirePermission, requireSession } from './core/permission.guard.ts';

/**
 * Two top-level routes: the sign-in screen, and the workbench — which is the ONLY thing a session
 * can reach, and holds every panel as a child. Nothing renders inside the workbench's chrome
 * without a session, because the workbench itself does not match without one: a signed-out
 * caller at any URL is sent to /signin with the URL to come back to, and the frame — activity
 * bar, status bar, editor area — is never constructed for them.
 *
 * Panels are lazy and permission-matched. `canMatch` rather than `canActivate`: a route the user
 * cannot open never matches, so the router falls through to the catch-all instead of navigating
 * and bouncing — and the panel's chunk is never fetched. Enforcement still belongs to the
 * services behind it.
 */
export const routes: Routes = [
  {
    // Full-screen, outside the workbench: there is no frame to put a form in before there is a
    // session. A caller who already has one is sent on to the workbench, not shown the form.
    path: 'signin',
    canMatch: [redirectSignedIn],
    loadComponent: () => import('./panels/signin.ts').then((m) => m.SignIn),
  },
  {
    path: '',
    canMatch: [requireSession],
    component: Workbench,
    children: [
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
        // §3), opened by the workbench, not a route. No guard on a redirect: Angular refuses the
        // pair (NG04014), and the session check is the parent's.
        path: '',
        pathMatch: 'full',
        redirectTo: 'media',
      },
      {
        // A URL the session may not open, or one that names nothing: the frame stays, the side
        // bar says so. Inside the workbench on purpose — a signed-in user is never bounced out.
        path: '**',
        loadComponent: () => import('./panels/not-available.ts').then((m) => m.NotAvailable),
      },
    ],
  },
];
