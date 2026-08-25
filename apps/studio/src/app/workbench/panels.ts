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
  readonly title: string;
  /** Single glyph; a real icon set is EP-11.6. */
  readonly icon: string;
  /** Seeing the panel at all requires this. Views inside gate themselves further. */
  readonly permission: string;
  readonly route: string;
  readonly available: boolean;
}

export const PANELS: readonly PanelDefinition[] = [
  {
    id: 'media',
    title: 'Media',
    icon: '▤',
    permission: 'asset:read',
    route: '/media',
    available: true,
  },
  {
    id: 'search',
    title: 'Search',
    icon: '⌕',
    permission: 'asset:read',
    route: '/search',
    available: true,
  },
  {
    id: 'ingest',
    title: 'Ingest',
    icon: '⇥',
    permission: 'ingest:read',
    route: '/ingest',
    available: true,
  },
  {
    id: 'schedule',
    title: 'Schedule',
    icon: '▦',
    permission: 'schedule:read',
    route: '/schedule',
    available: false,
  },
  {
    id: 'newsroom',
    title: 'Newsroom',
    icon: '✎',
    permission: 'story:read',
    route: '/newsroom',
    available: false,
  },
  {
    id: 'inbox',
    title: 'Inbox',
    icon: '✉',
    permission: 'task:read',
    route: '/inbox',
    available: false,
  },
  {
    id: 'workflows',
    title: 'Workflows',
    icon: '⇄',
    permission: 'workflow:read',
    route: '/workflows',
    available: false,
  },
  {
    id: 'taxonomy',
    title: 'People & Taxonomy',
    icon: '☰',
    permission: 'taxonomy:read',
    route: '/taxonomy',
    available: false,
  },
  {
    id: 'feeds',
    title: 'Feeds & Integration',
    icon: '⇅',
    permission: 'feed:read',
    route: '/feeds',
    available: false,
  },
  {
    id: 'admin',
    title: 'Admin',
    icon: '⚙',
    permission: 'admin:read',
    route: '/admin',
    available: false,
  },
  {
    id: 'logs',
    title: 'Logs & Analytics',
    icon: '◫',
    permission: 'audit:read',
    route: '/logs',
    available: false,
  },
] as const;

export const panelById = (id: string): PanelDefinition | undefined =>
  PANELS.find((p) => p.id === id);
