import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { IfCanDirective } from '../core/if-can.directive.ts';
import { EditorStore } from '../workbench/editor.store.ts';

/**
 * A placeholder Media panel.
 *
 * It exists to prove the wiring end to end — lazy route, permission match, `*atlasIfCan` gating,
 * and opening editors into the tabbed area — not to be the Media panel. The real one (browse tree,
 * recent, collections, facets, and the asset editor) is EP-17 and beyond.
 */
@Component({
  selector: 'atlas-media-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IfCanDirective],
  template: `
    <h2 class="panel-title">Media</h2>

    <p class="muted">Stand-in items. Opening one adds a tab; opening it twice focuses that tab.</p>
    <ul class="items">
      @for (item of items; track item.id) {
        <li>
          <button type="button" (click)="openAsset(item)">{{ item.title }}</button>
        </li>
      }
    </ul>

    <div class="actions">
      <button type="button" *atlasIfCan="'asset:write'">New asset</button>
      <button type="button" *atlasIfCan="'asset:delete'; strict: true; resource: sampleAsset">
        Delete
      </button>
    </div>

    <p *atlasIfCan="'asset:approve'; else cannotApprove" class="muted">You may approve assets.</p>
    <ng-template #cannotApprove>
      <p class="muted">Approval is not part of your access.</p>
    </ng-template>
  `,
  styles: `
    .panel-title {
      margin: 0 0 var(--space-2);
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--color-fg-muted);
    }
    .items {
      list-style: none;
      margin: 0 0 var(--space-4);
      padding: 0;
    }
    .items button {
      inline-size: 100%;
      padding: var(--space-1) var(--space-2);
      text-align: start;
      color: inherit;
      background: none;
      border: none;
      border-radius: var(--radius-md);
      cursor: pointer;
    }
    .items button:hover {
      background: var(--color-bg-hover);
    }
    .actions {
      display: flex;
      gap: var(--space-2);
      flex-wrap: wrap;
    }
    .muted {
      color: var(--color-fg-muted);
      font-size: 0.8125rem;
    }
  `,
})
export class MediaPanel {
  private readonly editors = inject(EditorStore);

  /** Stands in for a loaded asset, so the strict check has full context to evaluate. */
  protected readonly sampleAsset = { channelId: 'ch12', categoryPath: '/sports/football/' };

  protected readonly items = [
    { id: '42', title: 'Clip 42' },
    { id: '43', title: 'Match highlights' },
    { id: '44', title: 'Studio intro' },
  ];

  protected openAsset(item: { id: string; title: string }): void {
    this.editors.open({ type: 'asset', resourceId: item.id, title: item.title, icon: '▤' });
  }
}
