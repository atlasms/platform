import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import {
  validateWrite,
  type ScopeLevel,
  type SettingDescriptor as Descriptor,
  type SettingValue,
} from '@atlas/reference';
import type { Observable } from 'rxjs';
import type { SettingLevel, SettingView } from '../../core/generated/mam.types.ts';
import { LocaleService } from '../../core/locale.service.ts';
import { SETTINGS_AREAS, SettingsService, type SettingsArea } from '../../core/settings.service.ts';

/** One setting as the view holds it: what the owner said, and a draft per writable level. */
interface Row {
  area: SettingsArea;
  view: SettingView;
  drafts: Partial<Record<SettingLevel, string>>;
}

/** The controls a descriptor type is edited with. Everything not listed is free text. */
type Control = 'checkbox' | 'number' | 'select' | 'many' | 'json' | 'text' | 'secret';

/**
 * The Admin panel's Settings view (EP-33.3, FR-CFG-4/5; configuration-and-reference-data.md
 * §2.4–2.5): GENERATED from each owner's descriptors — no form is written per setting. A setting
 * shows what it resolves to and where that comes from (the code default, the platform, the
 * channel, the person), and offers an editor for each level the caller may write, validated in the
 * browser by the SAME `@atlas/reference` rules the owner enforces. "Reset to inherited" drops a
 * level back to the next one up. Every write is over the level's version; a 409 reloads.
 *
 * Revealed by `config:read`/`config:admin` (admin-panel.ts); which levels are editable is the
 * owner's answer (`writable`), not a client-side check.
 */
