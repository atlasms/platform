import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Role } from '../../core/generated/iam.types.ts';
import { LocaleService } from '../../core/locale.service.ts';
import { RolesService } from '../../core/roles.service.ts';
import { EditorStore } from '../../workbench/editor.store.ts';

/**
 * The Admin panel's Roles view: the roles a grant can name — the channel's own, and the
 * platform-wide starter roles (EP-10.7) that are shown and not this channel's to edit — and a
 * new one; a role opens as an EDITOR TAB (role-editor.ts), where its rules are.
 */
@Component({
  selector: 'atlas-roles-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <details class="new" [open]="creating()">
      <summary (click)="creating.set(!creating()); $event.preventDefault()">
        {{ locale.t('admin.newRole') }}
      </summary>
      <form (ngSubmit)="create()">
        <label>
          <span>{{ locale.t('admin.roleId') }}</span>
          <input name="id" [(ngModel)]="id" autocomplete="off" placeholder="news-editor" />
        </label>
        <label>
          <span>{{ locale.t('admin.name') }}</span>
          <input name="name" [(ngModel)]="name" autocomplete="off" required />
        </label>
        @if (createError()) {
          <p class="error" role="alert">{{ createError() }}</p>
        }
        <button type="submit" [disabled]="busy() || !name.trim() || !idOk()">
          {{ locale.t('admin.create') }}
        </button>
      </form>
    </details>

    <p class="mode">{{ locale.t('admin.roles') }}</p>
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    } @else if (loading()) {
      <p class="muted">{{ locale.t('admin.loading') }}</p>
    } @else if (roles().length === 0) {
      <p class="muted">{{ locale.t('admin.noRoles') }}</p>
    } @else {
      <ul class="items">
        @for (role of roles(); track role.id) {
          <li>
            <button type="button" (click)="open(role)">
              <span class="title">{{ role.name ?? role.id }}</span>
              <span class="muted">{{ role.rules.length }} {{ locale.t('admin.rulesCount') }}</span>
              @if (!role.channelId) {
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
export class RolesView {
  private readonly api = inject(RolesService);
  private readonly editors = inject(EditorStore);
  protected readonly locale = inject(LocaleService);

  protected readonly roles = signal<Role[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly creating = signal(false);
  protected readonly busy = signal(false);
  protected readonly createError = signal<string | null>(null);
  protected id = '';
  protected name = '';

  constructor() {
    this.load();
  }

  /** Kebab-case, or nothing — IAM mints one when it is omitted. */
  protected idOk(): boolean {
    return this.id === '' || /^[a-z][a-z0-9-]*$/.test(this.id);
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.list().subscribe({
      next: (roles) => {
        this.roles.set(roles);
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
    if (!name || !this.idOk() || this.busy()) return;
    this.busy.set(true);
    this.createError.set(null);
    this.api.create({ name, rules: [], ...(this.id ? { id: this.id } : {}) }).subscribe({
      next: (role) => {
        this.roles.update((list) => [role, ...list]);
        this.id = '';
        this.name = '';
        this.busy.set(false);
        this.creating.set(false);
        this.open(role);
      },
      error: (err: { status?: number; error?: { message?: string } }) => {
        this.createError.set(
          err.status === 409
            ? this.locale.t('admin.roleIdTaken')
            : (err.error?.message ?? this.locale.t('admin.createError')),
        );
        this.busy.set(false);
      },
    });
  }

  protected open(role: Role): void {
    this.editors.open({
      type: 'role',
      resourceId: role.id,
      title: role.name ?? role.id,
      icon: '⚙',
    });
  }
}
