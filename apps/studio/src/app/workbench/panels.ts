/**
 * The Activity Bar's view containers — one icon each
 * ([studio-frontend.md §2](../../../../../docs/architecture/studio-frontend.md)).
 *
 * Every panel names the permission that reveals it, so "which panels does this user see?" has one
 * answer derived from the policy rather than a rule repeated in each component. Panels whose
 * services do not exist yet are listed with `available: false` — they are part of the designed
 * shell, and pretending otherwise would hide how much of Studio is still ahead.
 */
export interface PanelDefinition {
  readonly id: string;
  /**
   * The locale key for the panel's name — `workbench.panels.<id>` — NOT the name itself.
   *
   * The activity bar renders this through `t()`, so the icon's tooltip and its screen-reader label
   * are Arabic in Arabic. A literal English `title` here is what made them the one part of the
   * shell that ignored EP-11.6, while `media-panel.ts` translated the very same name for its own
   * heading. One panel, one key.
   */
  readonly titleKey: string;
  /** Single glyph; a real icon set is EP-11.6. */
  readonly icon: string;
  /**
   * Seeing the panel at all requires this — or, given a list, ANY of it: a container whose views
   * need different grants (Admin: people under `user:admin`, the transcode profiles under
   * `config:*`) is revealed by each of them. Views inside gate themselves further.
   */
  readonly permission: string | readonly string[];
  readonly route: string;
  readonly available: boolean;
}

/** What reveals the Admin panel: any of its views' permissions (admin-panel.ts). */
export const ADMIN_PERMISSIONS: readonly string[] = ['user:admin', 'config:read', 'config:admin'];

export const PANELS: readonly PanelDefinition[] = [
  {
    id: 'media',
    titleKey: 'workbench.panels.media',
    icon: '▤',
    permission: 'asset:read',
    route: '/media',
    available: true,
  },
  {
    id: 'search',
    titleKey: 'workbench.panels.search',
    icon: '⌕',
    permission: 'asset:read',
    route: '/search',
    available: true,
  },
  {
    id: 'ingest',
    titleKey: 'workbench.panels.ingest',
    icon: '⇥',
    permission: 'ingest:read',
    route: '/ingest',
    // Served since EP-15.6: RIM's queue and review through the gateway's /api/v1/ingest route.
    available: true,
  },
  {
    id: 'schedule',
    titleKey: 'workbench.panels.schedule',
    icon: '▦',
    permission: 'schedule:read',
    route: '/schedule',
    available: true,
  },
  {
    id: 'newsroom',
    titleKey: 'workbench.panels.newsroom',
    icon: '✎',
    permission: 'story:read',
    route: '/newsroom',
    available: false,
  },
  {
    id: 'inbox',
    titleKey: 'workbench.panels.inbox',
    icon: '✉',
    permission: 'task:read',
    route: '/inbox',
    available: false,
  },
  {
    id: 'workflows',
    titleKey: 'workbench.panels.workflows',
    icon: '⇄',
    permission: 'workflow:read',
    route: '/workflows',
    available: false,
  },
  {
    id: 'taxonomy',
    titleKey: 'workbench.panels.taxonomy',
    icon: '☰',
    permission: 'taxonomy:read',
    route: '/taxonomy',
    available: false,
  },
  {
    id: 'feeds',
    titleKey: 'workbench.panels.feeds',
    icon: '⇅',
    permission: 'feed:read',
    route: '/feeds',
    available: false,
  },
  {
    id: 'admin',
    titleKey: 'workbench.panels.admin',
    icon: '⚙',
    // Each view reveals itself by its own permission, and the panel by any of them: Users,
    // Groups and Roles by `user:admin`; Transcode profiles (EP-16.6) by `config:read` or
    // `config:admin` — a channel's engineering lead need not administer its people to tune its
    // renditions. Keep this list in step with `AdminPanel`'s views and the route's guard.
    permission: ADMIN_PERMISSIONS,
    route: '/admin',
    available: true,
  },
  {
    id: 'logs',
    titleKey: 'workbench.panels.logs',
    icon: '◫',
    permission: 'audit:read',
    route: '/logs',
    available: false,
  },
] as const;

export const panelById = (id: string): PanelDefinition | undefined =>
  PANELS.find((p) => p.id === id);
