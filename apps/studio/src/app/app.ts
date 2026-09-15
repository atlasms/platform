import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/**
 * The root is an outlet, nothing more: the router decides between the sign-in screen and the
 * workbench (app.routes.ts), so the workbench's frame is not even constructed without a session.
 */
@Component({
  selector: 'atlas-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet],
  template: `<router-outlet />`,
})
export class App {}
