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
import type { Profile } from '../core/generated/mts.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { PermissionService } from '../core/permission.service.ts';
import { ProfilesService, type ProfileScope } from '../core/profiles.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import {
  AUDIO_CODECS,
  CHROMAS,
  CONTAINERS,
  FITS,
  FRAME_RATES,
  GPUS,
  KINDS,
  NO_PROBLEMS,
  SAMPLE_RATES,
  SCANS,
  VIDEO_CODECS,
  draftFrom,
  isStill,
  splitProblems,
  toInput,
  type ProfileDraft,
  type Problems,
} from './profile.model.ts';

/**
 * A transcode profile, as an editor tab (EP-16.6): the structured target MTS compiles to FFmpeg
 * arguments. There is no arguments field, and there will not be one — that is the registry's
 * design (mts.md §11.1), not a gap in this page.
 *
 * - **MTS judges.** Save sends the whole profile; a combination FFmpeg would refuse comes back as a
 *   422 whose rules are shown under the field each one names, and above the form when it is about
 *   a combination. The page does not re-check the grammar — a second copy would drift from the
 *   one that decides.
 * - **A save is a compare-and-set.** It carries the version the tab loaded; if someone else saved
 *   since, MTS answers 409 and the page says so and offers to reload — it never retries with the
 *   new version, which would overwrite their change with one made without seeing it.
 * - **Disabled, never deleted.** The switch is `enabled`; a disabled channel profile puts the
 *   channel back on the platform's (or the built-in).
 * - **Read-only when the scope is not the caller's to write:** a platform-wide profile for a
 *   channel administrator, who is instead offered "Redefine for this channel" — the registry's
 *   own mechanism for a channel wanting something else.
 */
