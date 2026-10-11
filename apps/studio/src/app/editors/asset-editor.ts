import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  type OnInit,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AssetsService } from '../core/assets.service.ts';
import type {
  Asset,
  AssetInheritance,
  Category,
  FileRef,
  CastEntry,
  Person,
  UpdateAssetInput,
  VocabularyTerm,
} from '../core/generated/mam.types.ts';
import { PeopleService } from '../core/people.service.ts';
import { CategoriesService } from '../core/categories.service.ts';
import {
  TERM_FIELD_VOCABULARY,
  termLabel,
  VocabulariesService,
  type TermField,
} from '../core/vocabularies.service.ts';
import { pickerOptions } from '../core/category-tree.ts';
import type { Job } from '../core/generated/mts.types.ts';
import { PermissionService } from '../core/permission.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import { LocaleService } from '../core/locale.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { WebSocketService } from '../core/websocket.service.ts';
import { TranscodeJobs } from './transcode-jobs.ts';

type EditorSection = 'basic' | 'files';

/** After a transcode completes: how often, and how many times, to look for its rows in MAM. */
const RENDITION_WAIT_MS = 1_000;
const RENDITION_WAIT_ATTEMPTS = 15;
/** The term-id LISTS (EP-28.4): edited as sets of checkboxes, not as text. */
type ListField = 'subjectIds' | 'classificationIds';
const LIST_FIELDS: readonly ListField[] = ['subjectIds', 'classificationIds'];
/** Every field that holds terms, and the vocabulary each draws from. */
const TERM_VOCABULARY = {
  ...TERM_FIELD_VOCABULARY,
  subjectIds: 'subject',
  classificationIds: 'classification',
  cast: 'cast-role',
} as const;
type TermHolder = keyof typeof TERM_VOCABULARY;
type EditableField = Exclude<keyof UpdateAssetInput, 'inherit' | ListField | 'cast'>;
/** The fields a category can supply when the asset sets none (EP-28.2, data-model §2.2). */
type MediaDefault = 'structureId' | 'genre' | 'supplyType' | 'productionGroup' | 'productionDate';
type FieldGroup = 'core' | 'taxonomy' | 'rights' | 'cast';
type Draft = Record<EditableField, string>;

const FIELD_GROUP: Readonly<Record<EditableField, FieldGroup>> = {
  title: 'core',
  description: 'core',
  episodeNo: 'core',
  durationSec: 'core',
  categoryId: 'taxonomy',
  structureId: 'taxonomy',
  genre: 'taxonomy',
  supplyType: 'core',
  productionGroup: 'core',
  productionDate: 'core',
  allowedBroadcastCount: 'rights',
  expiresAt: 'rights',
};

/**
 * The MVP asset editor (EP-20.2).
 *
 * The component deliberately asks the shared policy evaluator about EACH field group. This is UX,
 * not enforcement: MAM repeats the check with `canEnforce()` and the complete resource context.
 * A stale browser policy can therefore expose a control, but it cannot make an unauthorized write.
 */
