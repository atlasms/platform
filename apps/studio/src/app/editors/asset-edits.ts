import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { EditProjectsService } from '../core/edit-projects.service.ts';
import type { Asset, EditProject } from '../core/generated/mam.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';

/** The media types the editor renders in v1 (media-editor.md §5.1) — a photo is not one. */
const EDITABLE = new Set(['video', 'audio']);

/**
 * The asset editor's Edits section (EP-26.3): the media-editor projects over this asset, newest
 * first, each opened in its own tab — so an editor reopens a timeline rather than starting another —
 * and, for a holder of `asset:write` on `core` (UX only; MAM enforces), a new one.
 */
@Component({
  selector: 'atlas-asset-edits',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="edits">
      @if (projects() === null) {
        <p class="muted">{{ locale.t('editor.loading') }}</p>
      } @else if (projects()!.length === 0) {
        <p class="muted">{{ locale.t('edits.none') }}</p>
      } @else {
        <ul>
          @for (p of projects(); track p.id) {
            <li>
              <button type="button" class="link" (click)="open(p)">
                {{ locale.t('edits.project') }} {{ p.createdAt.slice(0, 16).replace('T', ' ') }}
              </button>
              <span class="muted">
                · {{ locale.t('editProject.state.' + p.state) }} · {{ p.timeline.clips.length }}
                {{ locale.t('editProject.clips') }}
              </span>
            </li>
          }
        </ul>
      }
      @if (offered()) {
        <button type="button" class="new" [disabled]="busy()" (click)="start()">
          {{ locale.t('edits.new') }}
        </button>
      } @else if (canEdit() && !editable()) {
        <p class="muted">{{ locale.t('edits.notEditable') }}</p>
      }
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
    </section>
  `,
  styles: `
    .edits {
      display: flex;
      flex-direction: column;
      align-items: start;
      gap: var(--space-2);
      padding: var(--space-2) 0;
    }
    ul {
      margin: 0;
      padding-inline-start: var(--space-4);
    }
    .muted {
      color: var(--color-fg-muted);
    }
    .error {
      margin: 0;
      color: var(--color-danger);
    }
  `,
})
export class AssetEdits {
  private readonly api = inject(EditProjectsService);
  private readonly editors = inject(EditorStore);
  protected readonly locale = inject(LocaleService);

  readonly asset = input.required<Asset>();
  readonly canEdit = input(false);

  protected readonly projects = signal<EditProject[] | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly editable = computed(() => EDITABLE.has(this.asset().mediaType));
  protected readonly offered = computed(() => this.canEdit() && this.editable());

  constructor() {
    effect(() => {
      const id = this.asset().id;
      untracked(() => this.load(id));
    });
  }

  protected open(project: EditProject): void {
    this.editors.open({
      type: 'edit-project',
      resourceId: project.id,
      title: `${this.locale.t('edits.tab')} · ${this.asset().title}`,
      icon: '✂',
    });
  }

  protected start(): void {
    this.busy.set(true);
    this.error.set('');
    this.api.create(this.asset().id).subscribe({
      next: (project) => {
        this.busy.set(false);
        this.projects.update((list) => [project, ...(list ?? [])]);
        this.open(project);
      },
      error: () => {
        this.busy.set(false);
        this.error.set(this.locale.t('edits.createError'));
      },
    });
  }

  private load(id: string): void {
    this.api.forAsset(id).subscribe({
      next: (list) => this.projects.set(list),
      error: () => {
        this.projects.set([]);
        this.error.set(this.locale.t('edits.loadError'));
      },
    });
  }
}
