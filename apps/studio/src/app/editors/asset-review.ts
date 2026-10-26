import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { AssetsService } from '../core/assets.service.ts';
import type { Asset, Verdict } from '../core/generated/mam.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import {
  approvalBody,
  awaitsVerdict,
  badgeOf,
  retentionOf,
  type ExpiryChoice,
} from './review.model.ts';

/**
 * The asset editor's Review section (EP-24.9; review plan WS-H): where the asset stands for air,
 * the verdict to give it, and every verdict it was given.
 *
 * - A verdict is offered on a `ready` asset, and again on an `expired` one (re-review), to a holder
 *   of `asset:approve` — UX only: MAM enforces it, and judges whether the move is legal.
 * - An approval's expiry is the category's default (shown, when the chain sets one — MAM snapshots
 *   it), a date, or permanent. A rejection states its reason (MAM refuses one without) and may set
 *   until when the rejected media is kept, else MAM's policy.
 * - The history is MAM's retained record (EP-24.4), newest first, read again after each verdict.
 */
@Component({
  selector: 'atlas-asset-review',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="review">
      @if (badge(); as b) {
        <p class="badge" [attr.data-tone]="b.tone">
          {{ locale.t(b.key) }}
          @if (b.days !== undefined) {
            {{ b.days }}{{ locale.t('review.days') }}
          }
        </p>
      }

      @if (offered()) {
        <div class="verdict">
          <h3>{{ locale.t('review.giveVerdict') }}</h3>
          <fieldset>
            <legend>{{ locale.t('review.expiry') }}</legend>
            <label>
              <input
                type="radio"
                name="expiry"
                [checked]="choice() === 'inherit'"
                (change)="choice.set('inherit')"
              />
              {{ locale.t('review.inherit') }}
              @if (defaultExpiry(); as d) {
                <span class="muted">({{ d }})</span>
              } @else {
                <span class="muted">({{ locale.t('review.noDefault') }})</span>
              }
            </label>
            <label>
              <input
                type="radio"
                name="expiry"
                [checked]="choice() === 'date'"
                (change)="choice.set('date')"
              />
              {{ locale.t('review.onDate') }}
              <input
                type="date"
                class="date"
                [attr.aria-label]="locale.t('review.onDate')"
                [value]="date()"
                (input)="date.set($any($event.target).value); choice.set('date')"
              />
            </label>
            <label>
              <input
                type="radio"
                name="expiry"
                [checked]="choice() === 'permanent'"
                (change)="choice.set('permanent')"
              />
              {{ locale.t('review.permanent') }}
            </label>
          </fieldset>
          <button type="button" class="approve" [disabled]="busy()" (click)="approve()">
            {{ locale.t('review.approve') }}
          </button>

          <label class="reason">
            {{ locale.t('review.reason') }}
            <textarea
              rows="2"
              [value]="reason()"
              (input)="reason.set($any($event.target).value)"
            ></textarea>
          </label>
          <label>
            {{ locale.t('review.retainUntil') }}
            <input
              type="date"
              class="date"
              [value]="retainUntil()"
              (input)="retainUntil.set($any($event.target).value)"
            />
          </label>
          <button
            type="button"
            class="reject"
            [disabled]="busy() || reason().trim() === ''"
            (click)="reject()"
          >
            {{ locale.t('review.reject') }}
          </button>
        </div>
      }

      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }

      <h3>{{ locale.t('review.history') }}</h3>
      @if (verdicts() === null) {
        <p class="muted">{{ locale.t('editor.loading') }}</p>
      } @else if (verdicts()!.length === 0) {
        <p class="muted">{{ locale.t('review.noVerdicts') }}</p>
      }
      <ol class="history">
        @for (v of verdicts() ?? []; track v.id) {
          <li [attr.data-verdict]="v.verdict">
            <strong>{{ locale.t('review.verdict.' + v.verdict) }}</strong>
            · {{ v.automatic ? locale.t('review.automatic') : v.decidedBy }} ·
            {{ v.decidedAt.slice(0, 16).replace('T', ' ') }}
            @if (v.reviewPointId) {
              · {{ locale.t('review.at') }} {{ v.reviewPointId }}
            }
            @if (v.reason) {
              <p class="why">{{ v.reason }}</p>
            }
            @if (v.expiresAt) {
              <p class="muted">
                {{ locale.t('review.expiresAt') }} {{ v.expiresAt.slice(0, 10) }}
                @if (v.expirySource === 'category') {
                  ({{ locale.t('review.fromCategory') }})
                }
              </p>
            }
            @if (v.retainUntil) {
              <p class="muted">
                {{ locale.t('review.keptUntil') }} {{ v.retainUntil.slice(0, 10) }}
              </p>
            }
          </li>
        }
      </ol>
    </section>
  `,
  styles: `
    .review {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      padding: var(--space-2) 0;
    }
    h3 {
      margin: 0;
      font-size: 0.75rem;
      text-transform: uppercase;
      color: var(--color-fg-muted);
    }
    .badge {
      align-self: flex-start;
      margin: 0;
      padding: 2px var(--space-2);
      border-radius: var(--radius-md);
      font-size: 0.8125rem;
    }
    .badge[data-tone='ok'] {
      color: var(--color-success);
      background: var(--color-success-bg);
    }
    .badge[data-tone='warning'] {
      color: var(--color-warning);
      background: var(--color-warning-bg);
    }
    .badge[data-tone='danger'] {
      color: var(--color-danger);
      background: var(--color-danger-bg);
    }
    .badge[data-tone='info'] {
      color: var(--color-info);
      background: var(--color-info-bg);
    }
    .verdict,
    fieldset {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
    }
    fieldset {
      margin: 0;
      padding: 0;
      border: none;
    }
    legend {
      padding: 0;
      font-size: 0.75rem;
      color: var(--color-fg-muted);
    }
    label {
      display: flex;
      gap: var(--space-1);
      align-items: center;
      flex-wrap: wrap;
    }
    .reason {
      flex-direction: column;
      align-items: stretch;
    }
    textarea,
    .date {
      padding: var(--space-1);
      color: inherit;
      background: var(--color-bg-hover);
      border: 1px solid transparent;
      border-radius: var(--radius-md);
      font: inherit;
    }
    button {
      align-self: flex-start;
      padding: var(--space-1) var(--space-2);
      border: 1px solid transparent;
      border-radius: var(--radius-md);
      font: inherit;
      cursor: pointer;
    }
    button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .approve {
      color: var(--color-fg-on-accent);
      background: var(--color-accent);
    }
    .reject {
      color: var(--color-danger);
      background: var(--color-danger-bg);
    }
    .history {
      margin: 0;
      padding-inline-start: var(--space-3);
      font-size: 0.8125rem;
    }
    .history p {
      margin: 0;
    }
    .why {
      white-space: pre-wrap;
    }
    .muted {
      color: var(--color-fg-muted);
    }
    .error {
      margin: 0;
      color: var(--color-danger);
    }
  `,
})
export class AssetReview {
  readonly asset = input.required<Asset>();
  /** The category chain's default expiry, when it sets one — what "inherit" will snapshot. */
  readonly defaultExpiry = input<string | null>(null);
  /** UX only: the caller holds `asset:approve` for this asset. */
  readonly canApprove = input(false);
  /** The asset as MAM returned it after a verdict — the editor shows it. */
  readonly changed = output<Asset>();

  private readonly api = inject(AssetsService);
  protected readonly locale = inject(LocaleService);
  /** Injectable for tests: the badge counts days from now. */
  now: () => Date = () => new Date();

  protected readonly verdicts = signal<Verdict[] | null>(null);
  protected readonly choice = signal<ExpiryChoice>('inherit');
  protected readonly date = signal('');
  protected readonly reason = signal('');
  protected readonly retainUntil = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly badge = computed(() => badgeOf(this.asset(), this.now()));
  protected readonly offered = computed(
    () => this.canApprove() && awaitsVerdict(this.asset().state),
  );

  // The history is read for the asset shown, and again whenever its version moves — a verdict
  // here, or one given elsewhere that the editor reloaded.
  private readonly history = effect(() => {
    const { id, version } = this.asset();
    void version;
    this.api.verdicts(id).subscribe({
      next: (page) => this.verdicts.set(page.items),
      error: () => this.verdicts.set([]),
    });
  });

  approve(): void {
    const body = approvalBody(this.choice(), this.date(), this.now());
    if (body === null) {
      this.error.set(this.locale.t('review.badDate'));
      return;
    }
    this.give(this.api.approve(this.asset().id, body));
  }

  reject(): void {
    const reason = this.reason().trim();
    const retainUntil = retentionOf(this.retainUntil());
    if (reason === '') return;
    if (retainUntil === null) {
      this.error.set(this.locale.t('review.badDate'));
      return;
    }
    this.give(
      this.api.reject(this.asset().id, {
        reason,
        ...(retainUntil !== undefined ? { retainUntil } : {}),
      }),
    );
  }

  private give(request: ReturnType<AssetsService['approve']>): void {
    this.busy.set(true);
    this.error.set(null);
    request.subscribe({
      next: (asset) => {
        this.busy.set(false);
        this.reason.set('');
        this.changed.emit(asset);
      },
      error: (err: unknown) => {
        this.busy.set(false);
        // MAM's own words: an illegal move (409), a missing reason (422), no grant (403).
        const body =
          err instanceof HttpErrorResponse ? (err.error as { detail?: unknown } | null) : null;
        this.error.set(
          typeof body?.detail === 'string' ? body.detail : this.locale.t('review.verdictError'),
        );
      },
    });
  }
}
