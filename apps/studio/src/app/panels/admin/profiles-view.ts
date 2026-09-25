import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Profile, ProfileInput } from '../../core/generated/mts.types.ts';
import { LocaleService } from '../../core/locale.service.ts';
import { PermissionService } from '../../core/permission.service.ts';
import { ProfilesService, type ProfileScope } from '../../core/profiles.service.ts';
import {
  BUILT_IN_IDS,
  KINDS,
  PROFILE_ID,
  draftForKind,
  toInput,
} from '../../editors/profile.model.ts';
import { openProfile } from '../../editors/profile-editor.ts';
import { EditorStore } from '../../workbench/editor.store.ts';

/** One row: a stored profile, and what it means for the channel on screen. */
interface ProfileRow {
  readonly profile: Profile;
  readonly scope: ProfileScope;
  /** A platform-wide profile this channel redefines with an ENABLED one of its own. */
  readonly overridden: boolean;
  /** Its id is a built-in preset's, which it therefore redefines in its scope. */
  readonly redefinesBuiltIn: boolean;
}

/**
 * The Admin panel's Transcode profiles view (EP-16.6): MTS's registry as this channel resolves
 * it — the channel's own profiles and the platform-wide ones — and a new one. A profile opens as
 * an EDITOR TAB (profile-editor.ts), where its target is.
 *
 * The rows say what resolution will do, since that is the question an administrator is asking:
 * a platform profile the channel redefines is marked as such, a disabled one as disabled, and an
 * id that is a built-in's as redefining it.
 */
