import { CdkDrag, CdkDropList, CdkDropListGroup, type CdkDragDrop } from '@angular/cdk/drag-drop';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AssetEditor } from '../editors/asset-editor.ts';
import { ScheduleEditor } from '../editors/schedule-editor.ts';
import { GroupEditor } from '../editors/group-editor.ts';
import { ProfileEditor } from '../editors/profile-editor.ts';
import { RoleEditor } from '../editors/role-editor.ts';
import { UserEditor } from '../editors/user-editor.ts';
import { WatcherEditor } from '../editors/watcher-editor.ts';
import { RuleSetEditor } from '../editors/rule-set-editor.ts';
import { Dashboard } from '../panels/dashboard.ts';
import { LocaleService } from '../core/locale.service.ts';
import { EditorStore } from './editor.store.ts';

/**
 * The editor area: tabbed groups side by side, with tabs draggable between them
 * ([studio-frontend.md §1.2](../../../../../docs/architecture/studio-frontend.md)).
 *
 * Each editor KIND is `@defer`red: its code — and what only editors use, `@angular/forms` among it —
 * is a chunk fetched when a tab of that kind first renders, not part of the initial bundle every
 * session downloads before it can sign in. The dashboard stays eager: it is the landing tab. A chunk
 * that fails to load (a redeploy replaced it under an open Studio) says so rather than rendering an
 * empty pane.
 *
 * Every tab pane remains mounted while another tab is focused. Destroying an inactive asset editor
 * would discard its unsaved form while the tab still showed a dirty dot — an especially dangerous
 * lie in a multi-tab workbench.
 */
@Component({
  selector: 'atlas-editor-area',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CdkDrag,
    CdkDropList,
    CdkDropListGroup,
    AssetEditor,
    Dashboard,
    ScheduleEditor,
    UserEditor,
    GroupEditor,
    RoleEditor,
    ProfileEditor,
    WatcherEditor,
    RuleSetEditor,
  ],
  template: `
    @if (store.isEmpty()) {
      <div class="empty-state">
        <p>{{ locale.t('editor.empty') }}</p>
        <p class="muted">
          {{ locale.t('editor.emptyHint') }}
        </p>
      </div>
    } @else {
      <div class="groups" cdkDropListGroup>
        @for (group of store.groups(); track group.id) {
          <!-- A click anywhere in a group makes it the active one — a pointer convenience. Its
               keyboard equivalent is (focusin): focus moving into the group by any key does the
               same, so the group itself is not a control and is not made focusable. -->
          <!-- eslint-disable-next-line @angular-eslint/template/click-events-have-key-events, @angular-eslint/template/interactive-supports-focus -->
          <section
            class="group"
            [class.focused]="group.id === store.activeGroupId()"
            (click)="store.focusGroup(group.id)"
            (focusin)="store.focusGroup(group.id)"
          >
            <div
              class="tab-bar"
              role="tablist"
              cdkDropList
              cdkDropListOrientation="horizontal"
              [cdkDropListData]="group.id"
              (cdkDropListDropped)="onDrop($event)"
            >
              @for (tab of group.tabs; track tab.id) {
                <div
                  class="tab"
                  role="tab"
                  tabindex="0"
                  [attr.aria-selected]="tab.id === group.activeTabId"
                  cdkDrag
                  [cdkDragData]="tab.id"
                  [class.active]="tab.id === group.activeTabId"
                  [class.pinned]="tab.pinned"
                  (click)="store.focus(group.id, tab.id)"
                  (keydown.enter)="onTabKey($event, group.id, tab.id)"
                  (keydown.space)="onTabKey($event, group.id, tab.id)"
                  (dblclick)="store.togglePin(tab.id)"
                  [title]="tab.title + (tab.pinned ? ' (' + locale.t('editor.pinned') + ')' : '')"
                >
                  <span class="icon" aria-hidden="true">{{ tab.icon }}</span>
                  <span class="label">{{ tab.title }}</span>
                  <button
                    type="button"
                    class="close"
                    [attr.aria-label]="locale.t('editor.close') + ' ' + tab.title"
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
                  [title]="locale.t('editor.split')"
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
                      @defer (on immediate) {
                        <atlas-asset-editor [assetId]="tab.resourceId" [tabId]="tab.id" />
                      } @placeholder {
                        <p class="muted">{{ locale.t('editor.loading') }}</p>
                      } @error {
                        <p class="error" role="alert">{{ locale.t('editor.loadFailed') }}</p>
                      }
                    }
                    @case ('dashboard') {
                      <atlas-dashboard />
                    }
                    @case ('schedule') {
                      @defer (on immediate) {
                        <atlas-schedule-editor [scheduleId]="tab.resourceId" [tabId]="tab.id" />
                      } @placeholder {
                        <p class="muted">{{ locale.t('editor.loading') }}</p>
                      } @error {
                        <p class="error" role="alert">{{ locale.t('editor.loadFailed') }}</p>
                      }
                    }
                    @case ('user') {
                      @defer (on immediate) {
                        <atlas-user-editor [userId]="tab.resourceId" [tabId]="tab.id" />
                      } @placeholder {
                        <p class="muted">{{ locale.t('editor.loading') }}</p>
                      } @error {
                        <p class="error" role="alert">{{ locale.t('editor.loadFailed') }}</p>
                      }
                    }
                    @case ('group') {
                      @defer (on immediate) {
                        <atlas-group-editor [groupId]="tab.resourceId" [tabId]="tab.id" />
                      } @placeholder {
                        <p class="muted">{{ locale.t('editor.loading') }}</p>
                      } @error {
                        <p class="error" role="alert">{{ locale.t('editor.loadFailed') }}</p>
                      }
                    }
                    @case ('role') {
                      @defer (on immediate) {
                        <atlas-role-editor [roleId]="tab.resourceId" [tabId]="tab.id" />
                      } @placeholder {
                        <p class="muted">{{ locale.t('editor.loading') }}</p>
                      } @error {
                        <p class="error" role="alert">{{ locale.t('editor.loadFailed') }}</p>
                      }
                    }
                    @case ('profile') {
                      @defer (on immediate) {
                        <atlas-profile-editor [profileRef]="tab.resourceId" [tabId]="tab.id" />
                      } @placeholder {
                        <p class="muted">{{ locale.t('editor.loading') }}</p>
                      } @error {
                        <p class="error" role="alert">{{ locale.t('editor.loadFailed') }}</p>
                      }
                    }
                    @case ('watcher') {
                      @defer (on immediate) {
                        <atlas-watcher-editor [watcherId]="tab.resourceId" [tabId]="tab.id" />
                      } @placeholder {
                        <p class="muted">{{ locale.t('editor.loading') }}</p>
                      } @error {
                        <p class="error" role="alert">{{ locale.t('editor.loadFailed') }}</p>
                      }
                    }
                    @case ('rules') {
                      @defer (on immediate) {
                        <atlas-rule-set-editor [setId]="tab.resourceId" [tabId]="tab.id" />
                      } @placeholder {
                        <p class="muted">{{ locale.t('editor.loading') }}</p>
                      } @error {
                        <p class="error" role="alert">{{ locale.t('editor.loadFailed') }}</p>
                      }
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
  protected readonly locale = inject(LocaleService);

  /**
   * Enter or Space on a tab shows it — the keyboard's click. Only when the TAB is the target: the
   * same keys on its close button bubble here, and must close the tab, not also re-select it.
   */
  protected onTabKey(event: Event, groupId: string, tabId: string): void {
    if (event.target !== event.currentTarget) return;
    event.preventDefault(); // Space would otherwise scroll the editor area
    this.store.focus(groupId, tabId);
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