@Component({
  selector: 'atlas-asset-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranscodeJobs],
  template: `
    @if (loading()) {
      <div class="state">
        <p>{{ locale.t('assetEditor.loading') }}</p>
      </div>
    } @else if (loadError()) {
      <div class="state" role="alert">
        <p>{{ loadError() }}</p>
        <button type="button" (click)="reload({ fresh: true })">
          {{ locale.t('common.retry') }}
        </button>
      </div>
    } @else if (asset(); as current) {
      <header class="editor-header">
        <div>
          <p class="eyebrow">{{ current.mediaType }} · {{ current.state }}</p>
          <h2>{{ current.title }}</h2>
        </div>
        <span class="version">v{{ current.version }}</span>
      </header>

      <nav class="sections" aria-label="Asset sections" role="tablist">
        <button
          type="button"
          role="tab"
          [attr.aria-selected]="section() === 'basic'"
          [class.active]="section() === 'basic'"
          (click)="section.set('basic')"
        >
          {{ locale.t('assetEditor.basicInfo') }}
        </button>
        <button
          type="button"
          role="tab"
          [attr.aria-selected]="section() === 'files'"
          [class.active]="section() === 'files'"
          (click)="section.set('files')"
        >
          {{ locale.t('assetEditor.files') }}
        </button>
      </nav>

      @if (section() === 'basic' && draft(); as form) {
        <form class="basic" (submit)="save($event)">
          <section class="field-group">
            <div class="group-heading">
              <h3>{{ locale.t('assetEditor.identity') }}</h3>
              <span>{{
                canEdit('core')
                  ? locale.t('assetEditor.editable')
                  : locale.t('assetEditor.readOnly')
              }}</span>
            </div>
            <div class="grid">
              <label class="wide">
                {{ locale.t('assetEditor.title') }}
                <input
                  name="title"
                  required
                  [disabled]="!canEdit('core')"
                  [value]="form.title"
                  (input)="change('title', $any($event.target).value)"
                />
              </label>
              <label>
                {{ locale.t('assetEditor.mediaType') }}
                <input [value]="current.mediaType" disabled />
              </label>
              <label>
                {{ locale.t('assetEditor.state') }}
                <input [value]="current.state" disabled />
              </label>
              <label class="wide">
                {{ locale.t('assetEditor.description') }}
                <textarea
                  name="description"
                  rows="4"
                  [disabled]="!canEdit('core')"
                  [value]="form.description"
                  (input)="change('description', $any($event.target).value)"
                ></textarea>
              </label>
              <label>
                {{ locale.t('assetEditor.episodeNumber') }}
                <input
                  name="episodeNo"
                  type="number"
                  min="0"
                  step="1"
                  [disabled]="!canEdit('core')"
                  [value]="form.episodeNo"
                  (input)="change('episodeNo', $any($event.target).value)"
                />
              </label>
              <label>
                {{ locale.t('assetEditor.duration') }}
                <input
                  name="durationSec"
                  type="number"
                  min="0"
                  step="any"
                  [disabled]="!canEdit('core')"
                  [value]="form.durationSec"
                  (input)="change('durationSec', $any($event.target).value)"
                />
              </label>
            </div>
          </section>

          <section class="field-group">
            <div class="group-heading">
              <h3>{{ locale.t('assetEditor.classification') }}</h3>
              <span>{{
                canEdit('taxonomy')
                  ? locale.t('assetEditor.editable')
                  : locale.t('assetEditor.readOnly')
              }}</span>
            </div>
            <div class="grid">
              <label>
                {{ locale.t('assetEditor.categoryId') }}
                <!-- The live tree (#260): a node media cannot go in directly is shown, for its
                     place in the tree, but cannot be chosen. A category the asset has that is no
                     longer offered (deprecated, or never existed) is kept visible as itself. -->
                <select
                  name="categoryId"
                  [disabled]="!canEdit('taxonomy')"
                  [value]="form.categoryId"
                  (change)="change('categoryId', $any($event.target).value)"
                >
                  <option value="" disabled>{{ locale.t('assetEditor.chooseCategory') }}</option>
                  @if (form.categoryId && !categoryKnown(form.categoryId)) {
                    <option [value]="form.categoryId">
                      {{ locale.t('assetEditor.unknownCategory') }} {{ form.categoryId }}
                    </option>
                  }
                  @for (option of categoryOptions(); track option.id) {
                    <option
                      [value]="option.id"
                      [disabled]="!option.choosable"
                      [selected]="option.id === form.categoryId"
                      [title]="option.path"
                    >
                      {{ option.label }}
                    </option>
                  }
                </select>
              </label>
              <label>
                {{ locale.t('assetEditor.structureId') }}
                <!-- EP-28.3: a term of the structureId vocabulary. Empty inherits the category's. -->
                <select
                  name="structureId"
                  [disabled]="!canEdit('taxonomy')"
                  (change)="change('structureId', $any($event.target).value)"
                >
                  <option value="" [selected]="form.structureId === ''">
                    {{ inheritOption('structureId') }}
                  </option>
                  @if (form.structureId && !isLive('structureId', form.structureId)) {
                    <option [value]="form.structureId" selected>
                      {{ termName('structureId', form.structureId) }}
                    </option>
                  }
                  @for (t of liveTerms('structureId'); track t.id) {
                    <option [value]="t.id" [selected]="t.id === form.structureId">
                      {{ termName('structureId', t.id) }}
                    </option>
                  }
                </select>
                @if (inheritedOf('structureId'); as hit) {
                  <small class="inherited">
                    {{ locale.t('assetEditor.inheritedFrom') }} {{ hit.from.path }}
                  </small>
                } @else if (ownsField('structureId') && canEdit('taxonomy')) {
                  <button
                    type="button"
                    class="inherit"
                    [disabled]="dirtyCount() > 0 || saving()"
                    (click)="resetToInherited('structureId')"
                  >
                    {{ locale.t('assetEditor.useInherited') }}
                  </button>
                }
              </label>
              <label>
                {{ locale.t('assetEditor.genre') }}
                <!-- EP-28.3: a term of the genre vocabulary. Empty inherits the category's. -->
                <select
                  name="genre"
                  [disabled]="!canEdit('taxonomy')"
                  (change)="change('genre', $any($event.target).value)"
                >
                  <option value="" [selected]="form.genre === ''">
                    {{ inheritOption('genre') }}
                  </option>
                  @if (form.genre && !isLive('genre', form.genre)) {
                    <option [value]="form.genre" selected>
                      {{ termName('genre', form.genre) }}
                    </option>
                  }
                  @for (t of liveTerms('genre'); track t.id) {
                    <option [value]="t.id" [selected]="t.id === form.genre">
                      {{ termName('genre', t.id) }}
                    </option>
                  }
                </select>
                @if (inheritedOf('genre'); as hit) {
                  <small class="inherited">
                    {{ locale.t('assetEditor.inheritedFrom') }} {{ hit.from.path }}
                  </small>
                } @else if (ownsField('genre') && canEdit('taxonomy')) {
                  <button
                    type="button"
                    class="inherit"
                    [disabled]="dirtyCount() > 0 || saving()"
                    (click)="resetToInherited('genre')"
                  >
                    {{ locale.t('assetEditor.useInherited') }}
                  </button>
                }
              </label>
            </div>
          </section>

          <section class="field-group">
            <div class="group-heading">
              <h3>{{ locale.t('assetEditor.aboutness') }}</h3>
              <span>{{
                canEdit('taxonomy')
                  ? locale.t('assetEditor.editable')
                  : locale.t('assetEditor.readOnly')
              }}</span>
            </div>
            <!-- EP-28.4: an unset list inherits the category's; a set one — even empty — replaces it. -->
            @for (field of listFields; track field) {
              <fieldset class="terms" [disabled]="!canEdit('taxonomy')">
                <legend>{{ locale.t('assetEditor.' + field) }}</legend>
                @if (lists()[field] === null) {
                  @if (inheritedList(field); as hit) {
                    <small class="inherited">
                      {{ locale.t('assetEditor.inheritedFrom') }} {{ hit.from.path }}
                    </small>
                  }
                } @else if (canEdit('taxonomy')) {
                  <button type="button" class="inherit" (click)="inheritList(field)">
                    {{ locale.t('assetEditor.useInherited') }}
                  </button>
                }
                @for (t of listTerms(field); track t.id) {
                  <label>
                    <input
                      type="checkbox"
                      [checked]="checkedTerm(field, t.id)"
                      (change)="toggleTerm(field, t.id, $any($event.target).checked)"
                    />
                    {{ termName(field, t.id) }}
                  </label>
                }
              </fieldset>
            }
            @if (inheritance()?.defaults?.tags; as tags) {
              <small class="inherited">
                {{ locale.t('assetEditor.inheritedTags') }} {{ tags.value.join(', ') }} ({{
                  tags.from.path
                }})
              </small>
            }
          </section>

          <section class="field-group">
            <div class="group-heading">
              <h3>{{ locale.t('assetEditor.cast') }}</h3>
              <span>{{
                canEdit('cast')
                  ? locale.t('assetEditor.editable')
                  : locale.t('assetEditor.readOnly')
              }}</span>
            </div>
            <!-- EP-28.5: inherited PER ROLE — a role named here replaces the category's people for it. -->
            <ul class="cast">
              @for (e of cast() ?? []; track $index) {
                <li>
                  <span>{{ termName('cast', e.roleId) }} · {{ personName(e.personId) }}</span>
                  @if (canEdit('cast')) {
                    <button type="button" class="inherit" (click)="removeCast($index)">✕</button>
                  }
                </li>
              }
              @for (e of inheritedCastEntries(); track $index) {
                <li class="inherited">
                  {{ termName('cast', e.roleId) }} · {{ personName(e.personId) }} ({{
                    e.from.path
                  }})
                </li>
              }
            </ul>
            @if (canEdit('cast')) {
              <div class="cast-add">
                <select name="castRole" #role>
                  @for (t of liveTerms('cast'); track t.id) {
                    <option [value]="t.id">{{ termName('cast', t.id) }}</option>
                  }
                </select>
                <select name="castPerson" #person>
                  @for (p of livePeople(); track p.id) {
                    <option [value]="p.id">{{ p.name }}</option>
                  }
                </select>
                <button type="button" class="inherit" (click)="addCast(role.value, person.value)">
                  {{ locale.t('assetEditor.addCast') }}
                </button>
                @if (cast() !== null) {
                  <button type="button" class="inherit" (click)="setCast(null)">
                    {{ locale.t('assetEditor.useInherited') }}
                  </button>
                }
              </div>
            }
          </section>

          <section class="field-group">
            <div class="group-heading">
              <h3>{{ locale.t('assetEditor.production') }}</h3>
              <span>{{
                canEdit('core')
                  ? locale.t('assetEditor.editable')
                  : locale.t('assetEditor.readOnly')
              }}</span>
            </div>
            <div class="grid">
              <label>
                {{ locale.t('assetEditor.supplyType') }}
                <!-- EP-28.3: a term of the supplyType vocabulary. Empty inherits the category's. -->
                <select
                  name="supplyType"
                  [disabled]="!canEdit('core')"
                  (change)="change('supplyType', $any($event.target).value)"
                >
                  <option value="" [selected]="form.supplyType === ''">
                    {{ inheritOption('supplyType') }}
                  </option>
                  @if (form.supplyType && !isLive('supplyType', form.supplyType)) {
                    <option [value]="form.supplyType" selected>
                      {{ termName('supplyType', form.supplyType) }}
                    </option>
                  }
                  @for (t of liveTerms('supplyType'); track t.id) {
                    <option [value]="t.id" [selected]="t.id === form.supplyType">
                      {{ termName('supplyType', t.id) }}
                    </option>
                  }
                </select>
                @if (inheritedOf('supplyType'); as hit) {
                  <small class="inherited">
                    {{ locale.t('assetEditor.inheritedFrom') }} {{ hit.from.path }}
                  </small>
                } @else if (ownsField('supplyType') && canEdit('core')) {
                  <button
                    type="button"
                    class="inherit"
                    [disabled]="dirtyCount() > 0 || saving()"
                    (click)="resetToInherited('supplyType')"
                  >
                    {{ locale.t('assetEditor.useInherited') }}
                  </button>
                }
              </label>
              <label>
                {{ locale.t('assetEditor.productionGroup') }}
                <!-- EP-28.3: a term of the productionGroup vocabulary. Empty inherits the category's. -->
                <select
                  name="productionGroup"
                  [disabled]="!canEdit('core')"
                  (change)="change('productionGroup', $any($event.target).value)"
                >
                  <option value="" [selected]="form.productionGroup === ''">
                    {{ inheritOption('productionGroup') }}
                  </option>
                  @if (form.productionGroup && !isLive('productionGroup', form.productionGroup)) {
                    <option [value]="form.productionGroup" selected>
                      {{ termName('productionGroup', form.productionGroup) }}
                    </option>
                  }
                  @for (t of liveTerms('productionGroup'); track t.id) {
                    <option [value]="t.id" [selected]="t.id === form.productionGroup">
                      {{ termName('productionGroup', t.id) }}
                    </option>
                  }
                </select>
                @if (inheritedOf('productionGroup'); as hit) {
                  <small class="inherited">
                    {{ locale.t('assetEditor.inheritedFrom') }} {{ hit.from.path }}
                  </small>
                } @else if (ownsField('productionGroup') && canEdit('core')) {
                  <button
                    type="button"
                    class="inherit"
                    [disabled]="dirtyCount() > 0 || saving()"
                    (click)="resetToInherited('productionGroup')"
                  >
                    {{ locale.t('assetEditor.useInherited') }}
                  </button>
                }
              </label>
              <label>
                {{ locale.t('assetEditor.productionDate') }}
                <input
                  name="productionDate"
                  type="date"
                  [disabled]="!canEdit('core')"
                  [value]="form.productionDate"
                  [placeholder]="inheritedOf('productionDate')?.value ?? ''"
                  (input)="change('productionDate', $any($event.target).value)"
                />
                @if (inheritedOf('productionDate'); as hit) {
                  <small class="inherited">
                    {{ locale.t('assetEditor.inheritedFrom') }} {{ hit.from.path }}
                  </small>
                } @else if (ownsField('productionDate') && canEdit('core')) {
                  <button
                    type="button"
                    class="inherit"
                    [disabled]="dirtyCount() > 0 || saving()"
                    (click)="resetToInherited('productionDate')"
                  >
                    {{ locale.t('assetEditor.useInherited') }}
                  </button>
                }
              </label>
            </div>
          </section>

          <section class="field-group">
            <div class="group-heading">
              <h3>{{ locale.t('assetEditor.rights') }}</h3>
              <span>{{
                canEdit('rights')
                  ? locale.t('assetEditor.editable')
                  : locale.t('assetEditor.readOnly')
              }}</span>
            </div>
            <div class="grid">
              <label>
                {{ locale.t('assetEditor.allowedBroadcasts') }}
                <input
                  name="allowedBroadcastCount"
                  type="number"
                  min="0"
                  step="1"
                  [disabled]="!canEdit('rights')"
                  [value]="form.allowedBroadcastCount"
                  (input)="change('allowedBroadcastCount', $any($event.target).value)"
                />
              </label>
              <label>
                {{ locale.t('assetEditor.expiresAt') }}
                <input
                  name="expiresAt"
                  [disabled]="!canEdit('rights')"
                  [value]="form.expiresAt"
                  (input)="change('expiresAt', $any($event.target).value)"
                />
              </label>
              @if (policies(); as p) {
                <div class="readonly-value">
                  <span>{{ locale.t('assetEditor.categoryPolicies') }}</span>
                  <strong>
                    @if (p.reviewNeeded; as r) {
                      {{
                        r.value
                          ? locale.t('assetEditor.reviewNeeded')
                          : locale.t('assetEditor.reviewNotNeeded')
                      }}
                      ·
                    }
                    @if (p.defaultExpiry; as e) {
                      {{ locale.t('assetEditor.defaultExpiry') }} {{ e.value }} ·
                    }
                    @if (p.keepDuration; as k) {
                      {{ locale.t('assetEditor.keepOnline') }} {{ k.value }}
                    }
                  </strong>
                </div>
              }
              <div class="readonly-value">
                <span>{{ locale.t('assetEditor.recommendedWindow') }}</span>
                <strong>
                  {{ current.recommendedBroadcastStart || locale.t('assetEditor.notSet') }}
                  —
                  {{ current.recommendedBroadcastEnd || locale.t('assetEditor.notSet') }}
                </strong>
              </div>
            </div>
          </section>

          <section class="record-meta" aria-label="Record details">
            <span>{{ locale.t('assetEditor.createdBy') }} {{ current.createdBy }}</span>
            <span>{{ locale.t('assetEditor.createdAt') }} {{ current.createdAt }}</span>
            <span>{{ locale.t('assetEditor.updatedAt') }} {{ current.updatedAt }}</span>
          </section>

          @if (saveError()) {
            <p class="message error" role="alert">{{ saveError() }}</p>
          } @else if (saved()) {
            <p class="message" role="status">{{ locale.t('assetEditor.saved') }}</p>
          }

          @if (mayEditAnything()) {
            <div class="actions">
              <button type="submit" [disabled]="saving() || dirtyCount() === 0">
                {{
                  saving() ? locale.t('assetEditor.saving') : locale.t('assetEditor.saveChanges')
                }}
              </button>
              <span>{{ dirtyCount() }} {{ locale.t('assetEditor.changedFields') }}</span>
            </div>
          }
        </form>
      } @else if (section() === 'files') {
        <section class="files">
          <div class="file-summary">
            <span class="file-icon" aria-hidden="true">▤</span>
            <div>
              <h3>{{ current.fileType }}</h3>
              <p>
                {{
                  current.hasRenditions
                    ? locale.t('assetEditor.renditionsAttached')
                    : locale.t('assetEditor.awaitingRenditions')
                }}
              </p>
            </div>
          </div>
          <dl>
            <div>
              <dt>{{ locale.t('assetEditor.sourceContainer') }}</dt>
              <dd>{{ current.fileType }}</dd>
            </div>
            <div>
              <dt>{{ locale.t('assetEditor.renditionSet') }}</dt>
              <dd>
                {{
                  current.hasRenditions
                    ? locale.t('assetEditor.renditionsAttached')
                    : locale.t('assetEditor.awaitingRenditions')
                }}
              </dd>
            </div>
          </dl>
          <!-- The FileRef mirror (EP-17.8; the per-file rows EP-20.2 waited for): what HSM and
               MTS last announced about each file. Read on entering the tab, and again on a live
               event for this asset, since a placement or a transcode changes rows, not the asset.
               HSM remains the source of truth; sourceMessageId names the ledger entry. -->
          @if (filesError()) {
            <p class="error" role="alert">{{ filesError() }}</p>
          } @else if (files() === null) {
            <p class="files-note">{{ locale.t('assetEditor.filesLoading') }}</p>
          } @else if (files()!.length === 0) {
            <p class="files-note">{{ locale.t('assetEditor.noFiles') }}</p>
          } @else {
            <table class="file-rows">
              <thead>
                <tr>
                  <th>{{ locale.t('assetEditor.fileKind') }}</th>
                  <th>{{ locale.t('assetEditor.fileTier') }}</th>
                  <th>{{ locale.t('assetEditor.fileStatus') }}</th>
                  <th>{{ locale.t('assetEditor.fileSize') }}</th>
                  <th>{{ locale.t('assetEditor.fileChecksum') }}</th>
                  <th>{{ locale.t('assetEditor.filePath') }}</th>
                </tr>
              </thead>
              <tbody>
                @for (file of files(); track file.id) {
                  <tr [attr.data-status]="file.storage.status">
                    <td>
                      {{ file.kind }}
                      @if (file.variant) {
                        <span class="muted">· {{ file.variant }}</span>
                      }
                    </td>
                    <td>{{ file.storage.tier }}</td>
                    <td>{{ locale.t('assetEditor.fileStatuses.' + file.storage.status) }}</td>
                    <td>{{ formatSize(file.sizeBytes) }}</td>
                    <td class="mono" [title]="file.checksum.algorithm + ' ' + file.checksum.value">
                      {{ file.checksum.algorithm }} {{ file.checksum.value.slice(0, 12) }}…
                    </td>
                    <td class="mono path" [title]="file.storage.path">{{ file.storage.path }}</td>
                  </tr>
                }
              </tbody>
            </table>
          }
          <!-- EP-16: what MTS is doing to produce these rows. -->
          <atlas-transcode-jobs [assetId]="current.id" (completed)="renditionsProduced($event)" />
          <p class="files-note">
            {{ locale.t('assetEditor.filesNote') }}
          </p>
        </section>
      }
    }
  `,
  styleUrl: './asset-editor.scss',
})
export class AssetEditor implements OnInit {
  readonly assetId = input.required<string>();
  readonly tabId = input.required<string>();

