import { ChangeDetectionStrategy, Component } from '@angular/core';
import { IfCanDirective } from '../core/if-can.directive.ts';

/**
 * A placeholder Media panel.
 *
 * It exists to prove the wiring end to end — lazy route, permission match, and
 * `*atlasIfCan` gating an action — not to be the Media panel. The real one (browse tree, recent,
 * collections, facets, and the asset editor) is EP-17 and beyond.
 */
@Component({
  selector: 'atlas-media-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IfCanDirective],
  template: `
    <h1>Media</h1>
    <p>Asset browsing lands here once MAM exists (EP-17).</p>

    <div class="actions">
      <button type="button" *atlasIfCan="'asset:write'">New asset</button>

      <button type="button" *atlasIfCan="'asset:delete'; strict: true; resource: sampleAsset">
        Delete
      </button>

      <span *atlasIfCan="'asset:approve'; else cannotApprove">You may approve assets.</span>
      <ng-template #cannotApprove>
        <span class="muted">Approval is not part of your access.</span>
      </ng-template>
    </div>
  `,
  styles: `
    .actions {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      margin-block-start: 1rem;
    }
    .muted {
      color: var(--color-fg-muted);
    }
  `,
})
export class MediaPanel {
  /** Stands in for a loaded asset, so the strict check has full context to evaluate. */
  protected readonly sampleAsset = { channelId: 'ch12', categoryPath: '/sports/football/' };
}
