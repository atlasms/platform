import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { AssetsService } from '../core/assets.service.ts';
import type { Asset, UpdateAssetInput } from '../core/generated/mam.types.ts';
import { PermissionService } from '../core/permission.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';

type EditorSection = 'basic' | 'files';
type EditableField = keyof UpdateAssetInput;
type FieldGroup = 'core' | 'taxonomy' | 'rights';
type Draft = Record<EditableField, string>;

const FIELD_GROUP: Readonly<Record<EditableField, FieldGroup>> = {
  title: 'core',
  description: 'core',
  episodeNo: 'core',
  durationSec: 'core',
  categoryId: 'taxonomy',
  structureId: 'taxonomy',
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
  template: `
    @if (loading()) {
      <div class="state"><p>Loading asset…</p></div>
    } @else if (loadError()) {
      <div class="state" role="alert">
        <p>{{ loadError() }}</p>
        <button type="button" (click)="reload()">Retry</button>
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
          Basic info
        </button>
        <button
          type="button"
          role="tab"
          [attr.aria-selected]="section() === 'files'"
          [class.active]="section() === 'files'"
          (click)="section.set('files')"
        >
          Files
        </button>
      </nav>

      @if (section() === 'basic' && draft(); as form) {
        <form class="basic" (submit)="save($event)">
          <section class="field-group">
            <div class="group-heading">
              <h3>Identity</h3>
              <span>{{ canEdit('core') ? 'Editable' : 'Read only' }}</span>
            </div>
            <div class="grid">
              <label class="wide">
                Title
                <input
                  name="title"
                  required
                  [disabled]="!canEdit('core')"
                  [value]="form.title"
                  (input)="change('title', $any($event.target).value)"
                />
              </label>
              <label>
                Media type
                <input [value]="current.mediaType" disabled />
              </label>
              <label>
                State
                <input [value]="current.state" disabled />
              </label>
              <label class="wide">
                Description
                <textarea
                  name="description"
                  rows="4"
                  [disabled]="!canEdit('core')"
                  [value]="form.description"
                  (input)="change('description', $any($event.target).value)"
                ></textarea>
              </label>
              <label>
                Episode number
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
                Duration (seconds)
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
              <h3>Classification</h3>
              <span>{{ canEdit('taxonomy') ? 'Editable' : 'Read only' }}</span>
            </div>
            <div class="grid">
              <label>
                Category ID
                <input
                  name="categoryId"
                  [disabled]="!canEdit('taxonomy')"
                  [value]="form.categoryId"
                  (input)="change('categoryId', $any($event.target).value)"
                />
              </label>
              <label>
                Structure ID
                <input
                  name="structureId"
                  [disabled]="!canEdit('taxonomy')"
                  [value]="form.structureId"
                  (input)="change('structureId', $any($event.target).value)"
                />
              </label>
            </div>
          </section>

          <section class="field-group">
            <div class="group-heading">
              <h3>Rights</h3>
              <span>{{ canEdit('rights') ? 'Editable' : 'Read only' }}</span>
            </div>
            <div class="grid">
              <label>
                Allowed broadcasts
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
                Expires at (ISO-8601)
                <input
                  name="expiresAt"
                  [disabled]="!canEdit('rights')"
                  [value]="form.expiresAt"
                  (input)="change('expiresAt', $any($event.target).value)"
                />
              </label>
              <div class="readonly-value">
                <span>Recommended window</span>
                <strong>
                  {{ current.recommendedBroadcastStart || 'Not set' }}
                  —
                  {{ current.recommendedBroadcastEnd || 'Not set' }}
                </strong>
              </div>
            </div>
          </section>

          <section class="record-meta" aria-label="Record details">
            <span>Created by {{ current.createdBy }}</span>
            <span>Created {{ current.createdAt }}</span>
            <span>Updated {{ current.updatedAt }}</span>
          </section>

          @if (saveError()) {
            <p class="message error" role="alert">{{ saveError() }}</p>
          } @else if (saved()) {
            <p class="message" role="status">Changes saved.</p>
          }

          @if (mayEditAnything()) {
            <div class="actions">
              <button type="submit" [disabled]="saving() || dirtyCount() === 0">
                {{ saving() ? 'Saving…' : 'Save changes' }}
              </button>
              <span>{{ dirtyCount() }} changed field{{ dirtyCount() === 1 ? '' : 's' }}</span>
            </div>
          }
        </form>
      } @else if (section() === 'files') {
        <section class="files">
          <div class="file-summary">
            <span class="file-icon" aria-hidden="true">▤</span>
            <div>
              <h3>{{ current.fileType }}</h3>
              <p>{{ current.hasRenditions ? 'Renditions attached' : 'Awaiting renditions' }}</p>
            </div>
          </div>
          <dl>
            <div>
              <dt>Source container</dt>
              <dd>{{ current.fileType }}</dd>
            </div>
            <div>
              <dt>Rendition set</dt>
              <dd>{{ current.hasRenditions ? 'Available' : 'Pending' }}</dd>
            </div>
          </dl>
          <p class="files-note">
            Individual file rows, checksums, storage tier and technical metadata will appear here
            when MAM's FileRef projection is available. HSM remains the source of truth for files.
          </p>
        </section>
      }
    }
  `,
  styleUrl: './asset-editor.scss',
})
export class AssetEditor {
  readonly assetId = input.required<string>();
  readonly tabId = input.required<string>();

  private readonly assetsApi = inject(AssetsService);
  private readonly permissions = inject(PermissionService);
  private readonly editors = inject(EditorStore);

  protected readonly asset = signal<Asset | null>(null);
  protected readonly draft = signal<Draft | null>(null);
  protected readonly section = signal<EditorSection>('basic');
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly loadError = signal<string | null>(null);
  protected readonly saveError = signal<string | null>(null);
  protected readonly saved = signal(false);
  protected readonly dirtyFields = signal<ReadonlySet<EditableField>>(new Set());
  protected readonly dirtyCount = computed(() => this.dirtyFields().size);
  protected readonly mayEditAnything = computed(() =>
    (['core', 'taxonomy', 'rights'] as const).some((group) => this.canEdit(group)),
  );

  ngOnInit(): void {
    this.reload();
  }

  protected reload(): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.assetsApi.get(this.assetId()).subscribe({
      next: (asset) => {
        this.asset.set(asset);
        this.draft.set(toDraft(asset));
        this.dirtyFields.set(new Set());
        this.editors.setDirty(this.tabId(), false);
        this.loading.set(false);
      },
      error: () => {
        this.loadError.set('Could not load this asset.');
        this.loading.set(false);
      },
    });
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
    if (this.saving() || this.dirtyFields().size === 0) return;
    const patch = this.buildPatch();
    if (!patch) return;

    this.saving.set(true);
    this.saveError.set(null);
    this.saved.set(false);
    this.assetsApi.update(this.assetId(), patch).subscribe({
      next: (asset) => {
        this.asset.set(asset);
        this.draft.set(toDraft(asset));
        this.dirtyFields.set(new Set());
        this.editors.setDirty(this.tabId(), false);
        this.saving.set(false);
        this.saved.set(true);
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
          patch.structureId = value;
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

    return patch;
  }

  private invalid(message: string): null {
    this.saveError.set(message);
    return null;
  }
}

function toDraft(asset: Asset): Draft {
  return {
    title: asset.title,
    description: asset.description ?? '',
    categoryId: asset.categoryId ?? '',
    structureId: asset.structureId ?? '',
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
