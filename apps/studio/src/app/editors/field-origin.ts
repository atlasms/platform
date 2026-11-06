import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import type { Asset } from '../core/generated/mam.types.ts';
import { LocaleService } from '../core/locale.service.ts';

/**
 * Where an asset field's value came from (EP-27.5, FR-MAM-8; mam.md §13u), shown under the field.
 *
 * - A value a PERSON set says nothing — that is the ordinary case.
 * - A measured or AI value says so (`From the media file`, `Suggested by AI · 82%`), with who and when
 *   in its tooltip.
 * - A value MAM held beside a person's — it never writes over one — is offered: *Use this* puts it in
 *   the form (the editor's save is what takes it, and saving settles it); *Dismiss* drops it.
 *   Both are offered only to someone who may edit the field; MAM decides either way.
 */
@Component({
  selector: 'atlas-field-origin',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (origin(); as o) {
      <p class="origin" [title]="o.by + ' · ' + o.at">{{ label(o.source, o.confidence) }}</p>
    }
    @if (held(); as h) {
      <p class="held" role="status" [title]="h.by + ' · ' + h.at">
        <span
          >{{ label(h.source, h.confidence) }}: <strong>{{ show(h.value) }}</strong></span
        >
        @if (canEdit()) {
          <button type="button" (click)="use.emit(h.value)">
            {{ locale.t('provenance.use') }}
          </button>
          <button type="button" (click)="dismiss.emit()">
            {{ locale.t('provenance.dismiss') }}
          </button>
        }
      </p>
    }
  `,
  styles: `
    :host {
      display: block;
      grid-column: 1 / -1;
      margin-block-start: calc(-1 * var(--space-2));
    }
    :host:empty {
      display: none;
    }
    p {
      margin: 0;
      font-size: 0.85em;
      color: var(--color-fg-muted);
    }
    .held {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-1) var(--space-2);
      border-radius: var(--radius-md);
      background: var(--color-info-bg);
      color: var(--color-fg);
    }
  `,
})
export class FieldOrigin {
  protected readonly locale = inject(LocaleService);

  readonly asset = input.required<Asset>();
  readonly field = input.required<string>();
  readonly canEdit = input(false);
  /** The held value, to be put in the form. */
  readonly use = output<unknown>();
  readonly dismiss = output<void>();

  /** The field's provenance, when it is not a person's. */
  protected readonly origin = computed(() => {
    const p = this.asset().provenance?.[this.field()];
    return p && p.source !== 'user' ? p : undefined;
  });

  protected readonly held = computed(() => this.asset().derived?.[this.field()]);

  protected label(source: string, confidence?: number): string {
    const text = this.locale.t(`provenance.${source}`);
    return confidence === undefined ? text : `${text} · ${Math.round(confidence * 100)}%`;
  }

  protected show(value: unknown): string {
    return typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : JSON.stringify(value);
  }
}
