import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Group } from '../../core/generated/iam.types.ts';
import { GroupsService } from '../../core/groups.service.ts';
import { LocaleService } from '../../core/locale.service.ts';
import { EditorStore } from '../../workbench/editor.store.ts';

/**
 * The Admin panel's Groups view: the groups the caller may administer — the channel's and the
 * platform-wide ones — and a new one; a group opens as an EDITOR TAB (group-editor.ts), where
 * the members and the grants are. A group is how a grant reaches many people at once, and a
 * change to it reaches every member (permissions.changed) — the editor says so where it matters.
 */
@Component({
  selector: 'atlas-groups-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <details class="new" [open]="creating()">
      <summary (click)="creating.set(!creating()); $event.preventDefault()">
        {{ locale.t('admin.newGroup') }}
      </summary>
      <form (ngSubmit)="create()">
        <label>
          <span>{{ locale.t('admin.name') }}</span>
          <input name="name" [(ngModel)]="name" autocomplete="off" required />
        </label>
        <label>
          <span>{{ locale.t('admin.description') }}</span>
          <input name="description" [(ngModel)]="description" autocomplete="off" />
        </label>
        @if (createError()) {
          <p class="error" role="alert">{{ createError() }}</p>
        }
        <button type="submit" [disabled]="busy() || !name.trim()">
          {{ locale.t('admin.create') }}
        </button>
      </form>
    </details>

    <p class="mode">{{ locale.t('admin.groups') }}</p>
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    } @else if (loading()) {
      <p class="muted">{{ locale.t('admin.loading') }}</p>
    } @else if (groups().length === 0) {
      <p class="muted">{{ locale.t('admin.noGroups') }}</p>
    } @else {
      <ul class="items">
        @for (group of groups(); track group.id) {
          <li>
            <button type="button" (click)="open(group)">
              <span class="title">{{ group.name }}</span>
              @if (!group.channelId) {
                <span class="state">{{ locale.t('admin.platformWide') }}</span>
              }
            </button>
          </li>
        }
      </ul>
    }
  `,
  styleUrl: './admin-view.scss',
})
export class GroupsView {
  private readonly api = inject(GroupsService);
  private readonly editors = inject(EditorStore);
  protected readonly locale = inject(LocaleService);

  protected readonly groups = signal<Group[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly creating = signal(false);
  protected readonly busy = signal(false);
  protected readonly createError = signal<string | null>(null);
  protected name = '';
  protected description = '';

  constructor() {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.list().subscribe({
      next: (groups) => {
        this.groups.set(groups);
        this.loading.set(false);
      },
      error: () => {
        this.error.set(this.locale.t('admin.loadError'));
        this.loading.set(false);
      },
    });
  }

  protected create(): void {
    const name = this.name.trim();
    if (!name || this.busy()) return;
    this.busy.set(true);
    this.createError.set(null);
    const description = this.description.trim();
    this.api.create({ name, ...(description ? { description } : {}) }).subscribe({
      next: (group) => {
        this.groups.update((list) => [group, ...list]);
        this.name = '';
        this.description = '';
        this.busy.set(false);
        this.creating.set(false);
        this.open(group);
      },
      error: (err: { error?: { message?: string } }) => {
        this.createError.set(err.error?.message ?? this.locale.t('admin.createError'));
        this.busy.set(false);
      },
    });
  }

  protected open(group: Group): void {
    this.editors.open({ type: 'group', resourceId: group.id, title: group.name, icon: '⚙' });
  }
}
