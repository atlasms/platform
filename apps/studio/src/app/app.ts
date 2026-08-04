import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Workbench } from './workbench/workbench.ts';

@Component({
  selector: 'atlas-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Workbench],
  template: `<atlas-workbench />`,
})
export class App {}
