import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  type OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { RightsWindow } from '../../core/generated/scheduling.types.ts';
import { LocaleService } from '../../core/locale.service.ts';
import { PermissionService } from '../../core/permission.service.ts';
import { RightsService } from '../../core/rights.service.ts';
import {
  EMPTY_RIGHTS_DRAFT,
  inputOf,
  openRightsWindow,
  span,
  type RightsDraft,
} from '../../editors/rights-window.model.ts';
import { EditorStore } from '../../workbench/editor.store.ts';

/**
 * The Schedule panel's Rights view (EP-31): the channel's rights windows — when it may air an asset
 * or a category — and a new one. A window opens as an EDITOR TAB (rights-window-editor.ts), where
 * its terms are changed or it is removed. Listing is `asset:read` on the rights group, creating
 * `asset:write` on it; Scheduling enforces both.
 *
 * Nothing announces a window's change live (its only event is its audit record), so the list is
 * read when the view opens and on Refresh.
 */
@Component({
  selector: 'atlas-rights-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    @if (mayWrite()) {
      <details class="new" [open]="creating()">
        <summary (click)="creating.set(!creating()); $event.preventDefault()">
          {{ locale.t('rights.new') }}
        </summary>
        <form (ngSubmit)="create()">
          <label>
            <span>{{ locale.t('rights.licenses') }}</span>
            <select name="subject" [(ngModel)]="draft.subject">
              <option value="asset">{{ locale.t('rights.subject.asset') }}</option>
              <option value="category">{{ locale.t('rights.subject.category') }}</option>
            </select>
          </label>
          <label>
            <span>{{ locale.t('rights.subjectId.' + draft.subject) }}</span>
            <input name="subjectId" [(ngModel)]="draft.subjectId" autocomplete="off" required />
          </label>
          <label>
            <span>{{ locale.t('rights.from') }}</span>
            <input type="datetime-local" name="from" [(ngModel)]="draft.from" required />
          </label>
          <label>
            <span>{{ locale.t('rights.to') }}</span>
            <input type="datetime-local" name="to" [(ngModel)]="draft.to" required />
          </label>
          <p class="muted">{{ locale.t('rights.localTime') }} {{ zone }}.</p>
          @if (createError()) {
            <p class="error" role="alert">{{ createError() }}</p>
          }
          <button
            type="submit"
            [disabled]="busy() || !draft.subjectId.trim() || !draft.from || !draft.to"
          >
            {{ locale.t('admin.create') }}
          </button>
        </form>
      </details>
    }

    <p class="row">
      <span class="muted">{{ locale.t('rights.rule') }}</span>
      <button type="button" class="link" [disabled]="loading()" (click)="load()">
        {{ locale.t('rights.refresh') }}
      </button>
    </p>

    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    } @else if (loading()) {
      <p class="muted">{{ locale.t('admin.loading') }}</p>
    } @else if (windows().length === 0) {
      <p class="muted">{{ locale.t('rights.none') }}</p>
    } @else {
      <ul class="items">
        @for (w of windows(); track w.id) {
          <li>
            <button type="button" (click)="open(w)">
              <span class="title">
                {{ locale.t(w.assetId ? 'rights.subject.asset' : 'rights.subject.category') }}
                {{ w.assetId ?? w.categoryId }}
              </span>
              <span class="muted">{{ span(w) }}</span>
              @if (w.territory) {
                <span class="state">{{ w.territory }}</span>
              }
            </button>
          </li>
        }
      </ul>
    }
  `,
  styleUrl: '../admin/admin-view.scss',
})
export class RightsView implements OnInit {
  private readonly api = inject(RightsService);
  private readonly editors = inject(EditorStore);
  private readonly permissions = inject(PermissionService);
  protected readonly locale = inject(LocaleService);

  protected readonly windows = signal<RightsWindow[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly creating = signal(false);
  protected readonly busy = signal(false);
  protected readonly createError = signal<string | null>(null);
  protected readonly zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  /** UX only — Scheduling enforces `asset:write` on the rights group, strictly. */
  protected readonly mayWrite = computed(() =>
    this.permissions.can('asset:write', { fieldGroup: 'rights' }),
  );
  protected draft: RightsDraft = { ...EMPTY_RIGHTS_DRAFT };
  protected readonly span = span;

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.list().subscribe({
      next: (list) => {
        this.windows.set(list);
        this.loading.set(false);
      },
      error: () => {
        this.error.set(this.locale.t('rights.loadError'));
        this.loading.set(false);
      },
    });
  }

  /** Created, listed in its place by `validFrom`, and opened — where the rest of it is set. */
  protected create(): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.createError.set(null);
    this.api.create(inputOf(this.draft)).subscribe({
      next: (w) => {
        this.busy.set(false);
        this.creating.set(false);
        this.draft = { ...EMPTY_RIGHTS_DRAFT };
        this.windows.update((list) =>
          [...list, w].sort((a, b) => a.validFrom.localeCompare(b.validFrom)),
        );
        this.open(w);
      },
      error: (err: { error?: { message?: string } }) => {
        this.createError.set(err.error?.message ?? this.locale.t('admin.createError'));
        this.busy.set(false);
      },
    });
  }

  protected open(w: RightsWindow): void {
    openRightsWindow(this.editors, w);
  }
}