  private readonly assetsApi = inject(AssetsService);
  private readonly categoriesApi = inject(CategoriesService);
  /** The live category tree as choices (#260); empty without taxonomy:read — the field stays. */
  private readonly categories = signal<Category[]>([]);
  protected readonly categoryOptions = computed(() =>
    pickerOptions(this.categories(), this.locale.locale()),
  );
  private readonly permissions = inject(PermissionService);
  private readonly editors = inject(EditorStore);
  protected readonly locale = inject(LocaleService);
  private readonly session = inject(SessionStore);
  private readonly ws = inject(WebSocketService);

  protected readonly asset = signal<Asset | null>(null);
  /** What the category chain supplies (EP-28.2) — live, re-read on any taxonomy change. */
  protected readonly inheritance = signal<AssetInheritance | null>(null);
  /** The category policies that reach this asset, when any do. */
  protected readonly policies = computed(() => {
    const p = this.inheritance()?.policies;
    return p && (p.reviewNeeded || p.keepDuration || p.defaultExpiry) ? p : null;
  });
  protected readonly draft = signal<Draft | null>(null);
  protected readonly section = signal<EditorSection>('basic');
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly loadError = signal<string | null>(null);
  protected readonly saveError = signal<string | null>(null);
  protected readonly saved = signal(false);
  protected readonly dirtyFields = signal<ReadonlySet<EditableField>>(new Set());
  /** The term lists as edited: `null` inherits (the asset sets none), a list replaces. */
  protected readonly lists = signal<Record<ListField, string[] | null>>({
    subjectIds: null,
    classificationIds: null,
  });
  protected readonly dirtyLists = signal<ReadonlySet<ListField>>(new Set());
  protected readonly listFields = LIST_FIELDS;
  /** The asset's own cast as edited: `null` inherits every role (EP-28.5). */
  protected readonly cast = signal<CastEntry[] | null>(null);
  protected readonly castDirty = signal(false);
  protected readonly people = signal<Person[]>([]);
  protected readonly dirtyCount = computed(
    () => this.dirtyFields().size + this.dirtyLists().size + (this.castDirty() ? 1 : 0),
  );
  protected readonly mayEditAnything = computed(() =>
    (['core', 'taxonomy', 'rights', 'cast'] as const).some((group) => this.canEdit(group)),
  );

