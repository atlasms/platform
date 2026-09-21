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
import type { GroupWithMembers, Role, Rule, User } from '../core/generated/iam.types.ts';
import { GroupsService } from '../core/groups.service.ts';
import { LocaleService } from '../core/locale.service.ts';
import { RolesService } from '../core/roles.service.ts';
import { ulid } from '../core/ulid.ts';
import { UsersService } from '../core/users.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import { parsePermissions } from './user-editor.ts';

/**
 * A group, as an editor tab: its name and description (the dirty fields), its members, and its
 * grants — roles by id and inline rules. A group's grants reach EVERY member the moment they
 * change (IAM emits permissions.changed for each), which is why the grant controls say so, and
 * why deleting the group is the last thing on the page: it removes every member first.
 *
 * Each write is its own request against IAM, since each is its own audited mutation there.
 * Members are added by picking from the channel's users (the first page — a facility's users
 * number in the tens; paging the picker is a later need).
 */
@Component({
  selector: 'atlas-group-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    @if (loadError()) {
      <p class="error" role="alert">{{ loadError() }}</p>
    } @else if (!group()) {
      <p class="muted">{{ locale.t('admin.loading') }}</p>
    } @else {
      <header class="head">
        <h2>{{ group()!.name }}</h2>
        @if (group()!.channelId) {
          <span class="muted"
            >{{ locale.t('workbench.statusBar.channel') }} {{ group()!.channelId }}</span
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
        <form class="row" (ngSubmit)="saveProfile()">
          <label>
            <span>{{ locale.t('admin.name') }}</span>
            <input name="name" [ngModel]="name()" (ngModelChange)="setName($event)" required />
          </label>
          <label>
            <span>{{ locale.t('admin.description') }}</span>
            <input
              name="description"
              [ngModel]="description()"
              (ngModelChange)="setDescription($event)"
            />
          </label>
          <button type="submit" [disabled]="busy() || !dirty() || !name().trim()">
            {{ locale.t('admin.save') }}
          </button>
        </form>
      </section>

      <section>
        <h3>{{ locale.t('admin.members') }} ({{ members().length }})</h3>
        @if (members().length === 0) {
          <p class="muted">{{ locale.t('admin.noMembers') }}</p>
        } @else {
          <ul class="grants">
            @for (id of members(); track id) {
              <li>
                <span class="what">{{ usernameOf(id) }}</span>
                <button type="button" class="link" [disabled]="busy()" (click)="removeMember(id)">
                  {{ locale.t('admin.remove') }}
                </button>
              </li>
            }
          </ul>
        }
        <form class="row" (ngSubmit)="addMember()">
          <label>
            <span>{{ locale.t('admin.addMember') }}</span>
            <select name="member" [(ngModel)]="memberId">
              <option value="">—</option>
              @for (user of addableUsers(); track user.id) {
                <option [value]="user.id">{{ user.username }}</option>
              }
            </select>
          </label>
          <button type="submit" [disabled]="busy() || !memberId">
            {{ locale.t('admin.add') }}
          </button>
        </form>
      </section>

      <section>
        <h3>{{ locale.t('admin.grants') }}</h3>
        <p class="muted">{{ locale.t('admin.groupGrantsWhy') }}</p>
        @if (roleIds().length === 0 && rules().length === 0) {
          <p class="muted">{{ locale.t('admin.noGrants') }}</p>
        } @else {
          <ul class="grants">
            @for (roleId of roleIds(); track roleId) {
              <li>
                <span class="kind">{{ locale.t('admin.role') }}</span>
                <span class="what">{{ roleName(roleId) }}</span>
                <button type="button" class="link" [disabled]="busy()" (click)="removeRole(roleId)">
                  {{ locale.t('admin.revoke') }}
                </button>
              </li>
            }
            @for (rule of rules(); track rule.id) {
              <li>
                <span class="kind">{{ locale.t('admin.rule') }}</span>
                <span class="what">{{ describeRule(rule) }}</span>
                <button
                  type="button"
                  class="link"
                  [disabled]="busy()"
                  (click)="removeRule(rule.id)"
                >
                  {{ locale.t('admin.revoke') }}
                </button>
              </li>
            }
          </ul>
        }
        <form class="row" (ngSubmit)="addRole()">
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
        <form class="row" (ngSubmit)="addRule()">
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

      <section>
        <h3>{{ locale.t('admin.danger') }}</h3>
        <div class="row">
          <button type="button" class="danger" [disabled]="busy()" (click)="remove()">
            {{ locale.t('admin.deleteGroup') }}
          </button>
          <span class="muted">{{ locale.t('admin.deleteGroupWhy') }}</span>
        </div>
      </section>
    }
  `,
  styleUrl: './admin-editor.scss',
})
export class GroupEditor implements OnInit {
  readonly groupId = input.required<string>();
  readonly tabId = input.required<string>();

  private readonly api = inject(GroupsService);
  private readonly rolesApi = inject(RolesService);
  private readonly usersApi = inject(UsersService);
  private readonly editors = inject(EditorStore);
  protected readonly locale = inject(LocaleService);

  protected readonly group = signal<GroupWithMembers | null>(null);
  protected readonly roles = signal<Role[]>([]);
  protected readonly users = signal<User[]>([]);
  protected readonly loadError = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly name = signal('');
  protected readonly description = signal('');
  protected readonly dirty = signal(false);
  protected memberId = '';
  protected roleId = '';
  protected permissions = '';

  protected readonly members = computed(() => this.group()?.members ?? []);
  protected readonly roleIds = computed(() => this.group()?.roleIds ?? []);
  protected readonly rules = computed(() => this.group()?.rules ?? []);
  protected readonly addableUsers = computed(() => {
    const held = new Set(this.members());
    return this.users().filter((u) => !held.has(u.id));
  });
  protected readonly grantableRoles = computed(() => {
    const held = new Set(this.roleIds());
    return this.roles().filter((r) => !held.has(r.id));
  });

  ngOnInit(): void {
    this.reload();
  }

  protected reload(): void {
    this.loadError.set(null);
    this.api.get(this.groupId()).subscribe({
      next: (group) => {
        this.group.set(group);
        this.name.set(group.name);
        this.description.set(group.description ?? '');
        this.setDirty(false);
      },
      error: () => this.loadError.set(this.locale.t('admin.loadError')),
    });
    this.rolesApi
      .list()
      .subscribe({ next: (list) => this.roles.set(list), error: () => undefined });
    this.usersApi
      .list({ limit: 200 })
      .subscribe({ next: (page) => this.users.set(page.items), error: () => undefined });
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
    if (!this.dirty() || this.busy() || !this.name().trim()) return;
    const description = this.description().trim();
    this.patch({ name: this.name().trim(), description });
  }

  protected addMember(): void {
    if (!this.memberId) return;
    const userId = this.memberId;
    this.run(this.api.addMember(this.groupId(), userId), () => {
      this.group.update((g) => (g ? { ...g, members: [...g.members, userId] } : g));
      this.memberId = '';
    });
  }

  protected removeMember(userId: string): void {
    this.run(this.api.removeMember(this.groupId(), userId), () => {
      this.group.update((g) => (g ? { ...g, members: g.members.filter((m) => m !== userId) } : g));
    });
  }

  protected addRole(): void {
    if (!this.roleId) return;
    const roleId = this.roleId;
    this.patch({ roleIds: [...this.roleIds(), roleId] }, () => (this.roleId = ''));
  }

  protected removeRole(roleId: string): void {
    this.patch({ roleIds: this.roleIds().filter((r) => r !== roleId) });
  }

  /** A rule scoped to the group's channel — the one an admin here may grant. */
  protected addRule(): void {
    const permissions = this.parsedPermissions();
    if (permissions.length === 0) return;
    const channelId = this.group()?.channelId;
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
    this.run(this.api.delete(this.groupId()), () => this.editors.closeTab(this.tabId()));
  }

  protected parsedPermissions(): string[] {
    return parsePermissions(this.permissions);
  }

  protected usernameOf(userId: string): string {
    return this.users().find((u) => u.id === userId)?.username ?? userId;
  }

  protected roleName(roleId: string): string {
    return this.roles().find((r) => r.id === roleId)?.name ?? roleId;
  }

  protected describeRule(rule: Rule): string {
    const scope = rule.scope?.channelIds?.length ? ` @ ${rule.scope.channelIds.join(', ')}` : '';
    const effect = rule.effect === 'deny' ? 'deny ' : '';
    return `${effect}${rule.permissions.join(', ')}${scope}`;
  }

  /** A PATCH of the group: the response is the group, minus the members it does not carry. */
  private patch(input: Parameters<GroupsService['update']>[1], then?: () => void): void {
    this.run(this.api.update(this.groupId(), input), (group) => {
      this.group.update((g) => ({ ...(group as GroupWithMembers), members: g?.members ?? [] }));
      this.name.set(group.name);
      this.description.set(group.description ?? '');
      this.setDirty(false);
      then?.();
    });
  }

  private run<T>(call: Observable<T>, then: (value: T) => void): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    call.subscribe({
      next: (value) => {
        this.busy.set(false);
        then(value);
      },
      error: (err) => {
        this.error.set(
          (err as { error?: { message?: string } })?.error?.message ??
            this.locale.t('admin.writeError'),
        );
        this.busy.set(false);
      },
    });
  }

  private recomputeDirty(): void {
    const g = this.group();
    this.setDirty(
      !!g && (this.name().trim() !== g.name || this.description().trim() !== (g.description ?? '')),
    );
  }

  private setDirty(dirty: boolean): void {
    this.dirty.set(dirty);
    this.editors.setDirty(this.tabId(), dirty);
  }
}
