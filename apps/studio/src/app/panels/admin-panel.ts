import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { LocaleService } from '../core/locale.service.ts';
import { PermissionService } from '../core/permission.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { GroupsView } from './admin/groups-view.ts';
import { ProfilesView } from './admin/profiles-view.ts';
import { RolesView } from './admin/roles-view.ts';
import { UsersView } from './admin/users-view.ts';

type AdminView = 'users' | 'groups' | 'roles' | 'profiles';

/** What reveals each view. The panel itself is revealed by any of these (panels.ts). */
const VIEWS: readonly { id: AdminView; permissions: readonly string[] }[] = [
  { id: 'users', permissions: ['user:admin'] },
  { id: 'groups', permissions: ['user:admin'] },
  { id: 'roles', permissions: ['user:admin'] },
  { id: 'profiles', permissions: ['config:read', 'config:admin'] },
];

/**
 * The Admin panel (studio-frontend.md §1: Users, Groups, Roles/Rules, Field schemas, Theme) —
 * as built, four views: **Users** (EP-20.7), **Groups** and **Roles** (over the IAM admin
 * API of EP-10.4/10.6), and **Transcode profiles** (MTS's registry, EP-16.6). Each view lists and
 * creates; each item opens as an EDITOR TAB where the editing is. Field schemas and theme are the
 * panel's later views.
 *
 * Each view is revealed by its own permission — people by `user:admin`, profiles by `config:*` —
 * and the panel by any of them (panels.ts). The services enforce in the row's channel; Studio
 * decides what to show, not what is allowed.
 */
@Component({
  selector: 'atlas-admin-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UsersView, GroupsView, RolesView, ProfilesView],
  template: `
    <h2 class="panel-title">{{ locale.t('workbench.panels.admin') }}</h2>
    <nav class="views" role="tablist" [attr.aria-label]="locale.t('workbench.panels.admin')">
      @for (v of views(); track v) {
        <button
          type="button"
          role="tab"
          [attr.aria-selected]="current() === v"
          [class.active]="current() === v"
          (click)="view.set(v)"
        >
          {{ locale.t('admin.' + v) }}
        </button>
      }
    </nav>
    @switch (current()) {
      @case ('users') {
        <atlas-users-view />
      }
      @case ('groups') {
        <atlas-groups-view />
      }
      @case ('roles') {
        <atlas-roles-view />
      }
      @case ('profiles') {
        <atlas-profiles-view />
      }
    }
  `,
  styles: `
    :host {
      display: block;
      padding: var(--space-3);
    }
    .panel-title {
      margin: 0 0 var(--space-2);
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--color-fg-muted);
    }
    .views {
      display: flex;
      gap: var(--space-1);
      margin-block-end: var(--space-2);
      border-block-end: 1px solid var(--color-border);
    }
    .views button {
      padding: var(--space-1) var(--space-2);
      color: var(--color-fg-muted);
      background: none;
      border: none;
      border-block-end: 2px solid transparent;
      cursor: pointer;
      font: inherit;
      font-size: 0.8125rem;
    }
    .views button.active {
      color: var(--color-fg);
      border-block-end-color: var(--color-accent);
    }
    .views button:focus-visible {
      outline: 2px solid var(--color-focus);
      outline-offset: -2px;
    }
  `,
})
export class AdminPanel {
  protected readonly locale = inject(LocaleService);
  private readonly permissions = inject(PermissionService);
  private readonly session = inject(SessionStore);

  /** The views this session may see — recomputed when the policy changes mid-session. */
  protected readonly views = computed<readonly AdminView[]>(() => {
    this.session.policy(); // the dependency; the check reads it internally
    return VIEWS.filter((v) => this.permissions.canAny(v.permissions)).map((v) => v.id);
  });
  /** The one chosen, or the first visible one when nothing (or a view since revoked) is. */
  protected readonly view = signal<AdminView | null>(null);
  protected readonly current = computed<AdminView | undefined>(() => {
    const chosen = this.view();
    const views = this.views();
    return chosen !== null && views.includes(chosen) ? chosen : views[0];
  });
}
