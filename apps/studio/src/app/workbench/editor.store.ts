import { computed, Injectable, signal } from '@angular/core';
import {
  activeGroup,
  activeTab,
  close as closeTab,
  closeAll as closeAllTabs,
  closeOthers as closeOtherTabs,
  emptyLayout,
  focus as focusTab,
  focusGroup as focusEditorGroup,
  isDirty,
  moveTab as moveEditorTab,
  open as openTab,
  setDirty as setTabDirty,
  splitTo as splitTabTo,
  togglePin as togglePinTab,
  type EditorLayout,
  type OpenDescriptor,
} from './editor.model.ts';

const STORAGE_KEY = 'atlas.studio.workspace.v1';

/**
 * The editor area's state, and its persistence.
 *
 * Every mutation delegates to the pure functions in `editor.model.ts`; this class only holds the
 * signal and saves. Keeping the rules out of the store is what let the tab/group behaviour be
 * tested exhaustively without a DOM.
 */
@Injectable({ providedIn: 'root' })
export class EditorStore {
  private readonly _layout = signal<EditorLayout>(restore());

  readonly layout = this._layout.asReadonly();
  readonly groups = computed(() => this._layout().groups);
  readonly activeGroupId = computed(() => this._layout().activeGroupId);
  readonly activeTab = computed(() => activeTab(this._layout()));
  readonly activeGroup = computed(() => activeGroup(this._layout()));
  readonly hasUnsavedChanges = computed(() => isDirty(this._layout()));
  readonly isEmpty = computed(() => this._layout().groups.length === 0);

  open(descriptor: OpenDescriptor): void {
    this.update(openTab(this._layout(), descriptor));
  }

  focus(groupId: string, tabId: string): void {
    this.update(focusTab(this._layout(), groupId, tabId));
  }

  focusGroup(groupId: string): void {
    this.update(focusEditorGroup(this._layout(), groupId));
  }

  close(groupId: string, tabId: string): void {
    this.update(closeTab(this._layout(), groupId, tabId));
  }

  closeOthers(groupId: string, keepId: string): void {
    this.update(closeOtherTabs(this._layout(), groupId, keepId));
  }

  closeAll(groupId: string): void {
    this.update(closeAllTabs(this._layout(), groupId));
  }

  setDirty(tabId: string, dirty: boolean): void {
    this.update(setTabDirty(this._layout(), tabId, dirty));
  }

  togglePin(tabId: string): void {
    this.update(togglePinTab(this._layout(), tabId));
  }

  splitTo(groupId: string, tabId: string): void {
    this.update(splitTabTo(this._layout(), groupId, tabId));
  }

  moveTab(fromGroupId: string, tabId: string, toGroupId: string, toIndex: number): void {
    this.update(moveEditorTab(this._layout(), fromGroupId, tabId, toGroupId, toIndex));
  }

  reset(): void {
    this.update(emptyLayout());
  }

  private update(next: EditorLayout): void {
    this._layout.set(next);
    persist(next);
  }
}

/**
 * Workspace persistence ([FR-UI-3](../../../../../docs/requirements/05-functional-requirements.md#studio)).
 *
 * localStorage for now. The requirement is server-side persistence restored at next login, which
 * needs an endpoint that does not exist yet — so this is deliberately a local stand-in behind the
 * same store API, and swapping it is a change here and nowhere else.
 *
 * `dirty` is intentionally NOT persisted: unsaved edits do not survive a reload, so restoring a
 * tab still marked dirty would promise changes that are gone.
 */
function persist(layout: EditorLayout): void {
  try {
    const clean: EditorLayout = {
      ...layout,
      groups: layout.groups.map((g) => ({
        ...g,
        tabs: g.tabs.map((t) => ({ ...t, dirty: false })),
      })),
    };
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // A full or unavailable quota must not take the workbench down with it.
  }
}

function restore(): EditorLayout {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return emptyLayout();
    const parsed: unknown = JSON.parse(raw);
    return isLayout(parsed) ? parsed : emptyLayout();
  } catch {
    // Corrupt or foreign data: start clean rather than crash on boot.
    return emptyLayout();
  }
}

/** Storage is user-writable and survives deploys, so what comes back is checked, not trusted. */
function isLayout(value: unknown): value is EditorLayout {
  if (!isRecord(value) || !Array.isArray(value['groups'])) return false;
  return (value['groups'] as unknown[]).every(isGroup);
}

function isGroup(value: unknown): boolean {
  if (!isRecord(value) || typeof value['id'] !== 'string' || !Array.isArray(value['tabs'])) {
    return false;
  }
  return (value['tabs'] as unknown[]).every(
    (t) => isRecord(t) && typeof t['id'] === 'string' && typeof t['title'] === 'string',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