  private readonly destroyRef = inject(DestroyRef);

  // Live updates for this channel's assets. MAM publishes to atlas.<channel>.asset.<action> —
  // there is no per-asset subject — so the subscription is the channel stream and the payload's
  // assetId does the filtering. The service queues the pattern until the socket is open.
  private readonly wsSubscription = effect(() => {
    const channelId = this.session.channelId();
    if (channelId) {
      void this.ws.subscribe(`atlas.${channelId}.asset.>`);
      // A category edit changes what this asset inherits without touching the asset (EP-28.2).
      void this.ws.subscribe(`atlas.${channelId}.taxonomy.>`);
    }
  });

  // takeUntilDestroyed: closing a tab destroys this component, and a leaked subscription would
  // keep refetching assets for an editor that no longer exists.
  private readonly wsEvents = this.ws.events$
    .pipe(takeUntilDestroyed(this.destroyRef))
    .subscribe(({ subject, payload }) => {
      this.handleAssetEvent(subject, payload);
    });

  // A reconnect after a gap, or the polling cadence while the socket is down (EP-09.4): the
  // record may have changed unseen. The same rule as a live event — never over unsaved edits.
  private readonly wsResync = this.ws.resync$
    .pipe(takeUntilDestroyed(this.destroyRef))
    .subscribe(() => {
      if (this.dirtyCount() === 0) this.reload({ fresh: true });
    });