@Component({
  selector: 'atlas-settings-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
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
    } @else if (rows().length === 0) {
      <p class="muted">{{ locale.t('settings.none') }}</p>
    } @else {
      <ul class="items">
        @for (r of rows(); track r.area + '.' + r.view.key) {
          <li class="setting" [attr.data-key]="r.area + '.' + r.view.key">
            <div class="row">
              <span class="title">{{ r.view.descriptor.label ?? r.view.key }}</span>
              <code class="muted">{{ r.area }}.{{ r.view.key }}</code>
              @if (r.view.descriptor.restart) {
                <span class="state" data-state="disabled">{{ locale.t('settings.restart') }}</span>
              }
            </div>
            @if (r.view.descriptor.description) {
              <p class="muted">{{ r.view.descriptor.description }}</p>
            }
            <p class="resolved">
              <span>{{ locale.t('settings.current') }}</span>
              <strong class="value">{{ shown(r.view.resolved) }}</strong>
              <span class="origin muted">{{ originOf(r.view) }}</span>
            </p>

            @for (level of r.view.writable; track level) {
              <form
                class="row level"
                [attr.data-level]="level"
                (submit)="$event.preventDefault(); save(r, level)"
              >
                <span class="level-name">{{ locale.t('settings.level.' + level) }}</span>
                @switch (control(r.view.descriptor)) {
                  @case ('checkbox') {
                    <input
                      type="checkbox"
                      [name]="level"
                      [checked]="r.drafts[level] === 'true'"
                      (change)="draft(r, level, checked($event) ? 'true' : 'false')"
                    />
                  }
                  @case ('number') {
                    <input
                      type="number"
                      [name]="level"
                      [attr.min]="r.view.descriptor.min ?? null"
                      [attr.max]="r.view.descriptor.max ?? null"
                      [value]="r.drafts[level] ?? ''"
                      (input)="draft(r, level, text($event))"
                    />
                  }
                  @case ('select') {
                    <select [name]="level" (change)="draft(r, level, text($event))">
                      <option value="" [selected]="!r.drafts[level]">—</option>
                      @for (o of r.view.descriptor.options ?? []; track $index) {
                        <option
                          [value]="'' + o.value"
                          [selected]="r.drafts[level] === '' + o.value"
                        >
                          {{ o.label ?? o.value }}
                        </option>
                      }
                    </select>
                  }
                  @case ('json') {
                    <textarea
                      [name]="level"
                      rows="3"
                      [value]="r.drafts[level] ?? ''"
                      (input)="draft(r, level, text($event))"
                    ></textarea>
                  }
                  @case ('secret') {
                    <input
                      type="password"
                      autocomplete="off"
                      [name]="level"
                      [placeholder]="locale.t('settings.secret')"
                      [value]="r.drafts[level] ?? ''"
                      (input)="draft(r, level, text($event))"
                    />
                  }
                  @default {
                    <input
                      type="text"
                      autocomplete="off"
                      [name]="level"
                      [placeholder]="placeholder(r.view.descriptor)"
                      [value]="r.drafts[level] ?? ''"
                      (input)="draft(r, level, text($event))"
                    />
                  }
                }
                <button type="submit" [disabled]="busy() || problem(r, level) !== null">
                  {{ locale.t('admin.save') }}
                </button>
                @if (r.view.levels[level]?.set) {
                  <button type="button" class="link" [disabled]="busy()" (click)="reset(r, level)">
                    {{ locale.t('settings.reset') }}
                  </button>
                }
              </form>
              @if (problem(r, level); as p) {
                <p class="error field" [attr.data-level]="level">{{ p }}</p>
              }
            }
          </li>
        }
      </ul>
    }
  `,
  styleUrl: './admin-view.scss',
  styles: `
    .setting .row {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1);
      align-items: center;
    }
    .resolved {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1);
      align-items: baseline;
      margin: var(--space-1) 0;
      font-size: 0.8125rem;
    }
    .level-name {
      min-inline-size: 6rem;
      font-size: 0.75rem;
      color: var(--color-fg-muted);
    }
    .field {
      margin: 0 0 var(--space-1);
      font-size: 0.75rem;
    }
  `,
})
export class SettingsView {
  private readonly api = inject(SettingsService);
  protected readonly locale = inject(LocaleService);

  protected readonly rows = signal<Row[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  /** The owner's 422, per `area.key@level`, until that draft changes. */
  private readonly refused = signal<Record<string, string>>({});

  constructor() {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);
    const collected: Row[] = [];
    let pending = SETTINGS_AREAS.length;
    for (const area of SETTINGS_AREAS) {
      this.api.list(area).subscribe({
        next: (view) => {
          for (const s of view.settings) collected.push({ area, view: s, drafts: draftsOf(s) });
          if (--pending === 0) this.done(collected);
        },
        error: () => {
          this.error.set(this.locale.t('admin.loadError'));
          if (--pending === 0) this.done(collected);
        },
      });
    }
  }

  private done(rows: Row[]): void {
    rows.sort((a, b) =>
      `${a.area}.${a.view.descriptor.group ?? ''}.${a.view.key}`.localeCompare(
        `${b.area}.${b.view.descriptor.group ?? ''}.${b.view.key}`,
      ),
    );
    this.rows.set(rows);
    this.refused.set({});
    this.loading.set(false);
  }

  /** A form control's text, from its event — no forms module: the form is generated. */
  protected text(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected control(d: SettingView['descriptor']): Control {
    if (d.sensitive) return 'secret';
    switch (d.type) {
      case 'boolean':
        return 'checkbox';
      case 'int':
      case 'number':
        return 'number';
      case 'oneOf':
        return 'select';
      case 'manyOf':
      case 'json':
        return 'json';
      default:
        return 'text';
    }
  }

  protected placeholder(d: SettingView['descriptor']): string {
    if (d.type === 'duration') return 'P30D';
    if (d.type === 'cron') return '0 3 * * *';
    return '';
  }

  /** The resolved value as a person reads it; "not set" for null, masked when sensitive. */
  protected shown(resolved: SettingView['resolved']): string {
    if (resolved.redacted) return '••••';
    const v = resolved.value as SettingValue | undefined;
    if (v === null || v === undefined || v === '') return this.locale.t('settings.unset');
    return typeof v === 'string' ? v : JSON.stringify(v);
  }

  protected originOf(view: SettingView): string {
    return this.locale.t(`settings.origin.${view.resolved.origin}`);
  }

  protected draft(r: Row, level: SettingLevel, text: unknown): void {
    const drafts = {
      ...r.drafts,
      [level]: text === null || text === undefined ? '' : String(text),
    };
    this.rows.set(this.rows().map((x) => (x === r ? { ...r, drafts } : x)));
    const key = `${r.area}.${r.view.key}@${level}`;
    if (key in this.refused()) {
      const { [key]: _gone, ...rest } = this.refused();
      this.refused.set(rest);
    }
  }

  /**
   * What is wrong with a level's draft — the owner's own rules, run here (FR-CFG-4), or the
   * owner's 422 for it. `null` when it may be saved. An empty draft is not a value to save; that is
   * what Reset is for.
   */
  protected problem(r: Row, level: SettingLevel): string | null {
    const refused = this.refused()[`${r.area}.${r.view.key}@${level}`];
    if (refused) return refused;
    const text = r.drafts[level] ?? '';
    if (text.trim() === '') return this.locale.t('settings.empty');
    const parsed = parse(r.view.descriptor, text);
    if (!parsed.ok) return this.locale.t('settings.notJson');
    const check = validateWrite(
      r.view.descriptor as unknown as Descriptor,
      parsed.value,
      level as ScopeLevel,
    );
    return check.valid ? null : (check.problems[0]?.message ?? this.locale.t('admin.writeError'));
  }

  protected save(r: Row, level: SettingLevel): void {
    if (this.busy() || this.problem(r, level) !== null) return;
    const parsed = parse(r.view.descriptor, r.drafts[level] ?? '');
    if (!parsed.ok) return;
    this.write(
      r,
      level,
      this.api.put(
        r.area,
        r.view.key,
        { level, value: parsed.value },
        r.view.levels[level]?.version,
      ),
    );
  }

  protected reset(r: Row, level: SettingLevel): void {
    if (this.busy()) return;
    this.write(r, level, this.api.reset(r.area, r.view.key, level, r.view.levels[level]?.version));
  }

  private write(r: Row, level: SettingLevel, request: Observable<SettingView>): void {
    this.busy.set(true);
    this.error.set(null);
    request.subscribe({
      next: (view) => {
        this.busy.set(false);
        // The owner's answer IS the new state: no reload, and the drafts follow it.
        this.rows.set(
          this.rows().map((x) => (x === r ? { area: r.area, view, drafts: draftsOf(view) } : x)),
        );
      },
      error: (err: {
        status?: number;
        error?: { message?: string; details?: { problems?: { message: string }[] } };
      }) => {
        this.busy.set(false);
        if (err.status === 409) {
          // Someone else changed this level since it was read: show theirs, keep nobody's draft.
          this.load();
          this.error.set(this.locale.t('settings.conflict'));
          return;
        }
        const problem = err.error?.details?.problems?.[0]?.message;
        if (err.status === 422 && problem) {
          this.refused.set({ ...this.refused(), [`${r.area}.${r.view.key}@${level}`]: problem });
          return;
        }
        this.error.set(err.error?.message ?? this.locale.t('admin.writeError'));
      },
    });
  }
}

/** Each writable level's draft starts at the value stored there (never a sensitive one). */
function draftsOf(view: SettingView): Partial<Record<SettingLevel, string>> {
  const drafts: Partial<Record<SettingLevel, string>> = {};
  for (const level of view.writable) {
    const stored = view.levels[level];
    const value = stored?.set && !stored.redacted ? (stored.value as SettingValue) : undefined;
    drafts[level] =
      value === undefined || value === null
        ? ''
        : typeof value === 'string'
          ? value
          : JSON.stringify(value);
  }
  return drafts;
}

/** A draft as the descriptor's type: numbers and booleans typed, lists and JSON parsed. */
function parse(
  d: SettingView['descriptor'],
  text: string,
): { ok: true; value: SettingValue } | { ok: false } {
  switch (d.type) {
    case 'int':
    case 'number':
      return { ok: true, value: Number(text) };
    case 'boolean':
      return { ok: true, value: text === 'true' };
    case 'oneOf': {
      // An option's value keeps its own type: a numeric option is sent as a number.
      const option = (d.options ?? []).find((o) => String(o.value) === text);
      return { ok: true, value: (option?.value as SettingValue | undefined) ?? text };
    }
    case 'manyOf':
    case 'json':
      try {
        return { ok: true, value: JSON.parse(text) as SettingValue };
      } catch {
        return { ok: false };
      }
    default:
      return { ok: true, value: text };
  }
}
