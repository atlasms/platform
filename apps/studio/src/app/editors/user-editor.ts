import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
  type OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Assignment, Role, User } from '../core/generated/iam.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { ulid } from '../core/ulid.ts';
import { UsersService } from '../core/users.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';

/**
 * A user, as an editor tab (EP-20.7, basic): the profile, the account state, the credential,
 * and the direct grants. Every write is its own request against IAM (EP-10.4/10.6), because
 * each one is its own audited mutation there — a name is `user.updated`, a grant is
 * `permissions.changed` — so this editor has no "save everything" button: the name is the one
 * field held dirty until saved; state, password and grants apply when pressed.
 *
 * What a grant means is IAM's business: a role is a named bundle of rules the channel or the
 * platform defines; a rule is permissions with a scope. Both are shown as IAM holds them, and
 * revoking one reaches the gateway and the WebSocket service at once (permVersion). The
 * subject's own tab is refreshed by the session's policy the same way — this editor does not
 * pretend to know the effective policy; `GET /effective-permissions` does, and that is the
 * permissions view, not this story.
 */
@Component({
  selector: 'atlas-user-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    @if (loadError()) {
      <p class="error" role="alert">{{ loadError() }}</p>
    } @else if (!user()) {
      <p class="muted">{{ locale.t('admin.loading') }}</p>
    } @else {
      <header class="head">
        <h2>{{ user()!.username }}</h2>
        <span class="state" [attr.data-state]="user()!.state">{{
          locale.t('admin.state.' + user()!.state)
        }}</span>
        @if (user()!.channelId) {
          <span class="muted"
            >{{ locale.t('workbench.statusBar.channel') }} {{ user()!.channelId }}</span
          >
        } @else {
          <span class="muted">{{ locale.t('admin.platformWide') }}</span>
        }
      </header>
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }

      <section>
        <h3>{{ locale.t('admin.profile') }}</h3>
        <form class="row" (ngSubmit)="saveName()">
          <label>
            <span>{{ locale.t('admin.name') }}</span>
            <input name="name" [ngModel]="name()" (ngModelChange)="setName($event)" />
          </label>
          <button type="submit" [disabled]="busy() || !dirty()">
            {{ locale.t('admin.save') }}
          </button>
        </form>
        <dl class="facts">
          <dt>{{ locale.t('admin.lastLogin') }}</dt>
          <dd>{{ user()!.lastLogin ?? '—' }}</dd>
          <dt>{{ locale.t('admin.lastPasswordChange') }}</dt>
          <dd>{{ user()!.lastPasswordChange ?? '—' }}</dd>
          <dt>permVersion</dt>
          <dd>{{ user()!.permVersion }}</dd>
        </dl>
      </section>

      <section>
        <h3>{{ locale.t('admin.account') }}</h3>
        <div class="row">
          @if (user()!.state === 'disabled' || user()!.state === 'locked') {
            <button type="button" [disabled]="busy()" (click)="setState('active')">
              {{ locale.t(user()!.state === 'locked' ? 'admin.unlock' : 'admin.enable') }}
            </button>
          } @else {
            <!-- The consequence is on the button, not in a dialog: disabling revokes every
                 session at once (iam.yaml updateUser), and a person about to press it should
                 read that where they are looking. -->
            <button
              type="button"
              class="danger"
              [disabled]="busy() || isSelf()"
              [title]="isSelf() ? locale.t('admin.notYourself') : locale.t('admin.disableWhy')"
              (click)="setState('disabled')"
            >
              {{ locale.t('admin.disable') }}
            </button>
            <span class="muted">{{ locale.t('admin.disableWhy') }}</span>
          }
        </div>
        <form class="row" (ngSubmit)="setPassword()">
          <label>
            <span>{{ locale.t('admin.newPassword') }}</span>
            <input
              name="password"
              type="password"
              autocomplete="new-password"
              [(ngModel)]="password"
              minlength="8"
            />
          </label>
          <button type="submit" [disabled]="busy() || password.length < 8">
            {{ locale.t('admin.setPassword') }}
          </button>
        </form>
      </section>

      <section>
        <h3>{{ locale.t('admin.grants') }}</h3>
        @if (assignments().length === 0) {
          <p class="muted">{{ locale.t('admin.noGrants') }}</p>
        } @else {
          <ul class="grants">
            @for (a of assignments(); track a.id) {
              <li>
                @if (a.roleId) {
                  <span class="kind">{{ locale.t('admin.role') }}</span>
                  <span class="what">{{ roleName(a.roleId) }}</span>
                } @else {
                  <span class="kind">{{ locale.t('admin.rule') }}</span>
                  <span class="what">{{ describeRule(a) }}</span>
                }
                <button type="button" class="link" [disabled]="busy()" (click)="revoke(a)">
                  {{ locale.t('admin.revoke') }}
                </button>
              </li>
            }
          </ul>
        }
        <form class="row" (ngSubmit)="grantRole()">
          <label>
            <span>{{ locale.t('admin.grantRole') }}</span>
            <select name="role" [(ngModel)]="roleId">
              <option value="">—</option>
              @for (role of grantableRoles(); track role.id) {
                <option [value]="role.id">{{ role.name ?? role.id }}</option>
              }
            </select>
          </label>
          <button type="submit" [disabled]="busy() || !roleId">
            {{ locale.t('admin.grant') }}
          </button>
        </form>
        <form class="row" (ngSubmit)="grantRule()">
          <label>
            <span>{{ locale.t('admin.grantRule') }}</span>
            <input
              name="permissions"
              [(ngModel)]="permissions"
              placeholder="asset:read, schedule:write"
              autocomplete="off"
            />
          </label>
          <button type="submit" [disabled]="busy() || parsedPermissions().length === 0">
            {{ locale.t('admin.grant') }}
          </button>
        </form>
        <p class="muted">{{ locale.t('admin.ruleScope') }}</p>
      </section>
    }
  `,
  styleUrl: './admin-editor.scss',
})
export class UserEditor implements OnInit {
  readonly userId = input.required<string>();
  readonly tabId = input.required<string>();

  private readonly api = inject(UsersService);
  private readonly editors = inject(EditorStore);
  private readonly session = inject(SessionStore);
  protected readonly locale = inject(LocaleService);

  protected readonly user = signal<User | null>(null);
  protected readonly assignments = signal<Assignment[]>([]);
  protected readonly roles = signal<Role[]>([]);
  protected readonly loadError = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly name = signal('');
  protected readonly dirty = signal(false);
  protected password = '';
  protected roleId = '';
  protected permissions = '';

  /** Disabling yourself would revoke the session doing it — refused here before IAM refuses it. */
  protected readonly isSelf = computed(() => this.user()?.id === this.session.userId());
  /** Roles not already held: a second grant of the same role is a 409 IAM would return anyway. */
  protected readonly grantableRoles = computed(() => {
    const held = new Set(this.assignments().map((a) => a.roleId));
    return this.roles().filter((r) => !held.has(r.id));
  });
  /** Read on each check rather than a `computed`: `permissions` is a form field, not a signal. */
  protected parsedPermissions(): string[] {
    return parsePermissions(this.permissions);
  }

  ngOnInit(): void {
    this.reload();
  }

  protected reload(): void {
    this.loadError.set(null);
    this.api.get(this.userId()).subscribe({
      next: (user) => {
        this.user.set(user);
        this.name.set(user.name ?? '');
        this.setDirty(false);
      },
      error: () => this.loadError.set(this.locale.t('admin.loadError')),
    });
    this.api.assignments(this.userId()).subscribe({
      next: (list) => this.assignments.set(list),
      error: () => this.loadError.set(this.locale.t('admin.loadError')),
    });
    this.api.roles().subscribe({ next: (list) => this.roles.set(list), error: () => undefined });
  }

  protected setName(value: string): void {
    this.name.set(value);
    this.setDirty(value.trim() !== (this.user()?.name ?? ''));
  }

  protected saveName(): void {
    if (!this.dirty() || this.busy()) return;
    this.write({ name: this.name().trim() });
  }

  protected setState(state: 'active' | 'disabled'): void {
    if (state === 'disabled' && this.isSelf()) return;
    this.write({ state });
  }

  protected setPassword(): void {
    if (this.password.length < 8) return;
    this.write({ password: this.password }, () => (this.password = ''));
  }

  protected grantRole(): void {
    if (!this.roleId) return;
    this.grant({ roleId: this.roleId }, () => (this.roleId = ''));
  }

  /** A rule scoped to the user's own channel — the one an admin here may grant (iam admin.ts). */
  protected grantRule(): void {
    const permissions = this.parsedPermissions();
    if (permissions.length === 0) return;
    const channelId = this.user()?.channelId;
    this.grant(
      {
        rule: {
          id: ulid(),
          effect: 'allow',
          permissions,
          ...(channelId ? { scope: { channelIds: [channelId] } } : {}),
        },
      },
      () => (this.permissions = ''),
    );
  }

  protected revoke(assignment: Assignment): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.api.revoke(this.userId(), assignment.id).subscribe({
      next: () => {
        this.assignments.update((list) => list.filter((a) => a.id !== assignment.id));
        this.busy.set(false);
      },
      error: (err) => this.fail(err),
    });
  }

  protected roleName(roleId: string): string {
    const role = this.roles().find((r) => r.id === roleId);
    return role?.name ?? roleId;
  }

  protected describeRule(a: Assignment): string {
    const rule = a.rule;
    if (!rule) return '';
    const scope = rule.scope?.channelIds?.length ? ` @ ${rule.scope.channelIds.join(', ')}` : '';
    const effect = rule.effect === 'deny' ? 'deny ' : '';
    return `${effect}${rule.permissions.join(', ')}${scope}`;
  }

  private write(patch: Parameters<UsersService['update']>[1], then?: () => void): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.api.update(this.userId(), patch).subscribe({
      next: (user) => {
        this.user.set(user);
        this.name.set(user.name ?? '');
        this.setDirty(false);
        this.busy.set(false);
        then?.();
      },
      error: (err) => this.fail(err),
    });
  }

  private grant(input: Parameters<UsersService['grant']>[1], then?: () => void): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.api.grant(this.userId(), input).subscribe({
      next: (assignment) => {
        this.assignments.update((list) => [...list, assignment]);
        this.busy.set(false);
        then?.();
      },
      error: (err) => this.fail(err),
    });
  }

  private fail(err: { error?: { message?: string } }): void {
    this.error.set(err?.error?.message ?? this.locale.t('admin.writeError'));
    this.busy.set(false);
  }

  private setDirty(dirty: boolean): void {
    this.dirty.set(dirty);
    this.editors.setDirty(this.tabId(), dirty);
  }
}

/** "asset:read, schedule:write" → the permissions, trimmed, de-duplicated, `noun:verb` only. */
export function parsePermissions(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,\s]+/)
        .map((p) => p.trim())
        .filter((p) => /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/.test(p)),
    ),
  ];
}