  /** The Files tab's rows: null until read, then what MAM mirrors (EP-17.8). */
  protected readonly files = signal<FileRef[] | null>(null);
  protected readonly filesError = signal<string | null>(null);

  // Read when the tab is entered and whenever the asset is (re)loaded while it is open — a live
  // event refetches the asset, and a placement or a transcode changes the rows, not the asset.
  private readonly filesEffect = effect(() => {
    const asset = this.asset();
    if (this.section() !== 'files' || !asset) return;
    this.loadFiles(asset.id);
  });

  /** The terms each term field offers (EP-28.3) — deprecated and merged too, to name old values. */
  private readonly vocabularies = inject(VocabulariesService);
  private readonly peopleApi = inject(PeopleService);

  protected livePeople(): Person[] {
    return this.people().filter((p) => !p.deprecatedAt);
  }

  protected personName(id: string): string {
    return this.people().find((p) => p.id === id)?.name ?? id;
  }

  /** Inherited entries of the roles the edited cast does not name — what the reader also gets. */
  protected inheritedCastEntries() {
    const own = new Set((this.cast() ?? []).map((e) => e.roleId));
    return (this.inheritance()?.defaults.cast ?? []).filter((e) => !own.has(e.roleId));
  }

  protected addCast(roleId: string, personId: string): void {
    if (!roleId || !personId || !this.canEdit('cast')) return;
    const current = this.cast() ?? [];
    if (current.some((e) => e.roleId === roleId && e.personId === personId)) return;
    this.setCast([...current, { personId, roleId }]);
  }

