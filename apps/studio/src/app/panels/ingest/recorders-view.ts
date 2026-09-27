import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Recorder } from '../../core/generated/rim.types.ts';
import { LocaleService } from '../../core/locale.service.ts';
import { RecordersService } from '../../core/recorders.service.ts';
import { openRecorder } from '../../editors/recorder-editor.ts';
import { allDay, describeWindows, inputOf } from '../../editors/recorder.model.ts';
import { EditorStore } from '../../workbench/editor.store.ts';

/**
 * The Ingest panel's Recorders view (EP-39; ADR-0007): the channel's recorders — each one's
 * windows in a line, and whether it is on — and a new one. A recorder opens as an EDITOR TAB
 * (recorder-editor.ts), where its settings and its captures are. `ingest:admin`. The list comes
 * from the panel, which also needs it to name a recorded job's source in the queue.
 */
@Component({
  selector: 'atlas-recorders-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <details class="new" [open]="creating()">
      <summary (click)="creating.set(!creating()); $event.preventDefault()">
        {{ locale.t('recorders.new') }}
      </summary>
      <form (ngSubmit)="create()">
        <label>
          <span>{{ locale.t('recorders.name') }}</span>
          <input name="name" [(ngModel)]="name" autocomplete="off" required />
        </label>
        <label>
          <span>{{ locale.t('recorders.url') }}</span>
          <input
            name="url"
            [(ngModel)]="url"
            autocomplete="off"
            placeholder="udp://239.1.1.1:5000"
          />
        </label>
        <p class="muted">{{ locale.t('recorders.newHint') }}</p>
        @if (createError()) {
          <p class="error" role="alert">{{ createError() }}</p>
        }
        <button type="submit" [disabled]="busy() || !name.trim() || !url.trim()">
          {{ locale.t('admin.create') }}
        </button>
      </form>
    </details>

    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    } @else if (recorders().length === 0) {
      <p class="muted">{{ locale.t('recorders.none') }}</p>
    } @else {
      <ul class="items">
        @for (r of recorders(); track r.id) {
          <li>
            <button type="button" (click)="open(r)">
              <span class="title">{{ r.name }}</span>
              <span class="muted">{{ windows(r) }}</span>
              @if (!r.enabled) {
                <span class="state" data-state="disabled">{{
                  locale.t('recorders.disabled')
                }}</span>
              }
            </button>
          </li>
        }
      </ul>
    }
  `,
  styleUrl: '../admin/admin-view.scss',
})
export class RecordersView {
  readonly recorders = input.required<readonly Recorder[]>();
  readonly error = input<string | null>(null);
  readonly created = output<Recorder>();

  private readonly api = inject(RecordersService);
  private readonly editors = inject(EditorStore);
  protected readonly locale = inject(LocaleService);

  protected readonly creating = signal(false);
  protected readonly busy = signal(false);
  protected readonly createError = signal<string | null>(null);
  protected name = '';
  protected url = '';

  protected windows(r: Recorder): string {
    return `${describeWindows(r.windows)} (${r.timezone})`;
  }

  /**
   * A new recorder starts DISABLED, every day all day, hourly files, in this browser's zone: it
   * records nothing until someone has set its windows and switched it on in its tab. Starting it
   * recording at once, 24/7, from a name and a URL would be the surprising default.
   */
  protected create(): void {
    const name = this.name.trim();
    const url = this.url.trim();
    if (!name || !url || this.busy()) return;
    this.busy.set(true);
    this.createError.set(null);
    const body = inputOf({
      name,
      url,
      passphraseSecret: '',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      windows: [allDay()],
      fileMinutes: 60,
      padSeconds: 5,
      enabled: false,
    });
    this.api.create(body).subscribe({
      next: (recorder) => {
        this.name = '';
        this.url = '';
        this.busy.set(false);
        this.creating.set(false);
        this.created.emit(recorder);
        this.open(recorder);
      },
      error: (err: { error?: { message?: string } }) => {
        this.createError.set(err.error?.message ?? this.locale.t('admin.createError'));
        this.busy.set(false);
      },
    });
  }

  protected open(r: Recorder): void {
    openRecorder(this.editors, r);
  }
}
