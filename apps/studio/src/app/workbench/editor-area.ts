import { CdkDrag, CdkDropList, CdkDropListGroup, type CdkDragDrop } from '@angular/cdk/drag-drop';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { EditorStore } from './editor.store.ts';
import type { EditorGroup, EditorTab } from './editor.model.ts';

/**
 * The editor area: tabbed groups side by side, with tabs draggable between them
 * ([studio-frontend.md §1.2](../../../../../docs/architecture/studio-frontend.md)).
 *
 * Group *contents* are a placeholder — rendering an actual asset or schedule editor needs those
 * services (EP-17 onward). What is real here is the tab machinery: order, focus, pinning, dirty
 * marking, splitting, drag between groups, and persistence across reloads.
 */
@Component({
  selector: 'atlas-editor-area',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CdkDrag, CdkDropList, CdkDropListGroup],
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
              @if (activeOf(group); as tab) {
                <h2>{{ tab.title }}</h2>
                <p class="muted">A {{ tab.type }} editor renders here once that service exists.</p>
                <button type="button" (click)="store.setDirty(tab.id, !tab.dirty)">
                  {{ tab.dirty ? 'Mark saved' : 'Simulate an edit' }}
                </button>
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

  protected activeOf(group: EditorGroup): EditorTab | undefined {
    return group.tabs.find((t) => t.id === group.activeTabId);
  }

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
