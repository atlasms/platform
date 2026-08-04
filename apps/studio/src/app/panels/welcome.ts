import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'atlas-welcome',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Atlas Studio</h1>
    <p>Pick a panel from the activity bar.</p>
    <p class="muted">
      Only panels your permissions allow are shown. The dashboard that belongs here is EP-11.3.
    </p>
  `,
  styles: `
    .muted {
      color: var(--color-fg-muted);
    }
  `,
})
export class Welcome {}
