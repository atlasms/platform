import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { User } from '../../core/generated/iam.types.ts';
import { LocaleService } from '../../core/locale.service.ts';
import { UsersService } from '../../core/users.service.ts';
import { EditorStore } from '../../workbench/editor.store.ts';

/**
 * The Admin panel's Users view (EP-20.7, basic): the users the caller may administer, paged as
 * IAM pages them, and a new one; a user opens as an EDITOR TAB (user-editor.ts), where the
 * profile, the state and the grants are.
 */
@Component({
  selector: 'atlas-users-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <details class="new" [open]="creating()">
      <summary (click)="creating.set(!creating()); $event.preventDefault()">
        {{ locale.t('admin.newUser') }}
      </summary>
      <form (ngSubmit)="create()">
        <label>
          <span>{{ locale.t('auth.username') }}</span>
          <input name="username" [(ngModel)]="username" autocomplete="off" required />
        </label>
        <label>
          <span>{{ locale.t('admin.name') }}</span>
          <input name="name" [(ngModel)]="name" autocomplete="off" />
        </label>
        <label>
          <span>{{ locale.t('auth.password') }}</span>
          <!-- Optional: an account without one is SSO-only (iam.yaml CreateUser). -->
          <input
            name="password"
            type="password"
            [(ngModel)]="password"
            autocomplete="new-password"
          />
        </label>
        @if (createError()) {
          <p class="error" role="alert">{{ createError() }}</p>
        }
        <button type="submit" [disabled]="busy() || !username.trim()">
          {{ locale.t('admin.create') }}
        </button>
      </form>
    </details>

    <p class="mode">{{ locale.t('admin.users') }}</p>
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    } @else if (loading() && users().length === 0) {
      <p class="muted">{{ locale.t('admin.loading') }}</p>
    } @else if (users().length === 0) {
      <p class="muted">{{ locale.t('admin.none') }}</p>
    } @else {
      <ul class="items">
        @for (user of users(); track user.id) {
          <li>
            <button type="button" (click)="open(user)">
              <span class="title">{{ user.username }}</span>
              @if (user.name) {
                <span class="muted">{{ user.name }}</span>
              }
              <span class="state" [attr.data-state]="user.state">{{
                locale.t('admin.state.' + user.state)
              }}</span>
            </button>
          </li>
        }
      </ul>
      @if (nextCursor()) {
        <button type="button" class="link" [disabled]="loading()" (click)="load(nextCursor())">
          {{ locale.t('admin.more') }}
        </button>
      }
    }
  `,
  styleUrl: './admin-view.scss',
})
export class UsersView {
  private readonly api = inject(UsersService);
  private readonly editors = inject(EditorStore);
  protected readonly locale = inject(LocaleService);

  protected readonly users = signal<User[]>([]);
  protected readonly nextCursor = signal<string | undefined>(undefined);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly creating = signal(false);
  protected readonly busy = signal(false);
  protected readonly createError = signal<string | null>(null);
  protected username = '';
  protected name = '';
  protected password = '';

  constructor() {
    this.load();
  }

  /** The first page, or the next one after `after` appended — keyset, so nothing is seen twice. */
  protected load(after?: string): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.list({ limit: 50, ...(after ? { after } : {}) }).subscribe({
      next: (page) => {
        this.users.update((list) => (after ? [...list, ...page.items] : page.items));
        this.nextCursor.set(page.nextCursor);
        this.loading.set(false);
      },
      error: () => {
        this.error.set(this.locale.t('admin.loadError'));
        this.loading.set(false);
      },
    });
  }

  protected create(): void {
    const username = this.username.trim();
    if (!username || this.busy()) return;
    this.busy.set(true);
    this.createError.set(null);
    const name = this.name.trim();
    this.api
      .create({
        username,
        ...(name ? { name } : {}),
        ...(this.password ? { password: this.password } : {}),
      })
      .subscribe({
        next: (user) => {
          this.users.update((list) => [user, ...list]);
          this.username = '';
          this.name = '';
          this.password = '';
          this.busy.set(false);
          this.creating.set(false);
          this.open(user);
        },
        error: (err: { status?: number; error?: { message?: string } }) => {
          this.createError.set(
            err.status === 409
              ? this.locale.t('admin.usernameTaken')
              : (err.error?.message ?? this.locale.t('admin.createError')),
          );
          this.busy.set(false);
        },
      });
  }

  protected open(user: User): void {
    this.editors.open({ type: 'user', resourceId: user.id, title: user.username, icon: '⚙' });
  }
}
