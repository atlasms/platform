import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Observable } from 'rxjs';
import type { VocabularyName, VocabularyTerm } from '../../core/generated/mam.types.ts';
import { LocaleService } from '../../core/locale.service.ts';
import { PermissionService } from '../../core/permission.service.ts';
import {
  termLabel,
  VOCABULARY_NAMES,
  VocabulariesService,
} from '../../core/vocabularies.service.ts';

const KEY = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The Admin panel's Vocabularies view (EP-28.3; configuration-and-reference-data.md §2.3): one
 * flat vocabulary at a time — its terms, a new term, and per term a rename, deprecate/restore and
 * a MERGE into another live term. Every write is over the version read; a 409 says the term changed
 * and reloads, never retries. The key is asked for once: imports and feeds map by it.
 */
@Component({
  selector: 'atlas-vocabularies-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <label class="pick">
      <span>{{ locale.t('vocab.vocabulary') }}</span>
      <select name="vocabulary" [ngModel]="vocabulary()" (ngModelChange)="choose($event)">
        @for (v of names; track v) {
          <option [value]="v">{{ locale.t('vocab.name.' + v) }}</option>
        }
      </select>
    </label>

    @if (canWrite()) {
      <details class="new" [open]="creating()">
        <summary (click)="creating.set(!creating()); $event.preventDefault()">
          {{ locale.t('vocab.new') }}
        </summary>
        <form (ngSubmit)="create()">
          <label>
            <span>{{ locale.t('categories.key') }}</span>
            <input name="key" [(ngModel)]="key" autocomplete="off" placeholder="current-affairs" />
          </label>
          <p class="muted">{{ locale.t('vocab.keyHint') }}</p>
          <label>
            <span>{{ locale.t('categories.labelEn') }}</span>
            <input name="en" [(ngModel)]="en" autocomplete="off" />
          </label>
          <label>
            <span>{{ locale.t('categories.labelAr') }}</span>
            <input name="ar" dir="rtl" [(ngModel)]="ar" autocomplete="off" />
          </label>
          <button type="submit" [disabled]="busy() || !keyOk() || !(en.trim() || ar.trim())">
            {{ locale.t('admin.create') }}
          </button>
        </form>
      </details>
    }

    <label class="check">
      <input
        type="checkbox"
        [ngModel]="showDeprecated()"
        (ngModelChange)="showDeprecated.set($event); load()"
      />
      <span>{{ locale.t('categories.showDeprecated') }}</span>
    </label>
    @if (error()) {
      <p class="error" role="alert">
        {{ error() }}
        <button type="button" class="link" (click)="load()">
          {{ locale.t('categories.reload') }}
        </button>
      </p>
    }
    @if (loading()) {
      <p class="muted">{{ locale.t('admin.loading') }}</p>
    } @else if (terms().length === 0) {
      <p class="muted">{{ locale.t('vocab.none') }}</p>
    } @else {
      <ul class="items">
        @for (t of terms(); track t.id) {
          <li class="term">
            <div class="row">
              <span class="title">{{ label(t) }}</span>
              <code class="muted">{{ t.key }}</code>
              @if (t.replacedById) {
                <span class="state" data-state="disabled">
                  {{ locale.t('vocab.mergedInto') }} {{ labelOf(t.replacedById) }}
                </span>
              } @else if (t.deprecatedAt) {
                <span class="state" data-state="disabled">{{
                  locale.t('categories.deprecated')
                }}</span>
              }
            </div>
            @if (canWrite() && editing() === t.id) {
              <form class="row" (ngSubmit)="rename(t)">
                <input
                  name="en"
                  [(ngModel)]="editEn"
                  [placeholder]="locale.t('categories.labelEn')"
                />
                <input
                  name="ar"
                  dir="rtl"
                  [(ngModel)]="editAr"
                  [placeholder]="locale.t('categories.labelAr')"
                />
                <button type="submit" [disabled]="busy()">{{ locale.t('admin.save') }}</button>
                <button type="button" class="link" (click)="editing.set(null)">
                  {{ locale.t('admin.revert') }}
                </button>
              </form>
              @if (!t.replacedById) {
                <div class="row">
                  @if (t.deprecatedAt) {
                    <button type="button" [disabled]="busy()" (click)="deprecate(t, false)">
                      {{ locale.t('categories.restore') }}
                    </button>
                  } @else {
                    <button
                      type="button"
                      class="danger"
                      [disabled]="busy()"
                      (click)="deprecate(t, true)"
                    >
                      {{ locale.t('categories.deprecate') }}
                    </button>
                    <select name="into" [(ngModel)]="mergeInto">
                      <option value="">{{ locale.t('vocab.mergeInto') }}</option>
                      @for (o of mergeTargets(t); track o.id) {
                        <option [value]="o.id">{{ label(o) }}</option>
                      }
                    </select>
                    <button type="button" [disabled]="busy() || !mergeInto" (click)="merge(t)">
                      {{ locale.t('vocab.merge') }}
                    </button>
                  }
                </div>
                <p class="muted">{{ locale.t('vocab.mergeWhy') }}</p>
              }
            } @else if (canWrite()) {
              <button type="button" class="link" (click)="edit(t)">
                {{ locale.t('vocab.edit') }}
              </button>
            }
          </li>
        }
      </ul>
    }
  `,
  styleUrl: './admin-view.scss',
  styles: `
    .pick,
    .check {
      display: flex;
      gap: var(--space-1);
      align-items: center;
      font-size: 0.75rem;
    }
    .term .row {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1);
      align-items: center;
    }
  `,
})
export class VocabulariesView {
  private readonly api = inject(VocabulariesService);
  private readonly permissions = inject(PermissionService);
  protected readonly locale = inject(LocaleService);

  protected readonly names = VOCABULARY_NAMES;
  protected readonly vocabulary = signal<VocabularyName>('genre');
  protected readonly terms = signal<VocabularyTerm[]>([]);
  /** Every term, merged included — to name a merge's survivor even when it is hidden. */
  private readonly everything = signal<VocabularyTerm[]>([]);
  protected readonly showDeprecated = signal(false);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly creating = signal(false);
  protected readonly editing = signal<string | null>(null);
  protected readonly busy = signal(false);
  /** UX only — MAM enforces `taxonomy:admin` in the channel. */
  protected readonly canWrite = computed(() => this.permissions.can('taxonomy:admin'));

  protected key = '';
  protected en = '';
  protected ar = '';
  protected editEn = '';
  protected editAr = '';
  protected mergeInto = '';

  constructor() {
    this.load();
  }

  protected keyOk(): boolean {
    return KEY.test(this.key) && this.key.length <= 64;
  }

  protected label(t: VocabularyTerm): string {
    return termLabel(t, this.locale.locale());
  }

  protected labelOf(id: string): string {
    const t = this.everything().find((x) => x.id === id);
    return t ? this.label(t) : id;
  }

  protected mergeTargets(t: VocabularyTerm): VocabularyTerm[] {
    return this.everything().filter((o) => o.id !== t.id && !o.deprecatedAt);
  }

  protected choose(v: VocabularyName): void {
    this.vocabulary.set(v);
    this.editing.set(null);
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.list(this.vocabulary(), true).subscribe({
      next: (all) => {
        this.everything.set(all);
        this.terms.set(this.showDeprecated() ? all : all.filter((t) => !t.deprecatedAt));
        this.loading.set(false);
      },
      error: () => {
        this.error.set(this.locale.t('admin.loadError'));
        this.loading.set(false);
      },
    });
  }

  protected edit(t: VocabularyTerm): void {
    const labels = t.labels as Record<string, string>;
    this.editEn = labels['en'] ?? '';
    this.editAr = labels['ar'] ?? '';
    this.mergeInto = '';
    this.editing.set(t.id);
  }

  protected create(): void {
    if (this.busy() || !this.keyOk()) return;
    this.write(
      this.api.create(this.vocabulary(), { key: this.key, labels: this.labels(this.en, this.ar) }),
      () => {
        this.creating.set(false);
        this.key = '';
        this.en = '';
        this.ar = '';
      },
    );
  }

  protected rename(t: VocabularyTerm): void {
    const labels = this.labels(this.editEn, this.editAr);
    if (Object.keys(labels).length === 0) return;
    this.write(this.api.update(this.vocabulary(), t.id, t.version, { labels }));
  }

  protected deprecate(t: VocabularyTerm, deprecated: boolean): void {
    this.write(this.api.update(this.vocabulary(), t.id, t.version, { deprecated }));
  }

  protected merge(t: VocabularyTerm): void {
    if (!this.mergeInto) return;
    this.write(this.api.merge(this.vocabulary(), t.id, this.mergeInto, t.version));
  }

  private labels(en: string, ar: string): Record<string, string> {
    const labels: Record<string, string> = {};
    if (en.trim()) labels['en'] = en.trim();
    if (ar.trim()) labels['ar'] = ar.trim();
    return labels;
  }

  private write(request: Observable<VocabularyTerm>, then?: () => void): void {
    this.busy.set(true);
    this.error.set(null);
    request.subscribe({
      next: () => {
        this.busy.set(false);
        this.editing.set(null);
        then?.();
        this.load();
      },
      error: (err: { status?: number; error?: { message?: string } }) => {
        this.busy.set(false);
        this.error.set(
          err.status === 409 && /changed since version/.test(err.error?.message ?? '')
            ? this.locale.t('vocab.conflict')
            : (err.error?.message ?? this.locale.t('admin.writeError')),
        );
      },
    });
  }
}
