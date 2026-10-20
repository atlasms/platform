import { ChangeDetectionStrategy, Component, ViewEncapsulation } from '@angular/core';

/**
 * Foblex Flow's theme, on Studio's tokens (flow-theme.scss), loaded WITH the designer rather than
 * in the global stylesheet: the canvas's CSS is only the designer's, so it travels in the
 * designer's lazy chunk instead of every user's first load. Unencapsulated — the library's
 * internals (connection paths, connectors) are out of a component's reach otherwise — and once
 * rendered it stays, which is harmless: every rule is scoped to Foblex's own elements and tokens.
 */
@Component({
  selector: 'atlas-flow-theme',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  template: '',
  styleUrl: './flow-theme.scss',
})
export class FlowTheme {}
