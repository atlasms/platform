import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { LocaleService } from '../core/locale.service.ts';
import {
  entriesOf,
  fieldKind,
  labelOf,
  optionsOf,
  parseVersion,
  propertiesOf,
  renameKey,
  withProperty,
  type Schema,
} from './schema-form.model.ts';

/**
 * One field of a property panel, rendered from its JSON Schema (EP-23.5; DSL doc §12.3) — and,
 * for an object, each of its properties as a field of its own, recursively. The value flows in;
 * every edit flows out as the field's WHOLE new value (`valueChange`), so the parent replaces
 * rather than patches and the definition stays one immutable signal.
 *
 * FEEL fields are a monospace input for now — the expression editor with parse hints is 23.6.
 */
let fieldCount = 0;

@Component({
  selector: 'atlas-schema-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (kind()) {
      @case ('object') {
        <fieldset [class.nested]="depth() > 0">
          @if (label()) {
            <legend>
              {{ label() }}
              @if (required()) {
                <span class="req" aria-hidden="true">*</span>
              }
            </legend>
          }
          @if (description(); as d) {
            @if (depth() === 0) {
              <p class="hint">{{ d }}</p>
            }
          }
          @for (p of properties(); track p.key) {
            <atlas-schema-field
              [schema]="p.schema"
              [value]="child(p.key)"
              [label]="labelOf(p.key)"
              [required]="p.required"
              [choices]="choices()"
              [readOnly]="readOnly()"
              [depth]="depth() + 1"
              (valueChange)="setChild(p.key, $event)"
            />
          }
        </fieldset>
      }
      @case ('map') {
        <fieldset class="nested">
          <legend>
            {{ label() }}
            @if (required()) {
              <span class="req" aria-hidden="true">*</span>
            }
          </legend>
          @for (row of rows(); track $index) {
            <div class="row">
              <input
                class="key"
                [value]="row[0]"
                [disabled]="readOnly()"
                [attr.aria-label]="label() + ' — ' + locale.t('schemaForm.key')"
                (change)="rename(row[0], $any($event.target).value)"
              />
              <input
                class="feel"
                [value]="row[1]"
                [disabled]="readOnly()"
                [attr.aria-label]="label() + ' ' + row[0]"
                (input)="setChild(row[0], $any($event.target).value, true)"
              />
              @if (!readOnly()) {
                <button type="button" class="link" (click)="setChild(row[0], undefined)">
                  {{ locale.t('schemaForm.remove') }}
                </button>
              }
            </div>
          }
          @if (!readOnly()) {
            <button type="button" class="link" (click)="addRow()">
              {{ locale.t('schemaForm.addRow') }}
            </button>
          }
        </fieldset>
      }
      @default {
        <div class="field" [title]="description() ?? ''">
          <label class="name" [for]="id">
            {{ label() }}
            @if (required()) {
              <span class="req" aria-hidden="true">*</span>
            }
          </label>
          @switch (kind()) {
            @case ('boolean') {
              <input
                [id]="id"
                type="checkbox"
                [checked]="value() === true"
                [disabled]="readOnly()"
                (change)="emit($any($event.target).checked ? true : undefined)"
              />
            }
            @case ('number') {
              <input
                [id]="id"
                type="number"
                [value]="value() ?? ''"
                [disabled]="readOnly()"
                (input)="emitNumber($any($event.target).value)"
              />
            }
            @case ('enum') {
              <select [id]="id" [disabled]="readOnly()" (change)="emit($any($event.target).value)">
                @if (!required()) {
                  <option value="" [selected]="value() === undefined">—</option>
                }
                @for (o of options(); track o) {
                  <option [value]="o" [selected]="value() === o">{{ o }}</option>
                }
              </select>
            }
            @case ('choice') {
              <select [id]="id" [disabled]="readOnly()" (change)="emit($any($event.target).value)">
                <option value="" [selected]="!value()">—</option>
                @for (o of options(); track o) {
                  <option [value]="o" [selected]="value() === o">{{ o }}</option>
                }
              </select>
            }
            @case ('version') {
              <input
                [id]="id"
                [value]="value() ?? ''"
                [disabled]="readOnly()"
                placeholder="latest"
                (input)="emitVersion($any($event.target).value)"
              />
            }
            @case ('json') {
              <textarea
                [id]="id"
                class="feel"
                rows="3"
                [value]="json()"
                [disabled]="readOnly()"
                (change)="emitJson($any($event.target).value)"
              ></textarea>
            }
            @default {
              <input
                [id]="id"
                [class.feel]="kind() === 'feel'"
                [value]="value() ?? ''"
                [disabled]="readOnly()"
                [placeholder]="placeholder()"
                (input)="emit($any($event.target).value)"
              />
            }
          }
          @if (problem()) {
            <span class="problem" role="alert">{{ locale.t(problem()!) }}</span>
          }
        </div>
      }
    }
  `,
  styles: `
    :host {
      display: block;
    }
    fieldset {
      margin: 0;
      padding: 0;
      border: none;
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
    }
    fieldset.nested {
      padding-inline-start: var(--space-2);
      border-inline-start: 2px solid var(--color-border);
    }
    legend {
      padding: 0;
      margin-block-end: var(--space-1);
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--color-fg-muted);
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 2px;
      font-size: 0.75rem;
    }
    .name {
      color: var(--color-fg-muted);
    }
    .req {
      color: var(--color-danger);
      margin-inline-start: 2px;
    }
    input,
    select,
    textarea {
      min-inline-size: 0;
      padding: var(--space-1);
      color: inherit;
      background: var(--color-bg-hover);
      border: 1px solid transparent;
      border-radius: var(--radius-md);
      font: inherit;
    }
    input[type='checkbox'] {
      align-self: flex-start;
    }
    .feel {
      font-family: ui-monospace, monospace;
    }
    .row {
      display: grid;
      grid-template-columns: 1fr 1.4fr auto;
      gap: var(--space-1);
    }
    .hint {
      margin: 0;
      font-size: 0.75rem;
      color: var(--color-fg-muted);
    }
    button.link {
      align-self: flex-start;
      padding: 0;
      color: var(--color-accent);
      background: none;
      border: none;
      font: inherit;
      font-size: 0.75rem;
      cursor: pointer;
    }
    .problem {
      color: var(--color-danger);
    }
  `,
})
export class SchemaField {
  readonly schema = input.required<Schema>();
  readonly value = input<unknown>(undefined);
  readonly label = input('');
  readonly required = input(false);
  /** The palette entry's closed lists, for a field marked `x-choices`. */
  readonly choices = input<Record<string, unknown> | undefined>(undefined);
  readonly readOnly = input(false);
  readonly depth = input(0);
  /** The field's whole new value — `undefined` when it was emptied. */
  readonly valueChange = output<unknown>();

  protected readonly locale = inject(LocaleService);
  protected readonly labelOf = labelOf;
  /** Ties the field's label to its control — unique per instance, not per schema key. */
  protected readonly id = `schema-field-${++fieldCount}`;
  /** A locale key naming what is wrong with what was typed, until it is fixed. */
  protected readonly problem = signal<string | null>(null);

  protected readonly kind = computed(() => fieldKind(this.schema()));
  protected readonly properties = computed(() => propertiesOf(this.schema()));
  protected readonly options = computed(() =>
    optionsOf(this.schema(), this.choices(), this.value()),
  );
  protected readonly rows = computed(() => entriesOf(this.value()));
  protected readonly description = computed(() => {
    const d = this.schema()['description'];
    return typeof d === 'string' ? d : null;
  });
  protected readonly json = computed(() =>
    this.value() === undefined ? '' : JSON.stringify(this.value(), null, 2),
  );
  protected readonly placeholder = computed(() =>
    this.kind() === 'feel' ? '= …' : this.kind() === 'duration' ? 'PT30M' : '',
  );

  protected child(key: string): unknown {
    const v = this.value();
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[key] : undefined;
  }

  /** A property or a mapping row changed; `keepEmpty` keeps a mapping row whose value is blank. */
  protected setChild(key: string, value: unknown, keepEmpty = false): void {
    const next =
      keepEmpty && value === ''
        ? { ...((this.value() as Record<string, unknown> | undefined) ?? {}), [key]: '' }
        : withProperty(this.value(), key, value);
    this.valueChange.emit(Object.keys(next).length === 0 && !this.required() ? undefined : next);
  }

  protected rename(from: string, to: string): void {
    this.valueChange.emit(renameKey(this.value(), from, to.trim()));
  }

  /** A new mapping row: a target path to fill in, and a FEEL expression to give it. */
  protected addRow(): void {
    let n = 1;
    const current = (this.value() as Record<string, unknown> | undefined) ?? {};
    while (`vars.new${n}` in current) n++;
    this.valueChange.emit({ ...current, [`vars.new${n}`]: '= ' });
  }

  protected emit(value: unknown): void {
    this.problem.set(null);
    this.valueChange.emit(value === '' ? undefined : value);
  }

  protected emitNumber(text: string): void {
    this.emit(text.trim() === '' ? undefined : Number(text));
  }

  protected emitVersion(text: string): void {
    const v = parseVersion(text);
    if (v === null) {
      this.problem.set('schemaForm.badVersion');
      return;
    }
    this.emit(v);
  }

  protected emitJson(text: string): void {
    if (text.trim() === '') return this.emit(undefined);
    try {
      this.emit(JSON.parse(text));
    } catch {
      this.problem.set('schemaForm.badJson');
    }
  }
}
