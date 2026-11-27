import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AssetsService } from '../core/assets.service.ts';
import { EditProjectsService } from '../core/edit-projects.service.ts';
import type { Asset, EditProject, FileRef } from '../core/generated/mam.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { PermissionService } from '../core/permission.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { WebSocketService } from '../core/websocket.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import { EditPlayer } from './edit-player.ts';
import {
  changed,
  DEFAULT_TRANSITION_SEC,
  filtersFor,
  lengthMs,
  moved,
  newRow,
  problemsOf,
  profilesFor,
  refsOf,
  rowsOf,
  timelineOf,
  toggled,
  transitionsFor,
  type ClipRow,
} from './edit-project.model.ts';
import { formatTimecode, parseTimecode } from './shotlist.model.ts';

/**
 * The media editor, as an editor tab (EP-26.3 / 26.8's editor half; media-editor.md §3–5.1): an
 * edit decision list over one source asset, trimmed and arranged as a table of clips, saved
 * compare-and-set, and rendered into an asset of its own.
 *
 * - A clip is a span of ONE file of the source (`original`, `broadcast`, `proxy`, a proxy variant),
 *   its in and out typed as timecodes; rows are reordered by ↑/↓.
 * - EP-26.4: a video project plays the source's editing proxy above the table ({@link EditPlayer}).
 *   Selecting a clip puts the playhead on its in; Set in / Set out write the frame shown into the
 *   selected clip. The proxy and every file of the source share one timeline, so a mark made on
 *   the proxy cuts the same frame from the original.
 * - Save is a compare-and-set on the version read: a 409 is a reload, never a retry; a 422 lands
 *   under the clip and field it names.
 * - Render asks MAM to flatten the SAVED timeline (so it is offered only when nothing is unsaved),
 *   optionally as the source's next version. While it runs, progress arrives live on
 *   `live.<channel>.transcode.progress` under the project's `outputAssetId`, and the project is
 *   polled for its outcome: `rendered` opens the new asset; `failed` shows MTS's reason.
 * - Editing is offered to a holder of `asset:write` on the source's `core` — UX only, MAM enforces.
 */
