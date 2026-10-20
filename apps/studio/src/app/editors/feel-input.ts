import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
  type ElementRef,
} from '@angular/core';
import { LocaleService } from '../core/locale.service.ts';
import { insertAt, judge, snippets, type Snippet } from './feel.model.ts';

let feelCount = 0;

/**
 * A FEEL expression field (EP-23.6; DSL doc §3): the expression, judged as it is typed by the same
 * subset checker publish runs, and the subset's names — the roots, the workflow's declared vars,
 * the allowed functions — offered to insert at the caret. A judgement is a hint, never a block:
 * a draft may hold a broken expression, and publish is the gate.
 */
@Component({
  selector: 'atlas-feel-input',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="feel-input" [attr.data-state]="state()">
      <input
        #box
        class="feel"
        spellcheck="false"
        autocomplete="off"
        [id]="inputId()"
        [value]="value()"
        [disabled]="readOnly()"
        [attr.aria-label]="ariaLabel() || null"
        [attr.aria-invalid]="state() === 'error' ? true : null"
        [attr.aria-describedby]="verdictId"
        placeholder="= …"
        (input)="valueChange.emit($any($event.target).value)"
      />
      <span class="verdict" [id]="verdictId" aria-live="polite">
        @switch (state()) {
          @case ('error') {
            {{ verdict()!.problem!.message }}
          }
          @case ('warning') {
            {{ locale.t('feel.undeclared') }} {{ undeclaredText() }}
          }
          @case ('ok') {
            <span aria-hidden="true">✓</span> {{ locale.t('feel.ok') }}
          }
        }
      </span>
      @if (!readOnly()) {
        <button
          type="button"
          class="link toggle"
          [attr.aria-expanded]="open()"
          (click)="open.set(!open())"
        >
          {{ locale.t('feel.insert') }}
        </button>
        @if (open()) {
          <div class="snippets" role="group" [attr.aria-label]="locale.t('feel.insert')">
            @for (s of offered(); track s.label) {
              <button type="button" [attr.data-kind]="s.kind" (click)="insert(s)">
                {{ s.label }}
              </button>
            }
          </div>
        }
      }
    </div>
  `,
  styles: `
    .feel-input {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    input {
      min-inline-size: 0;
      padding: var(--space-1);
      color: inherit;
      background: var(--color-bg-hover);
      border: 1px solid transparent;
      border-radius: var(--radius-md);
      font-family: ui-monospace, monospace;
      font-size: 0.75rem;
    }
    [data-state='error'] input {
      border-color: var(--color-danger);
    }
    [data-state='warning'] input {
      border-color: var(--color-warning);
    }
    .verdict {
      min-block-size: 1em;
      font-size: 0.6875rem;
      color: var(--color-fg-muted);
    }
    [data-state='error'] .verdict {
      color: var(--color-danger);
    }
    [data-state='warning'] .verdict {
      color: var(--color-warning);
    }
    [data-state='ok'] .verdict {
      color: var(--color-success);
    }
    button.link {
      align-self: flex-start;
      padding: 0;
      color: var(--color-accent);
      background: none;
      border: none;
      font: inherit;
      font-size: 0.6875rem;
      cursor: pointer;
    }
    .snippets {
      display: flex;
      flex-wrap: wrap;
      gap: 2px;
    }
    .snippets button {
      padding: 0 var(--space-1);
      color: inherit;
      background: var(--color-bg-hover);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      font-family: ui-monospace, monospace;
      font-size: 0.6875rem;
      cursor: pointer;
    }
    .snippets [data-kind='var'] {
      border-color: var(--color-accent);
    }
  `,
})
export class FeelInput {
  readonly value = input('');
  readonly readOnly = input(false);
  /** The workflow's declared var names — offered, and checked against what is read. */
  readonly vars = input<readonly string[]>([]);
  /** The control's id, so a surrounding `<label for>` names it. */
  readonly inputId = input<string | null>(null);
  readonly ariaLabel = input('');
  readonly valueChange = output<string>();

  protected readonly locale = inject(LocaleService);
  protected readonly verdictId = `feel-verdict-${++feelCount}`;
  protected readonly open = signal(false);
  private readonly box = viewChild.required<ElementRef<HTMLInputElement>>('box');

  protected readonly verdict = computed(() => judge(this.value(), this.vars()));
  protected readonly state = computed(() => {
    const v = this.verdict();
    if (!v) return 'empty';
    if (v.problem) return 'error';
    return v.undeclared.length > 0 ? 'warning' : 'ok';
  });
  protected readonly undeclaredText = computed(() =>
    (this.verdict()?.undeclared ?? []).map((v) => `vars.${v}`).join(', '),
  );
  protected readonly offered = computed(() => snippets(this.vars()));

  protected insert(s: Snippet): void {
    const el = this.box().nativeElement;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const next = insertAt(el.value, start, end, s.text);
    el.value = next.value;
    el.focus();
    el.setSelectionRange(next.caret, next.caret);
    this.valueChange.emit(next.value);
  }
}
