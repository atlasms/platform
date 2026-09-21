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
import type { Role, Rule } from '../core/generated/iam.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { RolesService } from '../core/roles.service.ts';
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

  protected readonly rules = computed(() => this.role()?.rules ?? []);
  /** Platform-wide roles are shown, not edited: they are no channel's, and IAM would refuse. */
  protected readonly readOnly = computed(() => {
    const role = this.role();
    return !!role && !role.channelId;
  });

  ngOnInit(): void {
    this.reload();
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