  protected removeCast(index: number): void {
    const current = this.cast() ?? [];
    this.setCast(current.filter((_, i) => i !== index));
  }

  /** `null` gives every role back to the category — `inherit: ['cast']` on save. */
  protected setCast(value: CastEntry[] | null): void {
    this.cast.set(value);
    this.castDirty.set(JSON.stringify(value) !== JSON.stringify(this.asset()?.cast ?? null));
    this.editors.setDirty(this.tabId(), this.dirtyCount() > 0);
    this.saved.set(false);
  }
  protected readonly terms = signal<Partial<Record<TermHolder, VocabularyTerm[]>>>({});

  protected liveTerms(field: TermHolder): VocabularyTerm[] {
    return (this.terms()[field] ?? []).filter((t) => !t.deprecatedAt);
  }

  protected isLive(field: TermHolder, id: string): boolean {
    return this.liveTerms(field).some((t) => t.id === id);
  }

  /** A term's label — marked when it is no longer offered; the id itself when unknown. */
  protected termName(field: TermHolder, id: string): string {
    const term = (this.terms()[field] ?? []).find((t) => t.id === id);
    if (!term) return id;
    const name = termLabel(term, this.locale.locale());
    return term.deprecatedAt ? `${name} (${this.locale.t('categories.deprecated')})` : name;
  }

  /** The empty choice: what the field inherits, when it inherits anything. */
  protected inheritOption(field: TermField): string {
    const hit = this.inheritedOf(field);
    return hit
      ? `— ${this.locale.t('assetEditor.inherits')} ${this.termName(field, hit.value)}`
      : `— ${this.locale.t('assetEditor.notSet')}`;
  }

  protected categoryKnown(id: string): boolean {
    return this.categories().some((c) => c.id === id);
  }

  ngOnInit(): void {
    this.categoriesApi.list().subscribe({
      next: (all) => this.categories.set(all),
      error: () => undefined,
    });
    this.peopleApi.list(true).subscribe({
      next: (all) => this.people.set(all),
      error: () => undefined,
    });
    for (const [field, vocabulary] of Object.entries(TERM_VOCABULARY) as [
      TermHolder,
      (typeof TERM_VOCABULARY)[TermHolder],
    ][]) {
      this.vocabularies.list(vocabulary, true).subscribe({
        next: (list) => this.terms.update((t) => ({ ...t, [field]: list })),
        error: () => undefined,
      });
    }
    this.reload();
  }

  private loadFiles(id: string, then?: (rows: FileRef[]) => void): void {
    this.filesError.set(null);
    this.assetsApi.files(id).subscribe({
      next: (rows) => {
        this.files.set(rows);
        then?.(rows);
      },
      error: () => this.filesError.set(this.locale.t('assetEditor.filesError')),
    });
  }

  private mirrorTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly mirrorCleanup = inject(DestroyRef).onDestroy(() =>
    clearTimeout(this.mirrorTimer),
  );

  /**
   * A transcode finished: re-read the file rows until they carry what it produced.
   *
   * MAM's FileRef mirror and MTS's completion are two ends of one event with a broker between
   * them, so the first read after a completion can still be the old rows. The renditions'
   * CHECKSUMS are the test — a row of the same kind could be a previous transcode's — and the wait
   * is bounded: if the mirror is down, the rows say so by not changing, and the next visit to the
   * tab reads them again.
   */
  protected renditionsProduced(job: Job, attempt = 0): void {
    const asset = this.asset();
    if (!asset) return;
    const wanted = new Set((job.renditions ?? []).map((r) => r.checksum.value));
    this.loadFiles(asset.id, (rows) => {
      const have = new Set(rows.map((f) => f.checksum.value));
      const arrived = [...wanted].every((c) => have.has(c));
      if (arrived || attempt >= RENDITION_WAIT_ATTEMPTS) return;
      clearTimeout(this.mirrorTimer);
      this.mirrorTimer = setTimeout(
        () => this.renditionsProduced(job, attempt + 1),
        RENDITION_WAIT_MS,
      );
    });
  }