@Component({
  selector: 'atlas-profile-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    @if (loadError()) {
      <p class="error" role="alert">{{ loadError() }}</p>
    } @else if (!profile()) {
      <p class="muted">{{ locale.t('admin.loading') }}</p>
    } @else {
      <header class="head">
        <h2>{{ profile()!.name }}</h2>
        <span class="state">{{ profile()!.id }}</span>
        <span class="state">{{
          locale.t(scope() === 'platform' ? 'admin.platformWide' : 'admin.scopeChannel')
        }}</span>
        <span class="state">v{{ profile()!.version }}</span>
        @if (!profile()!.enabled) {
          <span class="state" data-state="disabled">{{ locale.t('admin.profileDisabled') }}</span>
        }
      </header>

      @if (readOnly()) {
        <p class="muted">{{ locale.t('admin.profileReadOnly') }}</p>
        @if (canRedefine()) {
          <div class="row">
            <button type="button" [disabled]="busy()" (click)="redefine()">
              {{ locale.t('admin.profileRedefine') }}
            </button>
            <span class="muted">{{ locale.t('admin.profileRedefineWhy') }}</span>
          </div>
        }
      }

      @if (conflict()) {
        <div class="row" role="alert">
          <p class="error">{{ locale.t('admin.profileConflict') }}</p>
          <button type="button" (click)="reload()">{{ locale.t('admin.reload') }}</button>
        </div>
      }
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
      @if (problems().general.length > 0) {
        <ul class="problems" role="alert">
          @for (rule of problems().general; track rule) {
            <li class="error">{{ rule }}</li>
          }
        </ul>
      }

      <form (ngSubmit)="save()">
        <fieldset [disabled]="readOnly() || busy()">
          <section>
            <h3>{{ locale.t('admin.profile') }}</h3>
            <div class="fields">
              <label>
                <span>{{ locale.t('admin.name') }}</span>
                <input name="name" [ngModel]="d().name" (ngModelChange)="set('name', $event)" />
                @for (m of problemsFor('name'); track m) {
                  <small class="error">{{ m }}</small>
                }
              </label>
              <label>
                <span>{{ locale.t('admin.description') }}</span>
                <input
                  name="description"
                  [ngModel]="d().description"
                  (ngModelChange)="set('description', $event)"
                />
              </label>
              <label>
                <span>{{ locale.t('admin.profileKind') }}</span>
                <select name="kind" [ngModel]="d().kind" (ngModelChange)="set('kind', $event)">
                  @for (k of kinds; track k) {
                    <option [value]="k">{{ locale.t('admin.kind.' + k) }}</option>
                  }
                </select>
                @for (m of problemsFor('kind'); track m) {
                  <small class="error">{{ m }}</small>
                }
              </label>
              <label>
                <span>{{ locale.t('admin.container') }}</span>
                <select
                  name="container"
                  [ngModel]="d().container"
                  (ngModelChange)="set('container', $event)"
                >
                  @for (c of containers; track c) {
                    <option [value]="c">{{ c }}</option>
                  }
                </select>
                @for (m of problemsFor('container'); track m) {
                  <small class="error">{{ m }}</small>
                }
              </label>
              <label class="check">
                <input
                  type="checkbox"
                  name="enabled"
                  [ngModel]="d().enabled"
                  (ngModelChange)="set('enabled', $event)"
                />
                <span>{{ locale.t('admin.profileEnabled') }}</span>
              </label>
            </div>
            <p class="muted">{{ locale.t('admin.profileEnabledWhy') }}</p>
          </section>

          <section>
            <h3>
              <label class="check">
                <input
                  type="checkbox"
                  name="hasVideo"
                  [ngModel]="d().hasVideo"
                  (ngModelChange)="set('hasVideo', $event)"
                />
                <span>{{ locale.t('admin.video') }}</span>
              </label>
            </h3>
            @if (d().hasVideo) {
              <div class="fields">
                @if (!still()) {
                  <label>
                    <span>{{ locale.t('admin.codec') }}</span>
                    <select
                      name="codec"
                      [ngModel]="d().codec"
                      (ngModelChange)="set('codec', $event)"
                    >
                      @for (c of videoCodecs; track c) {
                        <option [value]="c">{{ c }}</option>
                      }
                    </select>
                    @for (m of problemsFor('video.codec'); track m) {
                      <small class="error">{{ m }}</small>
                    }
                  </label>
                }
                <label>
                  <span>{{ locale.t('admin.width') }}</span>
                  <input
                    type="number"
                    name="width"
                    step="2"
                    [ngModel]="d().width"
                    (ngModelChange)="set('width', $event)"
                  />
                  @for (m of problemsFor('video.width'); track m) {
                    <small class="error">{{ m }}</small>
                  }
                </label>
                <label>
                  <span>{{ locale.t('admin.height') }}</span>
                  <input
                    type="number"
                    name="height"
                    step="2"
                    [ngModel]="d().height"
                    (ngModelChange)="set('height', $event)"
                  />
                  @for (m of problemsFor('video.height'); track m) {
                    <small class="error">{{ m }}</small>
                  }
                </label>
                <label>
                  <span>{{ locale.t('admin.fit') }}</span>
                  <select name="fit" [ngModel]="d().fit" (ngModelChange)="set('fit', $event)">
                    @for (f of fits; track f) {
                      <option [value]="f">{{ locale.t('admin.fitMode.' + f) }}</option>
                    }
                  </select>
                </label>
                @if (!still()) {
                  <label>
                    <span>{{ locale.t('admin.frameRate') }}</span>
                    <select
                      name="frameRate"
                      [ngModel]="d().frameRate"
                      (ngModelChange)="set('frameRate', $event)"
                    >
                      <option value="">{{ locale.t('admin.asSource') }}</option>
                      @for (r of frameRates; track r) {
                        <option [value]="r">{{ r }}</option>
                      }
                    </select>
                    @for (m of problemsFor('video.frameRate'); track m) {
                      <small class="error">{{ m }}</small>
                    }
                  </label>
                  <label>
                    <span>{{ locale.t('admin.scan') }}</span>
                    <select name="scan" [ngModel]="d().scan" (ngModelChange)="set('scan', $event)">
                      @for (s of scans; track s) {
                        <option [value]="s">{{ locale.t('admin.scanMode.' + s) }}</option>
                      }
                    </select>
                  </label>
                  <label>
                    <span>{{ locale.t('admin.chroma') }}</span>
                    <select
                      name="chroma"
                      [ngModel]="d().chroma"
                      (ngModelChange)="set('chroma', $event)"
                    >
                      @for (c of chromas; track c) {
                        <option [value]="c">{{ c[0] }}:{{ c[1] }}:{{ c[2] }}</option>
                      }
                    </select>
                    @for (m of problemsFor('video.chroma'); track m) {
                      <small class="error">{{ m }}</small>
                    }
                  </label>
                  <label>
                    <span>{{ locale.t('admin.rateMode') }}</span>
                    <select
                      name="rateMode"
                      [ngModel]="d().rateMode"
                      (ngModelChange)="set('rateMode', $event)"
                    >
                      <option value="bitrate">{{ locale.t('admin.rate.bitrate') }}</option>
                      <option value="quality">{{ locale.t('admin.rate.quality') }}</option>
                    </select>
                  </label>
                  @if (d().rateMode === 'bitrate') {
                    <label>
                      <span>{{ locale.t('admin.bitrateMbps') }}</span>
                      <input
                        type="number"
                        name="bitrateMbps"
                        step="0.1"
                        [ngModel]="d().bitrateMbps"
                        (ngModelChange)="set('bitrateMbps', $event)"
                      />
                      @for (m of problemsFor('video.bitrateMbps'); track m) {
                        <small class="error">{{ m }}</small>
                      }
                    </label>
                  } @else {
                    <label>
                      <span>{{ locale.t('admin.quality') }}</span>
                      <input
                        type="number"
                        name="quality"
                        step="1"
                        [ngModel]="d().quality"
                        (ngModelChange)="set('quality', $event)"
                      />
                      @for (m of problemsFor('video.quality'); track m) {
                        <small class="error">{{ m }}</small>
                      }
                    </label>
                  }
                  <label>
                    <span>{{ locale.t('admin.gpu') }}</span>
                    <select name="gpu" [ngModel]="d().gpu" (ngModelChange)="set('gpu', $event)">
                      @for (g of gpus; track g) {
                        <option [value]="g">{{ locale.t('admin.gpuMode.' + g) }}</option>
                      }
                    </select>
                    @for (m of problemsFor('video.gpu'); track m) {
                      <small class="error">{{ m }}</small>
                    }
                  </label>
                }
              </div>
              @if (!still() && d().gpu !== 'none') {
                <p class="muted">{{ locale.t('admin.gpuWhy') }}</p>
              }
            }
          </section>

          <section>
            <h3>
              <label class="check">
                <input
                  type="checkbox"
                  name="hasAudio"
                  [ngModel]="d().hasAudio"
                  (ngModelChange)="set('hasAudio', $event)"
                />
                <span>{{ locale.t('admin.audio') }}</span>
              </label>
            </h3>
            @if (d().hasAudio) {
              <div class="fields">
                <label>
                  <span>{{ locale.t('admin.codec') }}</span>
                  <select
                    name="audioCodec"
                    [ngModel]="d().audioCodec"
                    (ngModelChange)="set('audioCodec', $event)"
                  >
                    @for (c of audioCodecs; track c) {
                      <option [value]="c">{{ c }}</option>
                    }
                  </select>
                  @for (m of problemsFor('audio.codec'); track m) {
                    <small class="error">{{ m }}</small>
                  }
                </label>
                <label>
                  <span>{{ locale.t('admin.sampleRate') }}</span>
                  <select
                    name="sampleRate"
                    [ngModel]="d().sampleRate"
                    (ngModelChange)="set('sampleRate', $event)"
                  >
                    <option [ngValue]="null">{{ locale.t('admin.mtsDefault') }}</option>
                    @for (r of sampleRates; track r) {
                      <option [ngValue]="r">{{ r }}</option>
                    }
                  </select>
                  @for (m of problemsFor('audio.sampleRate'); track m) {
                    <small class="error">{{ m }}</small>
                  }
                </label>
                <label>
                  <span>{{ locale.t('admin.channels') }}</span>
                  <input
                    type="number"
                    name="channels"
                    min="1"
                    max="16"
                    [placeholder]="locale.t('admin.asSource')"
                    [ngModel]="d().channels"
                    (ngModelChange)="set('channels', $event)"
                  />
                  @for (m of problemsFor('audio.channels'); track m) {
                    <small class="error">{{ m }}</small>
                  }
                </label>
                @if (d().audioCodec === 'aac') {
                  <label>
                    <span>{{ locale.t('admin.bitrateKbps') }}</span>
                    <input
                      type="number"
                      name="bitrateKbps"
                      [placeholder]="locale.t('admin.mtsDefault')"
                      [ngModel]="d().bitrateKbps"
                      (ngModelChange)="set('bitrateKbps', $event)"
                    />
                    @for (m of problemsFor('audio.bitrateKbps'); track m) {
                      <small class="error">{{ m }}</small>
                    }
                  </label>
                }
              </div>
            }
          </section>

          @if (!readOnly()) {
            <div class="row actions">
              <button type="submit" [disabled]="busy() || !dirty()">
                {{ locale.t('admin.save') }}
              </button>
              <button type="button" class="link" [disabled]="busy() || !dirty()" (click)="revert()">
                {{ locale.t('admin.revert') }}
              </button>
            </div>
          }
        </fieldset>
      </form>
    }
  `,
  styleUrls: ['./admin-editor.scss'],
  styles: `
    fieldset {
      margin: 0;
      padding: 0;
      border: none;
      min-inline-size: 0;
    }
    .fields {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
      gap: var(--space-2);
      margin-block-end: var(--space-2);
    }
    .fields label {
      display: grid;
      gap: 2px;
      align-content: start;
      font-size: 0.75rem;
      color: var(--color-fg-muted);
    }
    .fields small {
      font-size: 0.75rem;
    }
    label.check {
      display: flex;
      gap: var(--space-1);
      align-items: center;
    }
    h3 label.check {
      font: inherit;
      color: inherit;
    }
    .problems {
      margin: 0 0 var(--space-2);
      padding-inline-start: var(--space-4);
    }
    .actions {
      margin-block-start: var(--space-3);
    }
  `,
})
export class ProfileEditor implements OnInit {
  /** `channel/<id>` or `platform/<id>` — both scopes may hold one id, so the scope is in the key. */
  readonly profileRef = input.required<string>();
  readonly tabId = input.required<string>();

  private readonly api = inject(ProfilesService);
  private readonly editors = inject(EditorStore);
  private readonly permissions = inject(PermissionService);
  protected readonly locale = inject(LocaleService);

  protected readonly kinds = KINDS;
  protected readonly containers = CONTAINERS;
  protected readonly videoCodecs = VIDEO_CODECS;
  protected readonly fits = FITS;
  protected readonly frameRates = FRAME_RATES;
  protected readonly scans = SCANS;
  protected readonly chromas = CHROMAS;
  protected readonly gpus = GPUS;
  protected readonly audioCodecs = AUDIO_CODECS;
  protected readonly sampleRates = SAMPLE_RATES;

  protected readonly profile = signal<Profile | null>(null);
  /** The form. Null until the profile loads. */
  private readonly draft = signal<ProfileDraft | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly problems = signal<Problems>(NO_PROBLEMS);
  protected readonly conflict = signal(false);
  protected readonly busy = signal(false);

  protected readonly scope = computed<ProfileScope>(() =>
    this.profileRef().startsWith('platform/') ? 'platform' : 'channel',
  );
  protected readonly id = computed(() =>
    this.profileRef().slice(this.profileRef().indexOf('/') + 1),
  );
  /** Only read once `profile` is set, which is when the template reads it. */
  protected readonly d = computed(() => this.draft()!);
  protected readonly still = computed(() => isStill(this.d()));

  /** UX only — MTS enforces `config:admin` in the profile's scope. */
  protected readonly readOnly = computed(() =>
    this.scope() === 'platform'
      ? !this.permissions.canPlatformWide('config:admin')
      : !this.permissions.can('config:admin'),
  );
  /** A channel administrator looking at a platform profile can make the channel's own. */
  protected readonly canRedefine = computed(
    () => this.scope() === 'platform' && this.permissions.can('config:admin'),
  );

  /** Compared as the body MTS would be sent, so a no-op edit is not dirty. */
  protected readonly dirty = computed(() => {
    const p = this.profile();
    const d = this.draft();
    if (!p || !d) return false;
    return JSON.stringify(toInput(p.id, d)) !== JSON.stringify(toInput(p.id, draftFrom(p)));
  });

  ngOnInit(): void {
    this.reload();
  }

  protected problemsFor(field: string): readonly string[] {
    return this.problems().fields[field] ?? [];
  }

  protected set<K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]): void {
    this.draft.update((d) => (d ? { ...d, [key]: value } : d));
    this.editors.setDirty(this.tabId(), this.dirty());
  }

  /** Read it again — after a 409, the only way forward that does not overwrite someone's work. */
  protected reload(): void {
    this.loadError.set(null);
    this.api.get(this.id(), this.scope()).subscribe({
      next: (profile) => this.adopt(profile),
      error: () => this.loadError.set(this.locale.t('admin.loadError')),
    });
  }

  protected revert(): void {
    const p = this.profile();
    if (p) this.adopt(p);
  }

  protected save(): void {
    const p = this.profile();
    const d = this.draft();
    if (!p || !d || !this.dirty() || this.busy() || this.readOnly()) return;
    this.busy.set(true);
    this.error.set(null);
    this.conflict.set(false);
    this.problems.set(NO_PROBLEMS);
    this.api.replace(p.id, { ...toInput(p.id, d), version: p.version }, this.scope()).subscribe({
      next: (saved) => {
        this.busy.set(false);
        this.adopt(saved);
      },
      error: (err: { status?: number; error?: { message?: string } }) => {
        this.busy.set(false);
        if (err.status === 409) this.conflict.set(true);
        else if (err.status === 422 && err.error?.message) {
          this.problems.set(splitProblems(err.error.message));
        } else this.error.set(err.error?.message ?? this.locale.t('admin.writeError'));
      },
    });
  }

  /**
   * Make this platform profile the channel's own, as it stands, and open that — the edits then
   * happen there. If the channel already redefines it (409), that is the one to open.
   */
  protected redefine(): void {
    const p = this.profile();
    if (!p || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    const input = toInput(p.id, draftFrom(p));
    this.api.create(input).subscribe({
      next: (created) => {
        this.busy.set(false);
        openProfile(this.editors, created, 'channel');
      },
      error: (err: { status?: number; error?: { message?: string } }) => {
        this.busy.set(false);
        if (err.status === 409) openProfile(this.editors, p, 'channel');
        else this.error.set(err.error?.message ?? this.locale.t('admin.writeError'));
      },
    });
  }

  private adopt(profile: Profile): void {
    this.profile.set(profile);
    this.draft.set(draftFrom(profile));
    this.problems.set(NO_PROBLEMS);
    this.conflict.set(false);
    this.editors.setDirty(this.tabId(), false);
  }
}

/**
 * Open one profile's tab. Here rather than in the list view, which is in the lazy Admin chunk:
 * the editor is eager (the editor area mounts every kind), so importing the view from it would
 * pull the whole view into the initial bundle.
 *
 * The scope is part of the tab's identity, since both scopes may hold an id.
 */
export function openProfile(
  editors: EditorStore,
  profile: Pick<Profile, 'id' | 'name'>,
  scope: ProfileScope,
): void {
  editors.open({
    type: 'profile',
    resourceId: `${scope}/${profile.id}`,
    title: profile.name || profile.id,
    icon: '⚙',
  });
}
