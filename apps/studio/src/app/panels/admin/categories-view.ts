import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CategoriesService } from '../../core/categories.service.ts';
import { categoryLabel } from '../../core/category-tree.ts';
import type { Category } from '../../core/generated/mam.types.ts';
import { LocaleService } from '../../core/locale.service.ts';
import { PermissionService } from '../../core/permission.service.ts';
import { openCategory } from '../../editors/category-editor.ts';
import { EditorStore } from '../../workbench/editor.store.ts';

const KEY = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The Admin panel's Categories view (#260): the channel's tree, whole and in path order, and a new
 * category — under a parent or at the root. A category opens as an EDITOR TAB (category-editor.ts)
 * for its labels, policies, deprecation and the move.
 *
 * The key is asked for once and said to be permanent, because it is: the path every category-scoped
 * grant and field schema matches is built from keys.
 */
@Component({
  selector: 'atlas-categories-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    @if (canWrite()) {
      <details class="new" [open]="creating()">
        <summary (click)="creating.set(!creating()); $event.preventDefault()">
          {{ locale.t('categories.new') }}
        </summary>
        <form (ngSubmit)="create()">
          <label>
            <span>{{ locale.t('categories.parent') }}</span>
            <select name="parent" [(ngModel)]="parentId">
              <option value="">{{ locale.t('categories.root') }}</option>
              @for (c of live(); track c.id) {
                <option [value]="c.id">{{ c.path }}</option>
              }
            </select>
          </label>
          <label>
            <span>{{ locale.t('categories.key') }}</span>
            <input name="key" [(ngModel)]="key" autocomplete="off" placeholder="football" />
          </label>
          <p class="muted">{{ locale.t('categories.keyHint') }}</p>
          <label>
            <span>{{ locale.t('categories.labelEn') }}</span>
            <input name="en" [(ngModel)]="en" autocomplete="off" />
          </label>
          <label>
            <span>{{ locale.t('categories.labelAr') }}</span>
            <input name="ar" dir="rtl" [(ngModel)]="ar" autocomplete="off" />
          </label>
          <label class="check">
            <input type="checkbox" name="mediaAddable" [(ngModel)]="mediaAddable" />
            <span>{{ locale.t('categories.mediaAddable') }}</span>
          </label>
          @if (createError()) {
            <p class="error" role="alert">{{ createError() }}</p>
          }
          <button type="submit" [disabled]="busy() || !keyOk() || !(en.trim() || ar.trim())">
            {{ locale.t('admin.create') }}
          </button>
        </form>
      </details>
    }

    <p class="mode">{{ locale.t('admin.categories') }}</p>
    <label class="check">
      <input
        type="checkbox"
        [ngModel]="showDeprecated()"
        (ngModelChange)="showDeprecated.set($event); load()"
      />
      <span>{{ locale.t('categories.showDeprecated') }}</span>
    </label>
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    } @else if (loading()) {
      <p class="muted">{{ locale.t('admin.loading') }}</p>
    } @else if (all().length === 0) {
      <p class="muted">{{ locale.t('categories.none') }}</p>
    } @else {
      <ul class="items">
        @for (c of all(); track c.id) {
          <li [style.padding-inline-start.rem]="(c.depth - 1) * 0.75">
            <button type="button" (click)="open(c)">
              <span class="title">{{ label(c) }}</span>
              <span class="muted">{{ c.path }}</span>
              @if (c.deprecatedAt) {
                <span class="state" data-state="disabled">{{
                  locale.t('categories.deprecated')
                }}</span>
              } @else if (!c.mediaAddable) {
                <span class="state">{{ locale.t('categories.noMedia') }}</span>
              }
            </button>
          </li>
        }
      </ul>
    }
  `,
  styleUrl: './admin-view.scss',
  styles: `
    .check {
      display: flex;
      gap: var(--space-1);
      align-items: center;
      font-size: 0.75rem;
    }
  `,
})
export class CategoriesView {
  private readonly api = inject(CategoriesService);
  private readonly editors = inject(EditorStore);
  private readonly permissions = inject(PermissionService);
  protected readonly locale = inject(LocaleService);

  protected readonly all = signal<Category[]>([]);
  protected readonly live = computed(() => this.all().filter((c) => !c.deprecatedAt));
  protected readonly showDeprecated = signal(false);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly creating = signal(false);
  protected readonly busy = signal(false);
  protected readonly createError = signal<string | null>(null);
  /** UX only — MAM enforces `taxonomy:admin` over the new node's path. */
  protected readonly canWrite = computed(() => this.permissions.can('taxonomy:admin'));

  protected parentId = '';
  protected key = '';
  protected en = '';
  protected ar = '';
  protected mediaAddable = true;

  constructor() {
    this.load();
  }

  protected keyOk(): boolean {
    return KEY.test(this.key) && this.key.length <= 64;
  }

  protected label(c: Category): string {
    return categoryLabel(c, this.locale.locale());
  }

  protected load(): void {
    this.loading.set(true);
    this.api.list(this.showDeprecated()).subscribe({
      next: (all) => {
        this.all.set(all);
        this.loading.set(false);
      },
      error: () => {
        this.error.set(this.locale.t('admin.loadError'));
        this.loading.set(false);
      },
    });
  }

  protected open(c: Category): void {
    openCategory(this.editors, c, this.locale.locale());
  }

  protected create(): void {
    if (this.busy() || !this.keyOk()) return;
    const labels: Record<string, string> = {};
    if (this.en.trim()) labels['en'] = this.en.trim();
    if (this.ar.trim()) labels['ar'] = this.ar.trim();
    this.busy.set(true);
    this.createError.set(null);
    this.api
      .create({
        key: this.key,
        labels,
        mediaAddable: this.mediaAddable,
        ...(this.parentId ? { parentId: this.parentId } : {}),
      })
      .subscribe({
        next: (created) => {
          this.busy.set(false);
          this.creating.set(false);
          this.key = '';
          this.en = '';
          this.ar = '';
          this.load();
          this.open(created);
        },
        error: (err: { error?: { message?: string } }) => {
          this.busy.set(false);
          this.createError.set(err.error?.message ?? this.locale.t('admin.writeError'));
        },
      });
  }
}
