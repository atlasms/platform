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
import type { Observable } from 'rxjs';
import type { Group, Role, RoleHolders, Rule, UserPage } from '../core/generated/iam.types.ts';
import { GroupsService } from '../core/groups.service.ts';
import { LocaleService } from '../core/locale.service.ts';
import { RolesService } from '../core/roles.service.ts';
import { UsersService } from '../core/users.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { ulid } from '../core/ulid.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import { parsePermissions } from './user-editor.ts';

/**
 * A role, as an editor tab: a named bundle of rules. Editing it edits it for EVERY holder,
 * directly or through a group — the page says so above the rules. A platform-wide role (the
 * starter roles, EP-10.7) is shown read-only: it is not this channel's to edit, and IAM would
 * refuse with a 403 anyway; the controls are simply not offered. Deleting is refused by IAM
 * while anything still holds the role (409), and the message says so.
 */
@Component({
  selector: 'atlas-role-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    @if (loadError()) {
      <p class="error" role="alert">{{ loadError() }}</p>
    } @else if (!role()) {
      <p class="muted">{{ locale.t('admin.loading') }}</p>
    } @else {
      <header class="head">
        <h2>{{ role()!.name ?? role()!.id }}</h2>
        <span class="state">{{ role()!.id }}</span>
        @if (readOnly()) {
          <span class="muted">{{ locale.t('admin.platformWideRole') }}</span>
        }
      </header>
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }

      @if (!readOnly()) {
        <section>
          <h3>{{ locale.t('admin.profile') }}</h3>
          <form class="row" (ngSubmit)="saveProfile()">
            <label>
              <span>{{ locale.t('admin.name') }}</span>
              <input name="name" [ngModel]="name()" (ngModelChange)="setName($event)" />
            </label>
            <label>
              <span>{{ locale.t('admin.description') }}</span>
              <input
                name="description"
                [ngModel]="description()"
                (ngModelChange)="setDescription($event)"
              />
            </label>
            <button type="submit" [disabled]="busy() || !dirty()">
              {{ locale.t('admin.save') }}
            </button>
          </form>
        </section>
      }

      <section>
        <h3>{{ locale.t('admin.rules') }}</h3>
        <p class="muted">{{ locale.t('admin.roleRulesWhy') }}</p>
        @if (rules().length === 0) {
          <p class="muted">{{ locale.t('admin.noRules') }}</p>
        } @else {
          <ul class="grants">
            @for (rule of rules(); track rule.id) {
              <li>
                <span class="kind">{{ locale.t('admin.rule') }}</span>
                <span class="what">{{ describeRule(rule) }}</span>
                @if (!readOnly()) {
                  <button
                    type="button"
                    class="link"
                    [disabled]="busy()"
                    (click)="removeRule(rule.id)"
                  >
                    {{ locale.t('admin.remove') }}
                  </button>
                }
              </li>
            }
          </ul>
        }
        @if (!readOnly()) {
          <form class="row" (ngSubmit)="addRule()">
            <label>
              <span>{{ locale.t('admin.addRule') }}</span>
              <input
                name="permissions"
                [(ngModel)]="permissions"
                placeholder="asset:read, schedule:write"
                autocomplete="off"
              />
            </label>
            <button type="submit" [disabled]="busy() || parsedPermissions().length === 0">
              {{ locale.t('admin.add') }}
            </button>
          </form>
          <p class="muted">{{ locale.t('admin.ruleScope') }}</p>
        }
      </section>

      <section>
        <h3>{{ locale.t('admin.holders') }}</h3>
        <p class="muted">{{ locale.t('admin.holdersWhy') }}</p>
        @if (holdersError()) {
          <p class="muted">{{ holdersError() }}</p>
        } @else if (!holders()) {
          <p class="muted">{{ locale.t('admin.loading') }}</p>
        } @else if (holders()!.users.length === 0 && holders()!.groups.length === 0) {
          <p class="muted">{{ locale.t('admin.noHolders') }}</p>
        } @else {
          <ul class="grants">
            @for (group of holders()!.groups; track group.id) {
              <li>
                <span class="kind">{{ locale.t('admin.group') }}</span>
                <span class="what">{{ group.name }}</span>
                @if (!readOnly()) {
                  <button
                    type="button"
                    class="link"
                    [disabled]="busy()"
                    (click)="revokeGroup(group.id)"
                  >
                    {{ locale.t('admin.remove') }}
                  </button>
                }
              </li>
            }
            @for (user of holders()!.users; track user.id) {
              <li>
                <span class="kind">{{ locale.t('admin.user') }}</span>
                <span class="what">{{ user.username }}{{ viaSuffix(user) }}</span>
                @if (!readOnly() && user.assignmentId) {
                  <button
                    type="button"
                    class="link"
                    [disabled]="busy()"
                    (click)="revokeUser(user.id, user.assignmentId!)"
                  >
                    {{ locale.t('admin.remove') }}
                  </button>
                }
              </li>
            }
          </ul>
        }
        @if (!readOnly()) {
          <form class="row" (ngSubmit)="grant()">
            <label>
              <span>{{ locale.t('admin.grantTo') }}</span>
              <select name="holder" [(ngModel)]="holderRef">
                <option value="">—</option>
                @for (group of grantableGroups(); track group.id) {
                  <option [value]="'group:' + group.id">{{ group.name }}</option>
                }
                @for (user of grantableUsers(); track user.id) {
                  <option [value]="'user:' + user.id">{{ user.username }}</option>
                }
              </select>
            </label>
            <button type="submit" [disabled]="busy() || holderRef === ''">
              {{ locale.t('admin.add') }}
            </button>
          </form>
        }
      </section>

      @if (!readOnly()) {
        <section>
          <h3>{{ locale.t('admin.danger') }}</h3>
          <div class="row">
            <button type="button" class="danger" [disabled]="busy()" (click)="remove()">
              {{ locale.t('admin.deleteRole') }}
            </button>
            <span class="muted">{{ locale.t('admin.deleteRoleWhy') }}</span>
          </div>
        </section>
      }
    }
  `,
  styleUrl: './admin-editor.scss',
})
export class RoleEditor implements OnInit {
  readonly roleId = input.required<string>();
  readonly tabId = input.required<string>();

  private readonly api = inject(RolesService);
  private readonly groupsApi = inject(GroupsService);
  private readonly usersApi = inject(UsersService);
  private readonly editors = inject(EditorStore);
  private readonly session = inject(SessionStore);
  protected readonly locale = inject(LocaleService);

  protected readonly role = signal<Role | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly name = signal('');
  protected readonly description = signal('');
  protected readonly dirty = signal(false);
  protected permissions = '';

  /** Who holds the role; `null` until read. See {@link loadHolders} for why it can stay null. */
  protected readonly holders = signal<RoleHolders | null>(null);
  protected readonly holdersError = signal<string | null>(null);
  protected readonly groups = signal<Group[]>([]);
  protected readonly users = signal<UserPage['items']>([]);
  /** The select's value: `user:<id>` or `group:<id>`, one control for two kinds of holder. */
  protected holderRef = '';

  /** Only what does not already hold it — granting twice is a second grant, not a no-op. */
  protected readonly grantableGroups = computed(() => {
    const held = new Set(this.holders()?.groups.map((g) => g.id) ?? []);
    return this.groups().filter((g) => !held.has(g.id));
  });
  protected readonly grantableUsers = computed(() => {
    // A user the role reaches only through a group CAN still be granted it directly, and
    // sometimes should be — the direct grant survives them leaving the group. So the filter is
    // on the direct grant, not on reachability.
    const granted = new Set(
      (this.holders()?.users ?? []).filter((u) => u.assignmentId).map((u) => u.id),
    );
    return this.users().filter((u) => !granted.has(u.id));
  });

  protected readonly rules = computed(() => this.role()?.rules ?? []);
  /** Platform-wide roles are shown, not edited: they are no channel's, and IAM would refuse. */
  protected readonly readOnly = computed(() => {
    const role = this.role();
    return !!role && !role.channelId;
  });

  ngOnInit(): void {
    this.reload();
    this.loadHolders();
    this.groupsApi.list().subscribe({ next: (groups) => this.groups.set(groups) });
    this.usersApi.list({ limit: 200 }).subscribe({ next: (page) => this.users.set(page.items) });
  }

  /**
   * Who holds the role.
   *
   * A platform-wide role's holders span every channel, so IAM answers this one only to an
   * unscoped `user:admin` and reports 404 to anyone else — the same answer it gives for a role
   * that does not exist, because "which roles exist elsewhere" is itself a leak. A channel
   * administrator therefore sees the role and its rules (which are not secret from the people
   * they are granted to) and a line saying why the holders are not listed, rather than an error.
   */
  protected loadHolders(): void {
    this.api.holders(this.roleId()).subscribe({
      next: (holders) => {
        this.holders.set(holders);
        this.holdersError.set(null);
      },
      error: (err: { status?: number }) => {
        this.holders.set(null);
        // A 404 here means one thing, because the role itself loaded a moment ago: this is a
        // platform-wide role and the caller administers a channel. Any other failure is reported
        // as one rather than explained away.
        this.holdersError.set(
          this.locale.t(
            err.status === 404 && this.readOnly() ? 'admin.holdersPlatformWide' : 'admin.loadError',
          ),
        );
      },
    });
  }

  protected viaSuffix(user: RoleHolders['users'][number]): string {
    const names = (user.viaGroupIds ?? [])
      .map((id) => this.holders()?.groups.find((g) => g.id === id)?.name ?? id)
      .join(', ');
    if (names === '') return '';
    return ` — ${this.locale.t('admin.viaGroup')} ${names}`;
  }

  /** Grant the role to whichever kind of holder the one select names. */
  protected grant(): void {
    const [kind, id] = this.holderRef.split(':');
    if (!id) return;
    if (kind === 'user') {
      this.act(this.usersApi.grant(id, { roleId: this.roleId() }));
      return;
    }
    const group = this.groups().find((g) => g.id === id);
    if (!group) return;
    this.act(this.groupsApi.update(id, { roleIds: [...(group.roleIds ?? []), this.roleId()] }));
  }

  protected revokeUser(userId: string, assignmentId: string): void {
    this.act(this.usersApi.revoke(userId, assignmentId));
  }

  protected revokeGroup(groupId: string): void {
    const group = this.groups().find((g) => g.id === groupId);
    if (!group) return;
    this.act(
      this.groupsApi.update(groupId, {
        roleIds: (group.roleIds ?? []).filter((r) => r !== this.roleId()),
      }),
    );
  }

  /**
   * One write against IAM, then re-read the holders rather than patching them locally.
   *
   * The answer is a join across assignments, groups and memberships — reconstructing it in the
   * browser would be a second implementation of the thing being displayed, and it is one request.
   */
  private act(call: Observable<unknown>): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    call.subscribe({
      next: () => {
        this.busy.set(false);
        this.holderRef = '';
        this.loadHolders();
        this.groupsApi.list().subscribe({ next: (groups) => this.groups.set(groups) });
      },
      error: (err: { error?: { message?: string } }) => {
        this.error.set(err?.error?.message ?? this.locale.t('admin.writeError'));
        this.busy.set(false);
      },
    });
  }

  protected reload(): void {
    this.loadError.set(null);
    this.api.get(this.roleId()).subscribe({
      next: (role) => {
        this.role.set(role);
        this.name.set(role.name ?? '');
        this.description.set(role.description ?? '');
        this.setDirty(false);
      },
      error: () => this.loadError.set(this.locale.t('admin.loadError')),
    });
  }

  protected setName(value: string): void {
    this.name.set(value);
    this.recomputeDirty();
  }

  protected setDescription(value: string): void {
    this.description.set(value);
    this.recomputeDirty();
  }

  protected saveProfile(): void {
    if (!this.dirty() || this.busy()) return;
    this.patch({ name: this.name().trim(), description: this.description().trim() });
  }

  /** A rule scoped to the caller's channel — the channel the role belongs to. */
  protected addRule(): void {
    const permissions = this.parsedPermissions();
    if (permissions.length === 0) return;
    const channelId = this.role()?.channelId ?? this.session.channelId();
    const rule: Rule = {
      id: ulid(),
      effect: 'allow',
      permissions,
      ...(channelId ? { scope: { channelIds: [channelId] } } : {}),
    };
    this.patch({ rules: [...this.rules(), rule] }, () => (this.permissions = ''));
  }

  protected removeRule(ruleId: string): void {
    this.patch({ rules: this.rules().filter((r) => r.id !== ruleId) });
  }

  protected remove(): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.api.delete(this.roleId()).subscribe({
      next: () => {
        this.busy.set(false);
        this.editors.closeTab(this.tabId());
      },
      error: (err: { status?: number; error?: { message?: string } }) => {
        this.error.set(
          err.status === 409
            ? this.locale.t('admin.roleHeld')
            : (err.error?.message ?? this.locale.t('admin.writeError')),
        );
        this.busy.set(false);
      },
    });
  }

  protected parsedPermissions(): string[] {
    return parsePermissions(this.permissions);
  }

  protected describeRule(rule: Rule): string {
    const scope = rule.scope?.channelIds?.length ? ` @ ${rule.scope.channelIds.join(', ')}` : '';
    const effect = rule.effect === 'deny' ? 'deny ' : '';
    return `${effect}${rule.permissions.join(', ')}${scope}`;
  }

  private patch(input: Parameters<RolesService['update']>[1], then?: () => void): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.api.update(this.roleId(), input).subscribe({
      next: (role) => {
        this.role.set(role);
        this.name.set(role.name ?? '');
        this.description.set(role.description ?? '');
        this.setDirty(false);
        this.busy.set(false);
        then?.();
      },
      error: (err: { error?: { message?: string } }) => {
        this.error.set(err?.error?.message ?? this.locale.t('admin.writeError'));
        this.busy.set(false);
      },
    });
  }

  private recomputeDirty(): void {
    const r = this.role();
    this.setDirty(
      !!r &&
        (this.name().trim() !== (r.name ?? '') ||
          this.description().trim() !== (r.description ?? '')),
    );
  }

  private setDirty(dirty: boolean): void {
    this.dirty.set(dirty);
    this.editors.setDirty(this.tabId(), dirty);
  }
}
