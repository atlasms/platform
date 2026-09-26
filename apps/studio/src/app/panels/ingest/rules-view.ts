import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { AcceptanceRuleSet, Watcher } from '../../core/generated/rim.types.ts';
import { LocaleService } from '../../core/locale.service.ts';
import { RulesService } from '../../core/rules.service.ts';
import { openRuleSet } from '../../editors/rule-set-editor.ts';
import { describeScope } from '../../editors/rule-set.model.ts';
import { EditorStore } from '../../workbench/editor.store.ts';

/**
 * The Ingest panel's Rules view (EP-15.3 in Studio): the channel's acceptance rule sets — what
 * each applies to, how many rules, whether it is on — and a new one. A set opens as an EDITOR TAB
 * (rule-set-editor.ts). `ingest:admin`. The watchers come from the panel, to name a set scoped to
 * one watcher by the watcher's name.
 */
@Component({
  selector: 'atlas-rules-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <details class="new" [open]="creating()">
      <summary (click)="creating.set(!creating()); $event.preventDefault()">
        {{ locale.t('rules.new') }}
      </summary>
      <form (ngSubmit)="create()">
        <label>
          <span>{{ locale.t('rules.name') }}</span>
          <input name="name" [(ngModel)]="name" autocomplete="off" required />
        </label>
        @if (createError()) {
          <p class="error" role="alert">{{ createError() }}</p>
        }
        <button type="submit" [disabled]="busy() || !name.trim()">
          {{ locale.t('admin.create') }}
        </button>
      </form>
    </details>

    <p class="muted">{{ locale.t('rules.why') }}</p>
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    } @else if (loading()) {
      <p class="muted">{{ locale.t('admin.loading') }}</p>
    } @else if (sets().length === 0) {
      <p class="muted">{{ locale.t('rules.none') }}</p>
    } @else {
      <ul class="items">
        @for (s of sets(); track s.id) {
          <li>
            <button type="button" (click)="open(s)">
              <span class="title">{{ s.name }}</span>
              <span class="muted">{{ scopeOf(s) }}</span>
              <span class="state">{{ s.rules.length }} {{ locale.t('rules.count') }}</span>
              @if (!s.enabled) {
                <span class="state" data-state="disabled">{{ locale.t('rules.disabled') }}</span>
              }
            </button>
          </li>
        }
      </ul>
    }
  `,
  styleUrl: '../admin/admin-view.scss',
})
export class RulesView {
  readonly watchers = input<readonly Watcher[]>([]);

  private readonly api = inject(RulesService);
  private readonly editors = inject(EditorStore);
  protected readonly locale = inject(LocaleService);

  protected readonly sets = signal<AcceptanceRuleSet[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly creating = signal(false);
  protected readonly busy = signal(false);
  protected readonly createError = signal<string | null>(null);
  protected name = '';

  private readonly watcherNames = computed(
    () => new Map(this.watchers().map((w) => [w.id, w.name])),
  );

  constructor() {
    this.loading.set(true);
    this.api.list().subscribe({
      next: (sets) => {
        this.sets.set(sets);
        this.loading.set(false);
      },
      error: () => {
        this.error.set(this.locale.t('admin.loadError'));
        this.loading.set(false);
      },
    });
  }

  protected scopeOf(s: AcceptanceRuleSet): string {
    return describeScope(
      s.scope,
      (k) => this.locale.t(k),
      (id) => this.watcherNames().get(id),
    );
  }

  /** An empty set applying to every job — it holds nothing until it has rules — then opened. */
  protected create(): void {
    const name = this.name.trim();
    if (!name || this.busy()) return;
    this.busy.set(true);
    this.createError.set(null);
    this.api.create({ name, scope: {}, rules: [], enabled: true }).subscribe({
      next: (set) => {
        this.sets.update((list) => [...list, set]);
        this.name = '';
        this.busy.set(false);
        this.creating.set(false);
        this.open(set);
      },
      error: (err: { error?: { message?: string } }) => {
        this.createError.set(err.error?.message ?? this.locale.t('admin.createError'));
        this.busy.set(false);
      },
    });
  }

  protected open(set: AcceptanceRuleSet): void {
    openRuleSet(this.editors, set);
  }
}