@Component({
  selector: 'atlas-edit-project-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EditPlayer],
  template: `
    @if (loadError()) {
      <p class="error" role="alert">{{ loadError() }}</p>
    } @else if (!project() || rows() === null) {
      <p class="muted">{{ locale.t('editor.loading') }}</p>
    } @else {
      <header class="head">
        <h2>
          {{ locale.t('editProject.title') }}
          <button type="button" class="link" (click)="openAsset(project()!.sourceAssetId)">
            {{ source()?.title ?? project()!.sourceAssetId }}
          </button>
        </h2>
        <span class="state" [attr.data-state]="project()!.state">
          {{ locale.t('editProject.state.' + project()!.state) }}
        </span>
        <span class="muted">v{{ project()!.version }}</span>
      </header>

      @if (project()!.state === 'rendering') {
        <div class="status" role="status">
          <span>{{ locale.t('editProject.rendering') }}</span>
          <progress max="100" [value]="percent()"></progress>
          <span class="muted">{{ percent() }}%</span>
        </div>
      } @else if (project()!.state === 'failed' && project()!.failure; as failure) {
        <p class="error" role="alert">
          {{ locale.t('editProject.failed') }} {{ failure.message }}
          <span class="muted">({{ failure.code }})</span>
        </p>
      } @else if (project()!.state === 'rendered' && project()!.outputAssetId; as made) {
        <p class="done" role="status">
          {{ locale.t('editProject.rendered') }}
          <button type="button" class="link" (click)="openAsset(made)">
            {{ locale.t('editProject.openRendered') }}
          </button>
        </p>
        @if (project()!.versionRefused; as why) {
          <p class="muted">{{ locale.t('editProject.versionRefused') }} {{ why }}</p>
        }
      }

      @if (conflict()) {
        <p class="error" role="alert">
          {{ locale.t('editProject.conflict') }}
          <button type="button" class="link" (click)="reload()">
            {{ locale.t('editProject.reload') }}
          </button>
        </p>
      }
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }

      @if (project()!.mediaKind === 'video') {
        <atlas-edit-player
          [assetId]="project()!.sourceAssetId"
          [files]="files()"
          [markable]="canEdit() && project()!.state !== 'rendering' && selected() !== null"
          (mark)="onMark($event)"
        />
      }

      <fieldset [disabled]="!canEdit() || busy() || project()!.state === 'rendering'">
        @if (rows()!.length === 0) {
          <p class="muted">{{ locale.t('editProject.empty') }}</p>
        } @else {
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>{{ locale.t('editProject.file') }}</th>
                <th>{{ locale.t('editProject.in') }}</th>
                <th>{{ locale.t('editProject.out') }}</th>
                <th>{{ locale.t('editProject.transition') }}</th>
                <th>{{ locale.t('editProject.filters') }}</th>
                <th>
                  <span class="sr-only">{{ locale.t('editProject.arrange') }}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              @for (row of rows(); track row.key; let i = $index, first = $first, last = $last) {
                <tr [attr.aria-selected]="selected() === i">
                  <td class="n">
                    <button
                      type="button"
                      class="link select"
                      [attr.aria-label]="locale.t('editProject.select')"
                      [attr.aria-pressed]="selected() === i"
                      (click)="select(i)"
                    >
                      {{ i + 1 }}
                    </button>
                  </td>
                  <td>
                    <select
                      [attr.aria-label]="locale.t('editProject.file')"
                      [value]="row.renditionRef"
                      (change)="edit(i, 'renditionRef', $any($event.target).value)"
                    >
                      @for (ref of refsFor(row); track ref) {
                        <option [value]="ref" [selected]="ref === row.renditionRef">
                          {{ ref }}
                        </option>
                      }
                    </select>
                    @if (problem(i, 'renditionRef'); as p) {
                      <p class="field-error">{{ p }}</p>
                    }
                  </td>
                  <td>
                    <input
                      class="tc"
                      [attr.aria-label]="locale.t('editProject.in')"
                      [value]="row.in"
                      [attr.aria-invalid]="problem(i, 'inSec') ? 'true' : null"
                      (input)="edit(i, 'in', $any($event.target).value)"
                    />
                    @if (problem(i, 'inSec'); as p) {
                      <p class="field-error">{{ p }}</p>
                    }
                  </td>
                  <td>
                    <input
                      class="tc"
                      [attr.aria-label]="locale.t('editProject.out')"
                      [value]="row.out"
                      [attr.aria-invalid]="problem(i, 'outSec') ? 'true' : null"
                      (input)="edit(i, 'out', $any($event.target).value)"
                    />
                    @if (problem(i, 'outSec'); as p) {
                      <p class="field-error">{{ p }}</p>
                    }
                  </td>
                  <td class="transition">
                    <!-- The first clip has nothing to transition from (media-editor.md §5.3). -->
                    <select
                      [attr.aria-label]="locale.t('editProject.transition')"
                      [disabled]="first && !row.transitionIn"
                      (change)="setTransition(i, $any($event.target).value)"
                    >
                      <option value="" [selected]="!row.transitionIn">
                        {{ locale.t('editProject.cut') }}
                      </option>
                      @for (t of transitions(); track t) {
                        <option [value]="t" [selected]="t === row.transitionIn">
                          {{ locale.t('editProject.transitions.' + t) }}
                        </option>
                      }
                    </select>
                    @if (row.transitionIn) {
                      <input
                        class="secs"
                        inputmode="decimal"
                        [attr.aria-label]="locale.t('editProject.transitionSec')"
                        [placeholder]="defaultSec"
                        [value]="row.transitionSec"
                        [attr.aria-invalid]="problem(i, 'transitionSec') ? 'true' : null"
                        (input)="setTransitionSec(i, $any($event.target).value)"
                      />
                      <span class="muted">s</span>
                    }
                    @if (problem(i, 'transitionIn'); as p) {
                      <p class="field-error">{{ p }}</p>
                    }
                    @if (problem(i, 'transitionSec'); as p) {
                      <p class="field-error">{{ p }}</p>
                    }
                  </td>
                  <td class="filters">
                    <details>
                      <summary>
                        {{
                          row.filters.length > 0 ? filterNames(row) : locale.t('editProject.none')
                        }}
                      </summary>
                      @for (f of filterChoices(); track f) {
                        <label>
                          <input
                            type="checkbox"
                            [checked]="row.filters.includes(f)"
                            (change)="toggleFilter(i, f)"
                          />
                          {{ locale.t('editProject.filterNames.' + f) }}
                        </label>
                      }
                    </details>
                    @if (problem(i, 'filters'); as p) {
                      <p class="field-error">{{ p }}</p>
                    }
                  </td>
                  <td class="arrange">
                    <button
                      type="button"
                      class="up"
                      [attr.aria-label]="locale.t('editProject.moveUp')"
                      [disabled]="first"
                      (click)="move(i, -1)"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      class="down"
                      [attr.aria-label]="locale.t('editProject.moveDown')"
                      [disabled]="last"
                      (click)="move(i, 1)"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      class="remove"
                      [attr.aria-label]="locale.t('editProject.remove')"
                      (click)="remove(i)"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        }
        <p class="muted total">
          {{ rows()!.length }} {{ locale.t('editProject.clips') }} · {{ total() }}
        </p>

        <div class="row">
          <button type="button" class="add" (click)="add()">
            {{ locale.t('editProject.add') }}
          </button>
        </div>

        <div class="render-options">
          <label>
            <span>{{ locale.t('editProject.profile') }}</span>
            <select
              class="profile"
              [value]="profile() ?? ''"
              (change)="setProfile($any($event.target).value)"
            >
              <option value="" [selected]="!profile()">—</option>
              @for (p of profiles(); track p) {
                <option [value]="p" [selected]="p === profile()">{{ p }}</option>
              }
            </select>
          </label>
          <label class="check">
            <input
              type="checkbox"
              class="as-version"
              [checked]="asVersion()"
              (change)="asVersion.set($any($event.target).checked)"
            />
            <span>{{ locale.t('editProject.asVersion') }}</span>
          </label>
        </div>

        @if (canEdit()) {
          <div class="row actions">
            <button type="button" class="save" [disabled]="!dirty()" (click)="save()">
              {{ locale.t('editProject.save') }}
            </button>
            <button type="button" class="render" [disabled]="!renderable()" (click)="render()">
              {{ locale.t('editProject.render') }}
            </button>
            @if (dirty()) {
              <span class="muted">{{ locale.t('editProject.saveFirst') }}</span>
            }
          </div>
        }
      </fieldset>
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
    .head {
      display: flex;
      align-items: baseline;
      gap: var(--space-2);
    }
    .state {
      font-size: 0.75rem;
      text-transform: uppercase;
    }
    [data-state='failed'] {
      color: var(--color-danger);
    }
    .status {
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th {
      text-align: start;
      font-size: 0.75rem;
      text-transform: uppercase;
      color: var(--color-fg-muted);
    }
    td {
      vertical-align: top;
      padding: 2px var(--space-1);
    }
    .n {
      color: var(--color-fg-muted);
    }
    tr[aria-selected='true'] {
      background: var(--color-accent-bg);
    }
    .tc {
      width: 8.5rem;
      font-family: ui-monospace, monospace;
    }
    .secs {
      width: 3.5rem;
      margin-inline-start: var(--space-1);
    }
    .filters details {
      font-size: 0.8125rem;
    }
    .filters label {
      display: block;
      white-space: nowrap;
    }
    .arrange {
      white-space: nowrap;
    }
    .row,
    .render-options {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      margin-block: var(--space-2);
    }
    .render-options label {
      display: flex;
      align-items: center;
      gap: var(--space-1);
    }
    .muted {
      color: var(--color-fg-muted);
    }
    .field-error,
    .error {
      margin: 0;
      color: var(--color-danger);
      font-size: 0.8125rem;
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
    }
  `,
})
export class EditProjectEditor {
  readonly projectId = input.required<string>();
  readonly tabId = input.required<string>();
  /** How often to ask for the outcome while a render runs. An input so a test can drive it. */
  readonly pollMs = input(3_000);