@Component({
  selector: 'atlas-profiles-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    @if (canWrite()) {
      <details class="new" [open]="creating()">
        <summary (click)="creating.set(!creating()); $event.preventDefault()">
          {{ locale.t('admin.newProfile') }}
        </summary>
        <form (ngSubmit)="create()">
          <label>
            <span>{{ locale.t('admin.profileId') }}</span>
            <input name="id" [(ngModel)]="id" autocomplete="off" placeholder="house-proxy" />
          </label>
          <p class="muted">{{ locale.t('admin.profileIdHint') }}</p>
          <label>
            <span>{{ locale.t('admin.name') }}</span>
            <input name="name" [(ngModel)]="name" autocomplete="off" required />
          </label>
          <label>
            <span>{{ locale.t('admin.profileKind') }}</span>
            <select name="kind" [(ngModel)]="kind">
              @for (k of kinds; track k) {
                <option [value]="k">{{ locale.t('admin.kind.' + k) }}</option>
              }
            </select>
          </label>
          @if (canWritePlatform()) {
            <label>
              <span>{{ locale.t('admin.profileScope') }}</span>
              <select name="scope" [(ngModel)]="scope">
                <option value="channel">{{ locale.t('admin.scopeChannel') }}</option>
                <option value="platform">{{ locale.t('admin.platformWide') }}</option>
              </select>
            </label>
          }
          @if (createError()) {
            <p class="error" role="alert">{{ createError() }}</p>
          }
          <button type="submit" [disabled]="busy() || !name.trim() || !idOk()">
            {{ locale.t('admin.create') }}
          </button>
        </form>
      </details>
    }

    <p class="mode">{{ locale.t('admin.profiles') }}</p>
    <p class="muted">{{ locale.t('admin.profilesWhy') }}</p>
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    } @else if (loading()) {
      <p class="muted">{{ locale.t('admin.loading') }}</p>
    } @else if (rows().length === 0) {
      <p class="muted">{{ locale.t('admin.noProfiles') }}</p>
    } @else {
      <ul class="items">
        @for (row of rows(); track row.scope + '/' + row.profile.id) {
          <li>
            <button type="button" (click)="open(row.profile, row.scope)">
              <span class="title">{{ row.profile.name }}</span>
              <span class="muted">{{ row.profile.id }}</span>
              <span class="state">{{
                locale.t(row.scope === 'platform' ? 'admin.platformWide' : 'admin.scopeChannel')
              }}</span>
              @if (!row.profile.enabled) {
                <span class="state" data-state="disabled">{{
                  locale.t('admin.profileDisabled')
                }}</span>
              } @else if (row.overridden) {
                <span class="state">{{ locale.t('admin.profileOverridden') }}</span>
              } @else if (row.redefinesBuiltIn) {
                <span class="state">{{ locale.t('admin.profileBuiltIn') }}</span>
              }
            </button>
          </li>
        }
      </ul>
    }
  `,
  styleUrl: './admin-view.scss',
})
export class ProfilesView {
  private readonly api = inject(ProfilesService);
  private readonly editors = inject(EditorStore);
  private readonly permissions = inject(PermissionService);
  protected readonly locale = inject(LocaleService);

  protected readonly kinds = KINDS;
  protected readonly profiles = signal<Profile[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly creating = signal(false);
  protected readonly busy = signal(false);
  protected readonly createError = signal<string | null>(null);
  protected id = '';
  protected name = '';
  protected kind: ProfileInput['kind'] = 'proxy';
  protected scope: ProfileScope = 'channel';

  /** UX only — MTS enforces `config:admin` in the row's scope. */
  protected readonly canWrite = computed(() => this.permissions.can('config:admin'));
  /** A platform-wide write needs an UNSCOPED grant; a channel administrator is not offered it. */
  protected readonly canWritePlatform = computed(() =>
    this.permissions.canPlatformWide('config:admin'),
  );

  /** Sorted by id, the channel's before the platform's of the same id — the resolution order. */
  protected readonly rows = computed<ProfileRow[]>(() => {
    const list = this.profiles();
    const redefinedHere = new Set(list.filter((p) => p.channelId && p.enabled).map((p) => p.id));
    return list
      .map((profile): ProfileRow => {
        const scope: ProfileScope = profile.channelId ? 'channel' : 'platform';
        return {
          profile,
          scope,
          overridden: scope === 'platform' && redefinedHere.has(profile.id),
          redefinesBuiltIn: BUILT_IN_IDS.includes(profile.id),
        };
      })
      .sort(
        (a, b) =>
          a.profile.id.localeCompare(b.profile.id) ||
          (a.scope === b.scope ? 0 : a.scope === 'channel' ? -1 : 1),
      );
  });

  constructor() {
    this.load();
  }

  protected idOk(): boolean {
    return PROFILE_ID.test(this.id);
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.list().subscribe({
      next: (profiles) => {
        this.profiles.set(profiles);
        this.loading.set(false);
      },
      error: () => {
        this.error.set(this.locale.t('admin.loadError'));
        this.loading.set(false);
      },
    });
  }

  /**
   * Create with the kind's starting target — a valid profile on the first save — and open it,
   * where the target is edited. A platform-wide one says so in the body (`channelId: null`).
   */
  protected create(): void {
    const name = this.name.trim();
    if (!name || !this.idOk() || this.busy()) return;
    const scope: ProfileScope = this.canWritePlatform() ? this.scope : 'channel';
    this.busy.set(true);
    this.createError.set(null);
    const input = toInput(this.id, draftForKind(this.kind, name));
    this.api.create(scope === 'platform' ? { ...input, channelId: null } : input).subscribe({
      next: (profile) => {
        this.profiles.update((list) => [profile, ...list]);
        this.id = '';
        this.name = '';
        this.busy.set(false);
        this.creating.set(false);
        this.open(profile, scope);
      },
      error: (err: { status?: number; error?: { message?: string } }) => {
        this.createError.set(
          err.status === 409
            ? this.locale.t('admin.profileIdTaken')
            : (err.error?.message ?? this.locale.t('admin.createError')),
        );
        this.busy.set(false);
      },
    });
  }

  protected open(profile: Profile, scope: ProfileScope): void {
    openProfile(this.editors, profile, scope);
  }
}
