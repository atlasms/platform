import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
  type OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { AcceptanceRuleSet, Watcher } from '../core/generated/rim.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { PermissionService } from '../core/permission.service.ts';
import { NO_PROBLEMS, type Problems } from '../core/problems.ts';
import { RulesService } from '../core/rules.service.ts';
import { WatchersService } from '../core/watchers.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import {
  ON_FAIL,
  RULE_KINDS,
  SOURCE_KINDS,
  draftOfSet,
  inputOfSet,
  newRule,
  placeRuleSetProblems,
  type RuleDraft,
  type RuleSetDraft,
} from './rule-set.model.ts';

/**
 * An acceptance rule set, as an editor tab (EP-15.3 in Studio): which jobs it applies to — every
 * job, a source kind, or one folder watcher by name (EP-15.2) — and its rules, each with the one
 * parameter its kind reads and what failing it does. The worst failure decides: `reject` beats
 * `quarantine`, and a rule that cannot be checked yet (an aspect ratio before the probe) holds the
 * job for a person rather than passing it — the page says so, because that is the surprising one.
 *
 * Saved whole, as RIM replaces it. Rule ids travel with the rules, so a job held by a rule still
 * names it after the set is edited. RIM's 422 lands under the rule it names.
 */
@Component({
  selector: 'atlas-rule-set-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    @if (loadError()) {
      <p class="error" role="alert">{{ loadError() }}</p>
    } @else if (!set()) {
      <p class="muted">{{ locale.t('admin.loading') }}</p>
    } @else {
      <header class="head">
        <h2>{{ set()!.name }}</h2>
        <span class="state">v{{ set()!.version }}</span>
        @if (!set()!.enabled) {
          <span class="state" data-state="disabled">{{ locale.t('rules.disabled') }}</span>
        }
      </header>
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
      @for (m of problems().general; track m) {
        <p class="error" role="alert">{{ m }}</p>
      }

      <form (ngSubmit)="save()">
        <fieldset [disabled]="readOnly() || busy()">
          <div class="fields">
            <label>
              <span>{{ locale.t('rules.name') }}</span>
              <input name="name" [ngModel]="d().name" (ngModelChange)="set$('name', $event)" />
              @for (m of problemsFor('name'); track m) {
                <small class="error">{{ m }}</small>
              }
            </label>
            <label>
              <span>{{ locale.t('rules.appliesTo') }}</span>
              <select name="scope" [ngModel]="d().scope" (ngModelChange)="set$('scope', $event)">
                <option value="all">{{ locale.t('rules.scope.all') }}</option>
                @for (k of sourceKinds; track k) {
                  <option [value]="'kind:' + k">{{ locale.t('rules.scope.kind.' + k) }}</option>
                }
                @for (w of watchers(); track w.id) {
                  <option [value]="'source:' + w.id">
                    {{ locale.t('rules.scope.watcher') }} {{ w.name }}
                  </option>
                }
                @if (unknownSource(); as id) {
                  <option [value]="'source:' + id">{{ id }}</option>
                }
              </select>
            </label>
            <label class="check">
              <input
                type="checkbox"
                name="enabled"
                [ngModel]="d().enabled"
                (ngModelChange)="set$('enabled', $event)"
              />
              <span>{{ locale.t('rules.enabled') }}</span>
            </label>
          </div>

          <section>
            <h3>{{ locale.t('rules.rules') }}</h3>
            <p class="muted">{{ locale.t('rules.worstWins') }}</p>
            @if (d().rules.length === 0) {
              <p class="muted">{{ locale.t('rules.noRules') }}</p>
            }
            <ol class="rules">
              @for (rule of d().rules; track rule.id; let i = $index) {
                <li>
                  <div class="rule">
                    <select
                      [name]="'kind' + i"
                      [attr.aria-label]="locale.t('rules.kindLabel')"
                      [ngModel]="rule.kind"
                      (ngModelChange)="setRule(i, 'kind', $event)"
                    >
                      @for (k of kinds; track k) {
                        <option [value]="k">{{ locale.t('rules.kind.' + k) }}</option>
                      }
                    </select>
                    @switch (rule.kind) {
                      @case ('container') {
                        <input
                          [name]="'containers' + i"
                          placeholder="mxf, mov"
                          [attr.aria-label]="locale.t('rules.containers')"
                          [ngModel]="rule.containers"
                          (ngModelChange)="setRule(i, 'containers', $event)"
                        />
                      }
                      @case ('aspectRatio') {
                        <input
                          [name]="'aspect' + i"
                          placeholder="16:9"
                          [attr.aria-label]="locale.t('rules.kind.aspectRatio')"
                          [ngModel]="rule.aspectRatio"
                          (ngModelChange)="setRule(i, 'aspectRatio', $event)"
                        />
                      }
                      @default {
                        <input
                          type="number"
                          min="0"
                          step="any"
                          [name]="'mib' + i"
                          [attr.aria-label]="locale.t('rules.mebibytes')"
                          [ngModel]="rule.mebibytes"
                          (ngModelChange)="setRule(i, 'mebibytes', $event)"
                        />
                        <span class="unit">MiB</span>
                      }
                    }
                    <select
                      [name]="'onFail' + i"
                      [attr.aria-label]="locale.t('rules.onFailLabel')"
                      [ngModel]="rule.onFail"
                      (ngModelChange)="setRule(i, 'onFail', $event)"
                    >
                      @for (o of onFail; track o) {
                        <option [value]="o">{{ locale.t('rules.onFail.' + o) }}</option>
                      }
                    </select>
                    <input
                      class="label"
                      [name]="'label' + i"
                      [placeholder]="locale.t('rules.label')"
                      [attr.aria-label]="locale.t('rules.label')"
                      [ngModel]="rule.label"
                      (ngModelChange)="setRule(i, 'label', $event)"
                    />
                    @if (!readOnly()) {
                      <button type="button" class="link" (click)="removeRule(i)">
                        {{ locale.t('admin.remove') }}
                      </button>
                    }
                  </div>
                  @if (rule.kind === 'aspectRatio') {
                    <small class="muted">{{ locale.t('rules.aspectBeforeProbe') }}</small>
                  }
                  @for (m of problemsFor('rules.' + i); track m) {
                    <small class="error">{{ m }}</small>
                  }
                </li>
              }
            </ol>
            @if (!readOnly()) {
              <button type="button" class="link" (click)="addRule()">
                {{ locale.t('rules.addRule') }}
              </button>
            }
          </section>

          @if (!readOnly()) {
            <div class="row actions">
              <button type="submit" [disabled]="busy() || !dirty()">
                {{ locale.t('admin.save') }}
              </button>
              <button type="button" class="link" [disabled]="busy() || !dirty()" (click)="revert()">
                {{ locale.t('admin.revert') }}
              </button>
            </div>
          }
        </fieldset>
      </form>

      @if (!readOnly()) {
        <section>
          <h3>{{ locale.t('admin.danger') }}</h3>
          <div class="row">
            <button type="button" class="danger" [disabled]="busy()" (click)="remove()">
              {{ locale.t('rules.delete') }}
            </button>
            <span class="muted">{{ locale.t('rules.deleteWhy') }}</span>
          </div>
        </section>
      }
    }
  `,
  styleUrls: ['./admin-editor.scss'],
  styles: `
    fieldset {
      margin: 0;
      padding: 0;
      border: none;
      min-inline-size: 0;
    }
    .fields {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
      gap: var(--space-2);
      align-items: end;
    }
    .fields label {
      display: grid;
      gap: 2px;
      font-size: 0.75rem;
      color: var(--color-fg-muted);
    }
    label.check {
      display: flex;
      gap: var(--space-1);
      align-items: center;
    }
    .rules {
      margin: 0 0 var(--space-2);
      padding-inline-start: var(--space-4);
      display: grid;
      gap: var(--space-2);
    }
    .rules li {
      display: grid;
      gap: 2px;
    }
    .rule {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1);
      align-items: center;
    }
    .rule .label {
      flex: 1;
      min-inline-size: 8rem;
    }
    .unit {
      font-size: 0.75rem;
      color: var(--color-fg-muted);
    }
    small {
      font-size: 0.75rem;
    }
    .actions {
      margin-block-start: var(--space-3);
    }
  `,
})
export class RuleSetEditor implements OnInit {
  readonly setId = input.required<string>();
  readonly tabId = input.required<string>();

  private readonly api = inject(RulesService);
  private readonly watchersApi = inject(WatchersService);
  private readonly editors = inject(EditorStore);
  private readonly permissions = inject(PermissionService);
  protected readonly locale = inject(LocaleService);

  protected readonly kinds = RULE_KINDS;
  protected readonly onFail = ON_FAIL;
  protected readonly sourceKinds = SOURCE_KINDS;

  protected readonly set = signal<AcceptanceRuleSet | null>(null);
  private readonly draft = signal<RuleSetDraft | null>(null);
  protected readonly watchers = signal<Watcher[]>([]);
  protected readonly loadError = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly problems = signal<Problems>(NO_PROBLEMS);
  protected readonly busy = signal(false);

  protected readonly d = computed(() => this.draft()!);
  /** UX only — RIM enforces `ingest:admin` in the channel. */
  protected readonly readOnly = computed(() => !this.permissions.can('ingest:admin'));
  protected readonly dirty = computed(() => {
    const s = this.set();
    const d = this.draft();
    return (
      !!s && !!d && JSON.stringify(inputOfSet(d)) !== JSON.stringify(inputOfSet(draftOfSet(s)))
    );
  });
  /** A set scoped to a source this page does not list (a watcher since removed from view). */
  protected readonly unknownSource = computed(() => {
    const scope = this.draft()?.scope;
    if (!scope?.startsWith('source:')) return undefined;
    const id = scope.slice(7);
    return this.watchers().some((w) => w.id === id) ? undefined : id;
  });

  ngOnInit(): void {
    this.api.get(this.setId()).subscribe({
      next: (s) => this.adopt(s),
      error: () => this.loadError.set(this.locale.t('admin.loadError')),
    });
    // For the scope select's names. A failure here only means watchers are offered by id.
    this.watchersApi.list().subscribe({ next: (list) => this.watchers.set(list) });
  }

  protected problemsFor(field: string): readonly string[] {
    return this.problems().fields[field] ?? [];
  }

  protected set$<K extends keyof RuleSetDraft>(key: K, value: RuleSetDraft[K]): void {
    this.draft.update((d) => (d ? { ...d, [key]: value } : d));
    this.editors.setDirty(this.tabId(), this.dirty());
  }

  protected setRule<K extends keyof RuleDraft>(index: number, key: K, value: RuleDraft[K]): void {
    this.draft.update((d) =>
      d ? { ...d, rules: d.rules.map((r, i) => (i === index ? { ...r, [key]: value } : r)) } : d,
    );
    this.editors.setDirty(this.tabId(), this.dirty());
  }

  protected addRule(): void {
    this.draft.update((d) => (d ? { ...d, rules: [...d.rules, newRule()] } : d));
    this.editors.setDirty(this.tabId(), this.dirty());
  }

  protected removeRule(index: number): void {
    this.draft.update((d) => (d ? { ...d, rules: d.rules.filter((_, i) => i !== index) } : d));
    this.editors.setDirty(this.tabId(), this.dirty());
  }

  protected revert(): void {
    const s = this.set();
    if (s) this.adopt(s);
  }

  protected save(): void {
    const s = this.set();
    const d = this.draft();
    if (!s || !d || !this.dirty() || this.busy() || this.readOnly()) return;
    this.busy.set(true);
    this.error.set(null);
    this.problems.set(NO_PROBLEMS);
    this.api.replace(s.id, inputOfSet(d)).subscribe({
      next: (saved) => {
        this.busy.set(false);
        this.adopt(saved);
      },
      error: (err: { status?: number; error?: { message?: string } }) => {
        this.busy.set(false);
        const message = err.error?.message;
        if (err.status === 422 && message) this.problems.set(placeRuleSetProblems(message));
        else this.error.set(message ?? this.locale.t('admin.writeError'));
      },
    });
  }

  protected remove(): void {
    const s = this.set();
    if (!s || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.api.delete(s.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.editors.setDirty(this.tabId(), false);
        this.editors.closeTab(this.tabId());
      },
      error: (err: { error?: { message?: string } }) => {
        this.busy.set(false);
        this.error.set(err.error?.message ?? this.locale.t('admin.writeError'));
      },
    });
  }

  private adopt(s: AcceptanceRuleSet): void {
    this.set.set(s);
    this.draft.set(draftOfSet(s));
    this.problems.set(NO_PROBLEMS);
    this.editors.setDirty(this.tabId(), false);
  }
}

/** Open a rule set's tab — here, not in the list view, so the deferred editor stays deferred. */
export function openRuleSet(
  editors: EditorStore,
  set: Pick<AcceptanceRuleSet, 'id' | 'name'>,
): void {
  editors.open({ type: 'rules', resourceId: set.id, title: set.name, icon: '✓' });
}
