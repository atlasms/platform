import { CdkDrag, CdkDropList, CdkDropListGroup, type CdkDragDrop } from '@angular/cdk/drag-drop';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AssetEditor } from '../editors/asset-editor.ts';
import { EditorStore } from './editor.store.ts';

/**
 * The editor area: tabbed groups side by side, with tabs draggable between them
 * ([studio-frontend.md §1.2](../../../../../docs/architecture/studio-frontend.md)).
 *
 * Every tab pane remains mounted while another tab is focused. Destroying an inactive asset editor
 * would discard its unsaved form while the tab still showed a dirty dot — an especially dangerous
 * lie in a multi-tab workbench.
 */
@Component({
  selector: 'atlas-editor-area',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CdkDrag, CdkDropList, CdkDropListGroup, AssetEditor],
  template: `
    @if (store.isEmpty()) {
      <div class="empty-state">
        <p>No editors open.</p>
        <p class="muted">
          Open something from a panel — tabs, splits and layout are restored next time.
        </p>
      </div>
    } @else {
      <div class="groups" cdkDropListGroup>
        @for (group of store.groups(); track group.id) {
          <section
            class="group"
            [class.focused]="group.id === store.activeGroupId()"
            (click)="store.focusGroup(group.id)"
          >
            <div
              class="tab-bar"
              cdkDropList
              cdkDropListOrientation="horizontal"
              [cdkDropListData]="group.id"
              (cdkDropListDropped)="onDrop($event)"
            >
              @for (tab of group.tabs; track tab.id) {
                <div
                  class="tab"
                  cdkDrag
                  [cdkDragData]="tab.id"
                  [class.active]="tab.id === group.activeTabId"
                  [class.pinned]="tab.pinned"
                  (click)="store.focus(group.id, tab.id)"
                  (dblclick)="store.togglePin(tab.id)"
                  [title]="tab.title + (tab.pinned ? ' (pinned)' : '')"
                >
                  <span class="icon" aria-hidden="true">{{ tab.icon }}</span>
                  <span class="label">{{ tab.title }}</span>
                  <button
                    type="button"
                    class="close"
                    [attr.aria-label]="'Close ' + tab.title"
                    (click)="onClose($event, group.id, tab.id)"
                  >
                    <!-- A dirty tab shows a dot instead of the ✕ until hovered, so unsaved work is
                         visible without hunting for it. -->
                    {{ tab.dirty ? '●' : '✕' }}
                  </button>
                </div>
              }
              <span class="tab-bar-spacer"></span>
              @if (group.tabs.length > 1 && group.activeTabId) {
                <button
                  type="button"
                  class="split"
                  title="Split the active tab into a new group"
                  (click)="store.splitTo(group.id, group.activeTabId)"
                >
                  ⫲
                </button>
              }
            </div>

            <div class="editor-body">
              @for (tab of group.tabs; track tab.id) {
                <div class="editor-pane" [hidden]="tab.id !== group.activeTabId">
                  @switch (tab.type) {
                    @case ('asset') {
                      <atlas-asset-editor [assetId]="tab.resourceId" [tabId]="tab.id" />
                    }
                    @default {
                      <h2>{{ tab.title }}</h2>
                      <p class="muted">
                        A {{ tab.type }} editor renders here once that service exists.
                      </p>
                    }
                  }
                </div>
              }
            </div>
          </section>
        }
      </div>
    }
  `,
  styleUrl: './editor-area.scss',
})
export class EditorArea {
  protected readonly store = inject(EditorStore);

  protected onClose(event: Event, groupId: string, tabId: string): void {
    // Without this the click also reaches the tab and focuses what is being removed.
    event.stopPropagation();
    this.store.close(groupId, tabId);
  }

  protected onDrop(event: CdkDragDrop<string>): void {
    const tabId = event.item.data as string;
    const from = event.previousContainer.data;
    const to = event.container.data;
    this.store.moveTab(from, tabId, to, event.currentIndex);
  }
}
