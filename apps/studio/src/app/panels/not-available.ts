import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * The catch-all.
 *
 * Reached both by a genuinely unknown URL and by one whose `canMatch` guard refused. The wording
 * is deliberately the same for both: telling someone a route exists but is barred from them leaks
 * the shape of the system, and they can do nothing with the distinction anyway.
 */
@Component({
  selector: 'atlas-not-available',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Not available</h1>
    <p class="muted">This view does not exist, or is not part of your access.</p>
  `,
  styles: `
    .muted {
      color: var(--color-fg-muted);
    }
  `,
})
export class NotAvailable {}