  private readonly api = inject(EditProjectsService);
  private readonly assets = inject(AssetsService);
  private readonly editors = inject(EditorStore);
  private readonly permissions = inject(PermissionService);
  private readonly session = inject(SessionStore);
  private readonly ws = inject(WebSocketService);
  protected readonly locale = inject(LocaleService);

  protected readonly project = signal<EditProject | null>(null);
  protected readonly source = signal<Asset | null>(null);
  protected readonly files = signal<FileRef[]>([]);
  protected readonly rows = signal<ClipRow[] | null>(null);
  protected readonly profile = signal<string | undefined>(undefined);
  /** Render as the source's next version (the version chain) — the editor's usual intent. */
  protected readonly asVersion = signal(true);
  private readonly problems = signal<Record<string, string>>({});
  protected readonly percent = signal(0);
  protected readonly busy = signal(false);
  protected readonly conflict = signal(false);
  protected readonly error = signal('');
  protected readonly loadError = signal('');
  /** The clip the player's marks write into (EP-26.4). */
  protected readonly selected = signal<number | null>(null);
  private readonly player = viewChild(EditPlayer);

  protected readonly refs = computed(() => refsOf(this.files()));
  /** EP-26.5: what this media can take — the Tier-0 sets, less what has no meaning for audio. */
  protected readonly transitions = computed(() =>
    transitionsFor(this.project()?.mediaKind ?? 'video'),
  );
  protected readonly filterChoices = computed(() =>
    filtersFor(this.project()?.mediaKind ?? 'video'),
  );
  protected readonly defaultSec = String(DEFAULT_TRANSITION_SEC);
  protected readonly profiles = computed(() =>
    profilesFor(this.project()?.mediaKind ?? 'video', this.project()?.outputProfile),
  );
  protected readonly total = computed(() => formatTimecode(lengthMs(this.rows() ?? [])));
  protected readonly dirty = computed(() => {
    const p = this.project();
    const rows = this.rows();
    return !!p && rows !== null && changed(rows, this.profile(), p);
  });
  /** UX only — MAM enforces `asset:write` on the source's `core`. */
  protected readonly canEdit = computed(() => {
    const asset = this.source();
    return (
      !!asset &&
      this.permissions.can('asset:write', {
        type: 'asset',
        channelId: asset.channelId,
        ownerId: asset.createdBy,
        state: asset.state,
        fieldGroup: 'core',
      })
    );
  });
  protected readonly renderable = computed(() => {
    const p = this.project();
    return (
      !!p &&
      !this.busy() &&
      !this.dirty() &&
      p.state !== 'rendering' &&
      p.mediaKind !== 'photo' &&
      p.timeline.clips.length > 0 &&
      !!this.profile()
    );
  });

