import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { LocaleService } from '../core/locale.service.ts';
import { GroupsView } from './admin/groups-view.ts';
import { RolesView } from './admin/roles-view.ts';
import { UsersView } from './admin/users-view.ts';

type AdminView = 'users' | 'groups' | 'roles';

/**
 * The Admin panel (studio-frontend.md §1: Users, Groups, Roles/Rules, Field schemas, Theme) —
 * as built, three views: **Users** (EP-20.7), **Groups** and **Roles** (over the IAM admin
 * API of EP-10.4/10.6). Each view lists and creates; each item opens as an EDITOR TAB where
 * the editing is. Field schemas and theme are the panel's later views.
 *
 * Revealed by `user:admin` (panels.ts): the one permission every operation here needs, enforced
 * by IAM in the row's channel — Studio decides what to show, not what is allowed.
 */
@Component({
  selector: 'atlas-admin-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UsersView, GroupsView, RolesView],
  template: `
    <h2 class="panel-title">{{ locale.t('workbench.panels.admin') }}</h2>
    <nav class="views" role="tablist" [attr.aria-label]="locale.t('workbench.panels.admin')">
      @for (v of views; track v) {
        <button
          type="button"
          role="tab"
          [attr.aria-selected]="view() === v"
          [class.active]="view() === v"
          (click)="view.set(v)"
        >
          {{ locale.t('admin.' + v) }}
        </button>
      }
    </nav>
    @switch (view()) {
      @case ('users') {
        <atlas-users-view />
      }
      @case ('groups') {
        <atlas-groups-view />
      }
      @case ('roles') {
        <atlas-roles-view />
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
  protected readonly views: readonly AdminView[] = ['users', 'groups', 'roles'];
  protected readonly view = signal<AdminView>('users');
}