  protected formatSize(bytes: number | undefined): string {
    if (bytes === undefined) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  /**
   * `fresh` reads through MAM's cache (EP-17.7): a reload that answers an event, a resync or the
   * user's own Retry exists because the record may have just changed, and a cached copy of what
   * it was is exactly the wrong answer to that.
   */
  protected reload(options: { fresh?: boolean } = {}): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.assetsApi.get(this.assetId(), options).subscribe({
      next: (asset) => {
        this.asset.set(asset);
        this.draft.set(toDraft(asset));
        this.adoptLists(asset);
        this.dirtyFields.set(new Set());
        this.editors.setDirty(this.tabId(), false);
        this.loading.set(false);
        this.loadInheritance();
      },
      error: () => {
        this.loadError.set('Could not load this asset.');
        this.loading.set(false);
      },
    });
  }

  private loadInheritance(): void {
    this.assetsApi.inherited(this.assetId()).subscribe({
      next: (inheritance) => this.inheritance.set(inheritance),
      // Without it the fields show the asset's own values, which is still the truth about them.
      error: () => this.inheritance.set(null),
    });
  }

  /** The value a field inherits — only when the asset does not set its own. */
  protected inheritedOf(field: MediaDefault) {
    return this.inheritance()?.defaults[field] ?? null;
  }

  /** Whether the STORED asset sets this media default itself. */
  protected ownsField(field: MediaDefault): boolean {
    return this.asset()?.[field] !== undefined;
  }

  /**
   * Stop setting a media default, so the category's value shows through (data-model §2.2) — its
   * own audited revision, `inherit` in the PATCH. Only with nothing unsaved: it saves.
   */
  protected resetToInherited(field: MediaDefault): void {
    if (this.saving() || this.dirtyCount() > 0 || !this.canEdit(FIELD_GROUP[field])) return;
    this.saving.set(true);
    this.saveError.set(null);
    this.assetsApi.update(this.assetId(), { inherit: [field] }).subscribe({
      next: (asset) => {
        this.asset.set(asset);
        this.draft.set(toDraft(asset));
        this.adoptLists(asset);
        this.saving.set(false);
        this.loadInheritance();
      },
      error: () => {
        this.saveError.set(this.locale.t('assetEditor.resetError'));
        this.saving.set(false);
      },
    });
  }

  protected inheritedList(field: ListField) {
    return this.inheritance()?.defaults[field] ?? null;
  }

  /** The terms a list offers: the live ones, and any it holds that are no longer live. */
  protected listTerms(field: ListField): VocabularyTerm[] {
    const all = this.terms()[field] ?? [];
    const held = new Set(this.lists()[field] ?? []);
    return all.filter((t) => !t.deprecatedAt || held.has(t.id));
  }

  /** Checked when in the asset's own list — or, while it inherits, in the inherited one. */
  protected checkedTerm(field: ListField, id: string): boolean {
    return (this.lists()[field] ?? this.inheritedList(field)?.value ?? []).includes(id);
  }

  /** Ticking a box while inheriting starts the asset's OWN list from what it inherited. */
  protected toggleTerm(field: ListField, id: string, checked: boolean): void {
    if (!this.canEdit('taxonomy')) return;
    const base = this.lists()[field] ?? this.inheritedList(field)?.value ?? [];
    const next = checked ? [...new Set([...base, id])] : base.filter((x) => x !== id);
    this.setList(field, next);
  }

  /** Back to inheriting — saved with the rest, as `inherit` in the PATCH. */
  protected inheritList(field: ListField): void {
    if (this.canEdit('taxonomy')) this.setList(field, null);
  }

  private setList(field: ListField, value: string[] | null): void {
    this.lists.update((l) => ({ ...l, [field]: value }));
    const stored = this.asset()?.[field] ?? null;
    const dirty = new Set(this.dirtyLists());
    if (JSON.stringify(value) === JSON.stringify(stored)) dirty.delete(field);
    else dirty.add(field);
    this.dirtyLists.set(dirty);
    this.editors.setDirty(this.tabId(), this.dirtyCount() > 0);
    this.saved.set(false);
    this.saveError.set(null);
  }

  private adoptLists(asset: Asset): void {
    this.cast.set(asset.cast ?? null);
    this.castDirty.set(false);
    this.lists.set({
      subjectIds: asset.subjectIds ?? null,
      classificationIds: asset.classificationIds ?? null,
    });
    this.dirtyLists.set(new Set());
  }

  protected canEdit(group: FieldGroup): boolean {
    const asset = this.asset();
    if (!asset) return false;
    return this.permissions.can('asset:write', {
      type: 'asset',
      channelId: asset.channelId,
      ownerId: asset.createdBy,
      state: asset.state,
      fieldGroup: group,
    });
  }

  protected change(field: EditableField, value: string): void {
    if (!this.canEdit(FIELD_GROUP[field])) return;
    const current = this.draft();
    const original = this.asset();
    if (!current || !original) return;

    this.draft.set({ ...current, [field]: value });
    const dirty = new Set(this.dirtyFields());
    if (value === toDraft(original)[field]) dirty.delete(field);
    else dirty.add(field);
    this.dirtyFields.set(dirty);
    this.editors.setDirty(this.tabId(), dirty.size > 0);
    this.saved.set(false);
    this.saveError.set(null);
  }