  private timer: ReturnType<typeof setTimeout> | undefined;
  private destroyed = false;
  private nextKey = 0;

  constructor() {
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => {
      this.destroyed = true;
      clearTimeout(this.timer);
    });
    // The channel's progress stream — shared by every open view of the channel, so not
    // unsubscribed on destroy; a frame for another asset is ignored below.
    effect(() => {
      const channelId = this.session.channelId();
      if (channelId) void this.ws.subscribe(`live.${channelId}.transcode.progress`);
    });
    this.ws.events$
      .pipe(takeUntilDestroyed(destroyRef))
      .subscribe(({ subject, payload }) => this.onLive(subject, payload));
    effect(() => {
      const id = this.projectId();
      untracked(() => this.load(id));
    });
  }

  protected reload(): void {
    this.load(this.projectId());
  }

  protected refsFor(row: ClipRow): string[] {
    // A file the clip names that the source no longer lists is still shown, never silently swapped.
    const refs = this.refs();
    return refs.includes(row.renditionRef) ? refs : [row.renditionRef, ...refs];
  }

  protected problem(
    i: number,
    field: 'renditionRef' | 'inSec' | 'outSec' | 'transitionIn' | 'transitionSec' | 'filters',
  ): string | undefined {
    const p = this.problems()[`timeline/clips/${i}/${field}`];
    if (p === 'timecode') return this.locale.t('editProject.badTimecode');
    if (p === 'order') return this.locale.t('editProject.outBeforeIn');
    if (p === 'seconds') return this.locale.t('editProject.badSeconds');
    return p;
  }

  /** EP-26.5: a transition in from the clip before, or a cut (''). */
  protected setTransition(i: number, value: string): void {
    this.rows.update((rows) =>
      rows!.map((r, j) => {
        if (j !== i) return r;
        const { transitionIn: _t, ...rest } = r;
        return value === ''
          ? { ...rest, transitionSec: '' }
          : { ...rest, transitionIn: value as NonNullable<ClipRow['transitionIn']> };
      }),
    );
    this.markDirty();
  }

  protected setTransitionSec(i: number, value: string): void {
    this.rows.update((rows) => rows!.map((r, j) => (j === i ? { ...r, transitionSec: value } : r)));
    this.markDirty();
  }

  protected toggleFilter(i: number, filter: ClipRow['filters'][number]): void {
    this.rows.update((rows) =>
      rows!.map((r, j) => (j === i ? { ...r, filters: toggled(r.filters, filter) } : r)),
    );
    this.markDirty();
  }

  protected filterNames(row: ClipRow): string {
    return row.filters.map((f) => this.locale.t('editProject.filterNames.' + f)).join(', ');
  }

  /** EP-26.4: the clip marks go to — and the playhead to its in. */
  protected select(i: number): void {
    this.selected.set(i);
    const inMs = parseTimecode(this.rows()?.[i]?.in ?? '');
    if (inMs !== undefined) this.player()?.seek(inMs / 1000);
  }

  /** A mark from the player: the frame shown, as the selected clip's in or out. */
  protected onMark({ which, sec }: { which: 'in' | 'out'; sec: number }): void {
    const i = this.selected();
    if (i === null || !this.rows()?.[i]) return;
    this.edit(i, which, formatTimecode(Math.round(sec * 1000)));
  }

  protected edit(i: number, field: 'renditionRef' | 'in' | 'out', value: string): void {
    this.rows.update((rows) => rows!.map((r, j) => (j === i ? { ...r, [field]: value } : r)));
    this.markDirty();
  }

  protected add(): void {
    this.rows.update((rows) => [
      ...(rows ?? []),
      newRow(rows ?? [], this.refs(), `new-${this.nextKey++}`),
    ]);
    // A new clip is where the next marks go.
    this.selected.set(this.rows()!.length - 1);
    this.markDirty();
  }

  protected move(i: number, by: -1 | 1): void {
    const n = this.rows()?.length ?? 0;
    this.rows.update((rows) => moved(rows ?? [], i, by));
    // The selection follows the clip it was on.
    const j = i + by;
    const s = this.selected();
    if (j >= 0 && j < n) this.selected.set(s === i ? j : s === j ? i : s);
    this.problems.set({});
    this.markDirty();
  }

  protected remove(i: number): void {
    this.rows.update((rows) => rows!.filter((_, j) => j !== i));
    const s = this.selected();
    if (s !== null) this.selected.set(s === i ? null : s > i ? s - 1 : s);
    this.problems.set({});
    this.markDirty();
  }

  protected setProfile(value: string): void {
    this.profile.set(value === '' ? undefined : value);
    this.markDirty();
  }

  protected save(): void {
    const p = this.project();
    const rows = this.rows();
    if (!p || !rows || this.busy()) return;
    const body = timelineOf(rows);
    if ('problems' in body) {
      this.problems.set(body.problems);
      return;
    }
    const profile = this.profile();
    this.begin();
    this.api
      .save(p.id, p.version, {
        timeline: body.timeline,
        ...(profile !== undefined ? { outputProfile: profile } : {}),
      })
      .subscribe({
        next: (saved) => {
          this.busy.set(false);
          this.adopt(saved);
        },
        error: (err: unknown) => this.fail(err),
      });
  }

  protected render(): void {
    const p = this.project();
    if (!p || !this.renderable()) return;
    const profile = this.profile();
    this.begin();
    this.percent.set(0);
    this.api
      .render(p.id, {
        ...(profile !== undefined ? { outputProfile: profile } : {}),
        ...(this.asVersion() ? { targetAssetId: p.sourceAssetId } : {}),
      })
      .subscribe({
        next: (rendering) => {
          this.busy.set(false);
          this.adopt(rendering);
        },
        error: (err: unknown) => this.fail(err),
      });
  }

  protected openAsset(id: string): void {
    this.editors.open({ type: 'asset', resourceId: id, title: id, icon: '▤' });
  }

  private load(id: string): void {
    clearTimeout(this.timer);
    this.conflict.set(false);
    this.error.set('');
    this.api.get(id).subscribe({
      next: (project) => {
        if (this.destroyed || id !== this.projectId()) return;
        this.adopt(project);
        this.assets.get(project.sourceAssetId).subscribe({
          next: (asset) => this.source.set(asset),
          error: () => this.source.set(null),
        });
        this.assets.files(project.sourceAssetId).subscribe({
          next: (files) => this.files.set(files),
          error: () => this.files.set([]),
        });
      },
      error: () => this.loadError.set(this.locale.t('editProject.loadError')),
    });
  }

  /** Take what MAM holds as the form's base — and, while it renders, keep asking for the outcome. */
  private adopt(project: EditProject): void {
    const wasRendering = this.project()?.state === 'rendering';
    this.project.set(project);
    this.rows.set(rowsOf(project, () => `c-${this.nextKey++}`));
    const count = project.timeline.clips.length;
    const s = this.selected();
    this.selected.set(count === 0 ? null : s === null || s >= count ? 0 : s);
    this.profile.set(project.outputProfile);
    if (project.targetAssetId !== undefined) this.asVersion.set(true);
    this.problems.set({});
    this.editors.setDirty(this.tabId(), false);
    if (project.state === 'rendering') this.schedule();
    else if (wasRendering) {
      clearTimeout(this.timer);
      if (project.state === 'rendered') this.percent.set(100);
    }
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.destroyed) return;
      const id = this.projectId();
      this.api.get(id).subscribe({
        next: (project) => {
          if (this.destroyed || id !== this.projectId()) return;
          // Only the outcome moves the form: the rows of a rendering project cannot have changed.
          if (project.state === 'rendering' && project.version === this.project()?.version) {
            this.schedule();
          } else {
            this.adopt(project);
          }
        },
        // A blip while rendering: keep asking.
        error: () => this.schedule(),
      });
    }, this.pollMs());
  }

  /** A progress frame for the asset the render becomes — forward only, as the jobs view does. */
  private onLive(subject: string, payload: unknown): void {
    if (!subject.startsWith('live.') || !subject.endsWith('.transcode.progress')) return;
    const p = this.project();
    if (!p || p.state !== 'rendering' || !p.outputAssetId) return;
    const progress = (payload as { payload?: { assetId?: string; percent?: number } })?.payload;
    if (progress?.assetId !== p.outputAssetId) return;
    const percent = Math.round(progress.percent ?? 0);
    if (percent > this.percent()) this.percent.set(percent);
  }

  private markDirty(): void {
    this.editors.setDirty(this.tabId(), this.dirty());
  }

  private begin(): void {
    this.busy.set(true);
    this.error.set('');
    this.conflict.set(false);
    this.problems.set({});
  }

  private fail(err: unknown): void {
    this.busy.set(false);
    if (err instanceof HttpErrorResponse && err.status === 409) {
      // A save's 409 is someone else's save; a render's is its target replaced since — MAM says which.
      this.conflict.set(true);
      if (typeof err.error?.message === 'string') this.error.set(err.error.message);
    } else if (err instanceof HttpErrorResponse && err.status === 422) {
      this.problems.set(problemsOf(err.error?.details));
      this.error.set(err.error?.message ?? this.locale.t('editProject.refused'));
    } else {
      this.error.set(this.locale.t('editProject.writeError'));
    }
  }
}
