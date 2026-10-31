import { HttpErrorResponse } from '@angular/common/http';
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
import { AssetsService } from '../core/assets.service.ts';
import type { Asset, ShotListItem } from '../core/generated/mam.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { bodyOf, changed, newRow, problemsOf, rowsOf, type ShotRow } from './shotlist.model.ts';

/**
 * The asset editor's Shot list section (EP-27.3; data-model §1.6): the asset's notable segments —
 * a start and end timecode and what happens there — edited as a list and saved whole.
 *
 * - Timecodes are typed as HH:MM:SS.mmm (or MM:SS, or seconds); a value that is not one is the
 *   form's to refuse, before MAM is asked. MAM orders the list and judges the media's end; its 422
 *   is shown under the row and field each problem names.
 * - Editing is offered to a holder of `asset:write` on the `shotlist` field group — UX only, MAM
 *   enforces it. Anyone who can open the asset reads the list.
 * - Read on entering the section and again whenever the asset's version moves (another editor's
 *   save, a live event) — never over rows being edited.
 */
@Component({
  selector: 'atlas-asset-shotlist',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="shotlist">
      @if (rows() === null) {
        <p class="muted">{{ locale.t('editor.loading') }}</p>
      } @else {
        @if (rows()!.length === 0) {
          <p class="muted">{{ locale.t('shotlist.empty') }}</p>
        } @else {
          <table>
            <thead>
              <tr>
                <th>{{ locale.t('shotlist.start') }}</th>
                <th>{{ locale.t('shotlist.end') }}</th>
                <th>{{ locale.t('shotlist.description') }}</th>
                @if (canEdit()) {
                  <th>
                    <span class="sr-only">{{ locale.t('shotlist.remove') }}</span>
                  </th>
                }
              </tr>
            </thead>
            <tbody>
              @for (row of rows(); track row.key; let i = $index) {
                <tr>
                  <td>
                    <input
                      class="tc"
                      [attr.aria-label]="locale.t('shotlist.start')"
                      [value]="row.start"
                      [readOnly]="!canEdit()"
                      [attr.aria-invalid]="problem(i, 'startMs') ? 'true' : null"
                      (input)="edit(i, 'start', $any($event.target).value)"
                    />
                    @if (problem(i, 'startMs'); as p) {
                      <p class="field-error">{{ p }}</p>
                    }
                  </td>
                  <td>
                    <input
                      class="tc"
                      [attr.aria-label]="locale.t('shotlist.end')"
                      [value]="row.end"
                      [readOnly]="!canEdit()"
                      [attr.aria-invalid]="problem(i, 'endMs') ? 'true' : null"
                      (input)="edit(i, 'end', $any($event.target).value)"
                    />
                    @if (problem(i, 'endMs'); as p) {
                      <p class="field-error">{{ p }}</p>
                    }
                  </td>
                  <td>
                    <input
                      class="description"
                      [attr.aria-label]="locale.t('shotlist.description')"
                      [value]="row.description"
                      [readOnly]="!canEdit()"
                      [attr.aria-invalid]="problem(i, 'description') ? 'true' : null"
                      (input)="edit(i, 'description', $any($event.target).value)"
                    />
                    @if (problem(i, 'description'); as p) {
                      <p class="field-error">{{ p }}</p>
                    }
                  </td>
                  @if (canEdit()) {
                    <td>
                      <button
                        type="button"
                        class="remove"
                        [attr.aria-label]="locale.t('shotlist.remove')"
                        (click)="remove(i)"
                      >
                        ×
                      </button>
                    </td>
                  }
                </tr>
              }
            </tbody>
          </table>
        }
        @if (canEdit()) {
          <div class="actions">
            <button type="button" class="add" (click)="add()">
              {{ locale.t('shotlist.add') }}
            </button>
            <button type="button" class="save" [disabled]="busy() || !dirty()" (click)="save()">
              {{ locale.t('shotlist.save') }}
            </button>
          </div>
        }
      }
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
    </section>
  `,
  styles: `
    .shotlist {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      padding: var(--space-2) 0;
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
    .tc {
      width: 8.5rem;
      font-family: ui-monospace, monospace;
    }
    .description {
      width: 100%;
    }
    .actions {
      display: flex;
      gap: var(--space-2);
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
export class AssetShotList {
  private readonly assets = inject(AssetsService);
  protected readonly locale = inject(LocaleService);

  readonly asset = input.required<Asset>();
  readonly canEdit = input(false);

  /** What MAM holds, as last read. */
  private readonly stored = signal<ShotListItem[]>([]);
  protected readonly rows = signal<ShotRow[] | null>(null);
  private readonly problems = signal<Record<string, string>>({});
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly dirty = computed(() => {
    const rows = this.rows();
    return rows !== null && changed(rows, this.stored());
  });
  private nextKey = 0;

  constructor() {
    // Re-read when the asset (or its version) changes — but never over unsaved rows.
    effect(() => {
      const asset = this.asset();
      void asset.version;
      untracked(() => {
        if (!this.dirty()) this.load(asset.id);
      });
    });
  }

  protected problem(i: number, field: 'startMs' | 'endMs' | 'description'): string | undefined {
    const p = this.problems()[`items/${i}/${field}`];
    if (p === 'timecode') return this.locale.t('shotlist.badTimecode');
    return p;
  }

  protected edit(i: number, field: 'start' | 'end' | 'description', value: string): void {
    this.rows.update((rows) => rows!.map((r, j) => (j === i ? { ...r, [field]: value } : r)));
  }

  protected add(): void {
    this.rows.update((rows) => [...(rows ?? []), newRow(rows ?? [], `new-${this.nextKey++}`)]);
  }

  protected remove(i: number): void {
    this.rows.update((rows) => rows!.filter((_, j) => j !== i));
    this.problems.set({});
  }

  protected save(): void {
    const rows = this.rows();
    if (!rows) return;
    const body = bodyOf(rows);
    if ('problems' in body) {
      this.problems.set(body.problems);
      return;
    }
    this.busy.set(true);
    this.error.set('');
    this.assets.setShotlist(this.asset().id, body.items).subscribe({
      next: (list) => {
        this.busy.set(false);
        this.problems.set({});
        this.stored.set(list.items);
        this.rows.set(rowsOf(list.items));
      },
      error: (err: unknown) => {
        this.busy.set(false);
        if (err instanceof HttpErrorResponse && err.status === 422) {
          this.problems.set(problemsOf(err.error?.details));
          this.error.set(this.locale.t('shotlist.refused'));
        } else if (err instanceof HttpErrorResponse && err.status === 409) {
          this.error.set(this.locale.t('shotlist.conflict'));
          this.load(this.asset().id);
        } else {
          this.error.set(this.locale.t('shotlist.failed'));
        }
      },
    });
  }

  private load(id: string): void {
    this.assets.shotlist(id).subscribe({
      next: (list) => {
        this.stored.set(list.items);
        this.rows.set(rowsOf(list.items));
        this.problems.set({});
      },
      error: () => this.error.set(this.locale.t('shotlist.failed')),
    });
  }
}
