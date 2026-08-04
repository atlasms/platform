/**
 * The editor area's data model ([studio-frontend.md §1.2](../../../../../docs/architecture/studio-frontend.md)).
 *
 * Kept as plain data with pure functions, separate from any component, because the interesting
 * behaviour is the state machine — which tab is focused after a close, what happens to a group
 * that empties, whether an already-open item opens twice — and that deserves to be tested without
 * rendering anything.
 */

/** A typed editor tab. Assets, schedules, the workflow designer and diffs all coexist here. */
export interface EditorTab {
  /**
   * Stable identity, `${type}:${resourceId}`.
   *
   * Derived rather than random so that "open asset 42" twice finds the existing tab. A random id
   * would silently open duplicates of the same resource, each with its own unsaved edits.
   */
  readonly id: string;
  readonly type: string;
  readonly resourceId: string;
  readonly title: string;
  readonly icon: string;
  /** Pinned tabs survive "close others" and sort ahead of unpinned ones. */
  readonly pinned: boolean;
  /** Unsaved changes: shown as a dot, and confirmed before closing. */
  readonly dirty: boolean;
}

/** One tab strip plus its visible editor. Groups sit side by side when the area is split. */
export interface EditorGroup {
  readonly id: string;
  readonly tabs: readonly EditorTab[];
  readonly activeTabId: string | null;
}

export interface EditorLayout {
  readonly groups: readonly EditorGroup[];
  readonly activeGroupId: string | null;
}

export interface OpenDescriptor {
  readonly type: string;
  readonly resourceId: string;
  readonly title: string;
  readonly icon?: string;
  /** Open without focusing — used by "restore workspace", which must not steal focus. */
  readonly preserveFocus?: boolean;
}

export const tabId = (type: string, resourceId: string): string => `${type}:${resourceId}`;

export const emptyLayout = (): EditorLayout => ({ groups: [], activeGroupId: null });

export const findTab = (
  layout: EditorLayout,
  id: string,
): { group: EditorGroup; tab: EditorTab } | undefined => {
  for (const group of layout.groups) {
    const tab = group.tabs.find((t) => t.id === id);
    if (tab) return { group, tab };
  }
  return undefined;
};

export const groupById = (layout: EditorLayout, id: string): EditorGroup | undefined =>
  layout.groups.find((g) => g.id === id);

export const activeGroup = (layout: EditorLayout): EditorGroup | undefined =>
  layout.activeGroupId === null ? undefined : groupById(layout, layout.activeGroupId);

export const activeTab = (layout: EditorLayout): EditorTab | undefined => {
  const group = activeGroup(layout);
  if (!group || group.activeTabId === null) return undefined;
  return group.tabs.find((t) => t.id === group.activeTabId);
};

export const isDirty = (layout: EditorLayout): boolean =>
  layout.groups.some((g) => g.tabs.some((t) => t.dirty));

// =============================================================================
// Operations. Every one returns a NEW layout — nothing mutates, so a component can diff cheaply
// and a test can assert on the before as well as the after.
// =============================================================================

// Group ids only have to be unique, never predictable. Nothing reads meaning from them, and
// nothing may assert on their value — a test that hardcodes `g1` couples itself to every other
// file that creates a group, which is how this suite briefly went flaky under parallel specs.
let groupCounter = 0;
const nextGroupId = (): string => `g${++groupCounter}`;

/**
 * Open an item.
 *
 * If it is already open **anywhere**, focus it there rather than opening a second copy — matching
 * VS Code, and avoiding two tabs over one resource with divergent unsaved edits.
 */
export function open(layout: EditorLayout, descriptor: OpenDescriptor): EditorLayout {
  const id = tabId(descriptor.type, descriptor.resourceId);

  const existing = findTab(layout, id);
  if (existing) {
    if (descriptor.preserveFocus) return layout;
    return focus(layout, existing.group.id, id);
  }

  const tab: EditorTab = {
    id,
    type: descriptor.type,
    resourceId: descriptor.resourceId,
    title: descriptor.title,
    icon: descriptor.icon ?? '▢',
    pinned: false,
    dirty: false,
  };

  const target = activeGroup(layout);
  if (!target) {
    const group: EditorGroup = { id: nextGroupId(), tabs: [tab], activeTabId: tab.id };
    return { groups: [group], activeGroupId: group.id };
  }

  const groups = layout.groups.map((g) =>
    g.id === target.id
      ? {
          ...g,
          tabs: [...g.tabs, tab],
          activeTabId: descriptor.preserveFocus ? g.activeTabId : tab.id,
        }
      : g,
  );
  return { ...layout, groups };
}

export function focus(layout: EditorLayout, groupId: string, tabIdToFocus: string): EditorLayout {
  return {
    groups: layout.groups.map((g) => (g.id === groupId ? { ...g, activeTabId: tabIdToFocus } : g)),
    activeGroupId: groupId,
  };
}

export function focusGroup(layout: EditorLayout, groupId: string): EditorLayout {
  return groupById(layout, groupId) ? { ...layout, activeGroupId: groupId } : layout;
}

/**
 * Close one tab.
 *
 * Focus moves to the tab on the **right**, or the left when the closed one was last — the
 * behaviour every editor has trained people to expect. An emptied group is removed, and focus
 * falls to a surviving group so the workbench is never left pointing at nothing.
 */
