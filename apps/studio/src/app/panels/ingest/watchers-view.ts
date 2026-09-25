import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Watcher } from '../../core/generated/rim.types.ts';
import { LocaleService } from '../../core/locale.service.ts';
import { WatchersService } from '../../core/watchers.service.ts';
import { openWatcher } from '../../editors/watcher-editor.ts';
import { EditorStore } from '../../workbench/editor.store.ts';

/**
 * The Ingest panel's Watchers view (EP-15.2): the channel's folder watchers and a new one. A
 * watcher opens as an EDITOR TAB (watcher-editor.ts), where its settings are. Revealed by
 * `ingest:admin`, the one permission every call here needs.
 *
 * The list comes from the panel, which also needs it to name a watched job's source in the queue;
 * a create is announced back up so both stay one list.
 */
@Component({
  selector: 'atlas-watchers-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <details class="new" [open]="creating()">
      <summary (click)="creating.set(!creating()); $event.preventDefault()">
        {{ locale.t('watchers.new') }}
      </summary>
      <form (ngSubmit)="create()">
        <label>
          <span>{{ locale.t('watchers.name') }}</span>
          <input name="name" [(ngModel)]="name" autocomplete="off" required />
        </label>
        <label>
          <span>{{ locale.t('watchers.path') }}</span>
          <input name="path" [(ngModel)]="path" autocomplete="off" placeholder="playout/drops" />
        </label>
        <p class="muted">{{ locale.t('watchers.pathHint') }}</p>
        @if (createError()) {
          <p class="error" role="alert">{{ createError() }}</p>
        }
        <button type="submit" [disabled]="busy() || !name.trim() || !path.trim()">
          {{ locale.t('admin.create') }}
        </button>
      </form>
    </details>

    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    } @else if (watchers().length === 0) {
      <p class="muted">{{ locale.t('watchers.none') }}</p>
    } @else {
      <ul class="items">
        @for (w of watchers(); track w.id) {
          <li>
            <button type="button" (click)="open(w)">
              <span class="title">{{ w.name }}</span>
              <span class="muted">{{ w.path }}</span>
              @if (!w.enabled) {
                <span class="state" data-state="disabled">{{ locale.t('watchers.disabled') }}</span>
              } @else {
                <span class="state">{{ locale.t('watchers.after.' + w.afterPickup) }}</span>
              }
            </button>
          </li>
        }
      </ul>
    }
  `,
  styleUrl: '../admin/admin-view.scss',
})
export class WatchersView {
  readonly watchers = input.required<readonly Watcher[]>();
  readonly error = input<string | null>(null);
  readonly created = output<Watcher>();

  private readonly api = inject(WatchersService);
  private readonly editors = inject(EditorStore);
  protected readonly locale = inject(LocaleService);

  protected readonly creating = signal(false);
  protected readonly busy = signal(false);
  protected readonly createError = signal<string | null>(null);
  protected name = '';
  protected path = '';

  /**
   * With RIM's defaults — settle 10 s, every file, `delete` after pickup — and opened, where the
   * rest is set. A path RIM refuses (out of the channel's directory, or a folder another watcher
   * has) is its message, shown here.
   */
  protected create(): void {
    const name = this.name.trim();
    const path = this.path.trim();
    if (!name || !path || this.busy()) return;
    this.busy.set(true);
    this.createError.set(null);
    this.api.create({ name, path }).subscribe({
      next: (watcher) => {
        this.name = '';
        this.path = '';
        this.busy.set(false);
        this.creating.set(false);
        this.created.emit(watcher);
        this.open(watcher);
      },
      error: (err: { error?: { message?: string } }) => {
        this.createError.set(err.error?.message ?? this.locale.t('admin.createError'));
        this.busy.set(false);
      },
    });
  }

  protected open(watcher: Watcher): void {
    openWatcher(this.editors, watcher);
  }
}