  protected save(event: Event): void {
    event.preventDefault();
    if (this.saving() || this.dirtyCount() === 0) return;
    const patch = this.buildPatch();
    if (!patch) return;

    this.saving.set(true);
    this.saveError.set(null);
    this.saved.set(false);
    this.assetsApi.update(this.assetId(), patch).subscribe({
      next: (asset) => {
        this.asset.set(asset);
        this.draft.set(toDraft(asset));
        this.adoptLists(asset);
        this.dirtyFields.set(new Set());
        this.editors.setDirty(this.tabId(), false);
        this.saving.set(false);
        this.saved.set(true);
        this.loadInheritance();
      },
      error: () => {
        this.saveError.set('Could not save these changes. Your edits are still here.');
        this.saving.set(false);
      },
    });
  }

  private buildPatch(): UpdateAssetInput | null {
    const form = this.draft();
    if (!form) return null;
    const patch: UpdateAssetInput = {};

    for (const field of this.dirtyFields()) {
      if (!this.canEdit(FIELD_GROUP[field])) continue;
      const value = form[field];
      switch (field) {
        case 'title':
          if (value.trim() === '') return this.invalid('Title is required.');
          patch.title = value.trim();
          break;
        case 'description':
          patch.description = value;
          break;
        case 'categoryId':
          patch.categoryId = value;
          break;
        case 'structureId':
        case 'genre':
        case 'supplyType':
        case 'productionGroup':
          // Cleared: the asset stops setting it, and inherits again.
          if (value.trim() === '') patch.inherit = [...(patch.inherit ?? []), field];
          else patch[field] = value.trim();
          break;
        case 'productionDate':
          if (value === '') patch.inherit = [...(patch.inherit ?? []), field];
          else if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            return this.invalid('Production date must be a date.');
          } else patch.productionDate = value;
          break;
        case 'episodeNo': {
          const parsed = wholeNumber(value);
          if (parsed === null)
            return this.invalid('Episode number must be a non-negative integer.');
          patch.episodeNo = parsed;
          break;
        }
        case 'durationSec': {
          const parsed = positiveNumber(value);
          if (parsed === null) return this.invalid('Duration must be a non-negative number.');
          patch.durationSec = parsed;
          break;
        }
        case 'allowedBroadcastCount': {
          const parsed = wholeNumber(value);
          if (parsed === null)
            return this.invalid('Allowed broadcasts must be a non-negative integer.');
          patch.allowedBroadcastCount = parsed;
          break;
        }
        case 'expiresAt':
          if (value === '' || Number.isNaN(Date.parse(value))) {
            return this.invalid('Expiry must be an ISO-8601 date and time.');
          }
          patch.expiresAt = value;
          break;
      }
    }

    if (this.castDirty() && this.canEdit('cast')) {
      const cast = this.cast();
      if (cast === null) patch.inherit = [...(patch.inherit ?? []), 'cast'];
      else patch.cast = cast;
    }
    for (const field of this.dirtyLists()) {
      if (!this.canEdit('taxonomy')) continue;
      const value = this.lists()[field];
      if (value === null) patch.inherit = [...(patch.inherit ?? []), field];
      else patch[field] = value;
    }

    return patch;
  }

  private invalid(message: string): null {
    this.saveError.set(message);
    return null;
  }

  private handleAssetEvent(subject: string, payload: unknown): void {
    // Subject format: atlas.<channelId>.asset.<action>. Unlike the media panel, the action does not
    // matter here: this editor shows ONE asset, and every action that reaches it — updated,
    // approved, rejected, expired, ready — is answered the same way, by refetching the record.
    if (!subject.startsWith('atlas.')) return;

    const envelope = payload as {
      type: string;
      channelId: string;
      payload: {
        assetId: string;
        changedFields?: string[];
      };
    };

    // A category changed: what this asset inherits may have, the asset itself has not.
    if (envelope.type === 'taxonomy.updated') {
      if (envelope.channelId === this.session.channelId() && this.asset()?.categoryId) {
        this.loadInheritance();
      }
      return;
    }

    const assetId = envelope.payload?.assetId;
    if (!assetId || assetId !== this.assetId()) return;

    // Only process events for our current channel
    if (envelope.channelId !== this.session.channelId()) return;

    // A reload REPLACES the draft. With unsaved edits that would silently discard the user's
    // work, so skip the refresh while dirty; the next save's version conflict or a manual
    // reload reconciles instead. When clean, reload for any state-changing event.
    if (this.dirtyCount() > 0) return;
    this.reload({ fresh: true });
  }
}

function toDraft(asset: Asset): Draft {
  return {
    title: asset.title,
    description: asset.description ?? '',
    categoryId: asset.categoryId ?? '',
    structureId: asset.structureId ?? '',
    genre: asset.genre ?? '',
    supplyType: asset.supplyType ?? '',
    productionGroup: asset.productionGroup ?? '',
    productionDate: asset.productionDate ?? '',
    episodeNo: asset.episodeNo?.toString() ?? '',
    durationSec: asset.durationSec?.toString() ?? '',
    allowedBroadcastCount: asset.allowedBroadcastCount?.toString() ?? '',
    expiresAt: asset.expiresAt ?? '',
  };
}

function positiveNumber(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function wholeNumber(value: string): number | null {
  const parsed = positiveNumber(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}