export function close(layout: EditorLayout, groupId: string, id: string): EditorLayout {
  const group = groupById(layout, groupId);
  if (!group) return layout;

  const index = group.tabs.findIndex((t) => t.id === id);
  if (index === -1) return layout;

  const tabs = group.tabs.filter((t) => t.id !== id);

  if (tabs.length === 0) {
    const groups = layout.groups.filter((g) => g.id !== groupId);
    if (groups.length === 0) return emptyLayout();
    const nextActive =
      layout.activeGroupId === groupId ? (groups[0]?.id ?? null) : layout.activeGroupId;
    return { groups, activeGroupId: nextActive };
  }

  const wasActive = group.activeTabId === id;
  // Math.min keeps the index in range when the last tab was closed.
  const nextActiveId = wasActive
    ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null)
    : group.activeTabId;

  return {
    ...layout,
    groups: layout.groups.map((g) =>
      g.id === groupId ? { ...g, tabs, activeTabId: nextActiveId } : g,
    ),
  };
}

/** Close everything in a group except `keepId` — and except pinned tabs, which is what pinning is for. */
export function closeOthers(layout: EditorLayout, groupId: string, keepId: string): EditorLayout {
  const group = groupById(layout, groupId);
  if (!group) return layout;
  const doomed = group.tabs.filter((t) => t.id !== keepId && !t.pinned).map((t) => t.id);
  return doomed.reduce((acc, id) => close(acc, groupId, id), layout);
}

export function closeAll(layout: EditorLayout, groupId: string): EditorLayout {
  const group = groupById(layout, groupId);
  if (!group) return layout;
  const doomed = group.tabs.filter((t) => !t.pinned).map((t) => t.id);
  return doomed.reduce((acc, id) => close(acc, groupId, id), layout);
}

export function setDirty(layout: EditorLayout, id: string, dirty: boolean): EditorLayout {
  return mapTab(layout, id, (tab) => ({ ...tab, dirty }));
}

export function togglePin(layout: EditorLayout, id: string): EditorLayout {
  return mapTab(layout, id, (tab) => ({ ...tab, pinned: !tab.pinned }));
}

function mapTab(layout: EditorLayout, id: string, fn: (tab: EditorTab) => EditorTab): EditorLayout {
  return {
    ...layout,
    groups: layout.groups.map((g) => ({
      ...g,
      tabs: g.tabs.map((t) => (t.id === id ? fn(t) : t)),
    })),
  };
}

/**
 * Split: move `id` into a NEW group beside its current one.
 *
 * Splitting the only tab of a group would leave an empty group behind and achieve nothing, so it
 * is refused rather than producing a degenerate layout.
 */
export function splitTo(layout: EditorLayout, groupId: string, id: string): EditorLayout {
  const group = groupById(layout, groupId);
  if (!group || group.tabs.length < 2) return layout;
  // Confirm the tab exists BEFORE creating the group. Creating it first and relying on moveTab to
  // fill it leaves a stranded empty pane whenever the move cannot happen.
  if (!group.tabs.some((t) => t.id === id)) return layout;
  const newGroupId = nextGroupId();
  const withGroup: EditorLayout = {
    ...layout,
    groups: [...layout.groups, { id: newGroupId, tabs: [], activeTabId: null }],
  };
  return moveTab(withGroup, groupId, id, newGroupId, 0);
}

/**
 * Move a tab between groups, or reorder within one (drag and drop).
 *
 * A move that empties the source group removes it — the same rule as closing the last tab, so a
 * drag cannot leave a stranded empty pane behind.
 */
export function moveTab(
  layout: EditorLayout,
  fromGroupId: string,
  id: string,
  toGroupId: string,
  toIndex: number,
): EditorLayout {
  const from = groupById(layout, fromGroupId);
  const to = groupById(layout, toGroupId);
  if (!from || !to) return layout;

  const tab = from.tabs.find((t) => t.id === id);
  if (!tab) return layout;

  if (fromGroupId === toGroupId) {
    const remaining = from.tabs.filter((t) => t.id !== id);
    const clamped = Math.max(0, Math.min(toIndex, remaining.length));
    const tabs = [...remaining.slice(0, clamped), tab, ...remaining.slice(clamped)];
    return {
      ...layout,
      groups: layout.groups.map((g) =>
        g.id === fromGroupId ? { ...g, tabs, activeTabId: id } : g,
      ),
    };
  }

  const sourceTabs = from.tabs.filter((t) => t.id !== id);
  const sourceIndex = from.tabs.findIndex((t) => t.id === id);
  const clamped = Math.max(0, Math.min(toIndex, to.tabs.length));
  const targetTabs = [...to.tabs.slice(0, clamped), tab, ...to.tabs.slice(clamped)];

  let groups: EditorGroup[] = layout.groups.map((g) => {
    if (g.id === fromGroupId) {
      const nextActive =
        g.activeTabId === id
          ? (sourceTabs[Math.min(sourceIndex, sourceTabs.length - 1)]?.id ?? null)
          : g.activeTabId;
      return { ...g, tabs: sourceTabs, activeTabId: nextActive };
    }
    if (g.id === toGroupId) return { ...g, tabs: targetTabs, activeTabId: id };
    return g;
  });

  groups = groups.filter((g) => g.tabs.length > 0);
  const stillThere = groups.some((g) => g.id === toGroupId);
  return { groups, activeGroupId: stillThere ? toGroupId : (groups[0]?.id ?? null) };
}
