import { describe, expect, it } from 'vitest';
import {
  activeGroup,
  activeTab,
  close,
  closeAll,
  closeOthers,
  emptyLayout,
  findTab,
  focus,
  isDirty,
  moveTab,
  open,
  setDirty,
  splitTo,
  togglePin,
  type EditorLayout,
} from './editor.model.ts';

const asset = (id: string): { type: string; resourceId: string; title: string } => ({
  type: 'asset',
  resourceId: id,
  title: `Asset ${id}`,
});

const openMany = (ids: string[]): EditorLayout =>
  ids.reduce((layout, id) => open(layout, asset(id)), emptyLayout());

/**
 * Group ids come from a module-global counter, so hardcoding 'g1'/'g2' couples these tests to
 * every other spec file that creates a group — which is exactly how this suite went flaky under
 * vitest's parallel files. Address groups by position instead.
 */
const gid = (layout: EditorLayout, index: number): string => layout.groups[index]?.id ?? '';

const titles = (layout: EditorLayout, groupIndex = 0): string[] =>
  (layout.groups[groupIndex]?.tabs ?? []).map((t) => t.resourceId);

describe('editor layout', () => {
  describe('opening', () => {
    it('creates the first group and focuses the tab', () => {
      const layout = open(emptyLayout(), asset('1'));
      expect(layout.groups).toHaveLength(1);
      expect(activeTab(layout)?.resourceId).toBe('1');
    });

    it('opens into the active group and focuses the newcomer', () => {
      const layout = openMany(['1', '2', '3']);
      expect(layout.groups).toHaveLength(1);
      expect(titles(layout)).toEqual(['1', '2', '3']);
      expect(activeTab(layout)?.resourceId).toBe('3');
    });

    it('re-opening an item focuses the existing tab instead of duplicating it', () => {
      // Two tabs over one resource would each accumulate their own unsaved edits, and whichever
      // saved last would silently win.
      let layout = openMany(['1', '2']);
      layout = open(layout, asset('1'));
      expect(titles(layout)).toEqual(['1', '2']);
      expect(activeTab(layout)?.resourceId).toBe('1');
    });

    it('finds an already-open item in ANOTHER group and focuses it there', () => {
      let layout = openMany(['1', '2']);
      layout = splitTo(layout, gid(layout, 0), 'asset:2');
      expect(layout.groups).toHaveLength(2);

      layout = focus(layout, gid(layout, 0), 'asset:1');
      layout = open(layout, asset('2')); // lives in g2

      expect(layout.activeGroupId).toBe(gid(layout, 1));
      expect(activeTab(layout)?.resourceId).toBe('2');
      expect(layout.groups).toHaveLength(2);
    });

    it('preserveFocus opens without stealing focus — what workspace restore needs', () => {
      let layout = open(emptyLayout(), asset('1'));
      layout = open(layout, { ...asset('2'), preserveFocus: true });
      expect(titles(layout)).toEqual(['1', '2']);
      expect(activeTab(layout)?.resourceId).toBe('1');
    });
  });

  describe('closing', () => {
    it('focus moves to the tab on the RIGHT', () => {
      let layout = openMany(['1', '2', '3']);
      layout = focus(layout, gid(layout, 0), 'asset:2');
      layout = close(layout, gid(layout, 0), 'asset:2');
      expect(activeTab(layout)?.resourceId).toBe('3');
    });

    it('focus falls LEFT when the last tab is closed', () => {
      let layout = openMany(['1', '2', '3']); // '3' is active
      layout = close(layout, gid(layout, 0), 'asset:3');
      expect(activeTab(layout)?.resourceId).toBe('2');
    });

    it('closing an inactive tab leaves focus alone', () => {
      let layout = openMany(['1', '2', '3']); // '3' active
      layout = close(layout, gid(layout, 0), 'asset:1');
      expect(activeTab(layout)?.resourceId).toBe('3');
    });

    it('emptying the only group empties the layout', () => {
      let layout = open(emptyLayout(), asset('1'));
      layout = close(layout, gid(layout, 0), 'asset:1');
      expect(layout).toEqual(emptyLayout());
      expect(activeTab(layout)).toBeUndefined();
    });

    it('emptying one of two groups removes it and moves focus to a survivor', () => {
      // A stranded empty pane is the classic bug here.
      let layout = openMany(['1', '2']);
      layout = splitTo(layout, gid(layout, 0), 'asset:2');
      layout = close(layout, gid(layout, 1), 'asset:2');

      expect(layout.groups).toHaveLength(1);
      expect(layout.activeGroupId).toBe(gid(layout, 0));
      expect(activeGroup(layout)).toBeDefined();
    });

    it('closeOthers keeps the named tab and every pinned one', () => {
      let layout = openMany(['1', '2', '3', '4']);
      layout = togglePin(layout, 'asset:2');
      layout = closeOthers(layout, gid(layout, 0), 'asset:3');
      expect(titles(layout)).toEqual(['2', '3']);
    });

    it('closeAll keeps pinned tabs — that is what pinning is for', () => {
      let layout = openMany(['1', '2', '3']);
      layout = togglePin(layout, 'asset:2');
      layout = closeAll(layout, gid(layout, 0));
      expect(titles(layout)).toEqual(['2']);
    });

    it('closeAll on an entirely unpinned group removes the group', () => {
      let layout = openMany(['1', '2']);
      layout = closeAll(layout, gid(layout, 0));
      expect(layout.groups).toHaveLength(0);
    });

    it('closing an unknown tab or group is a no-op, not a crash', () => {
      const layout = openMany(['1']);
      expect(close(layout, gid(layout, 0), 'asset:nope')).toBe(layout);
      expect(close(layout, 'nope', 'asset:1')).toBe(layout);
    });
  });

  describe('dirty state', () => {
    it('tracks unsaved edits per tab and across the layout', () => {
      let layout = openMany(['1', '2']);
      expect(isDirty(layout)).toBe(false);

      layout = setDirty(layout, 'asset:1', true);
      expect(findTab(layout, 'asset:1')?.tab.dirty).toBe(true);
      expect(findTab(layout, 'asset:2')?.tab.dirty).toBe(false);
      expect(isDirty(layout)).toBe(true);

      layout = setDirty(layout, 'asset:1', false);
      expect(isDirty(layout)).toBe(false);
    });
  });

  describe('splitting', () => {
    it('moves the tab into a new group beside the old one', () => {
      let layout = openMany(['1', '2']);
      layout = splitTo(layout, gid(layout, 0), 'asset:2');

      expect(layout.groups).toHaveLength(2);
      expect(titles(layout, 0)).toEqual(['1']);
      expect(titles(layout, 1)).toEqual(['2']);
      expect(layout.activeGroupId).toBe(gid(layout, 1));
    });

    it('refuses to split a group with a single tab', () => {
      // Otherwise the source group empties and the split achieves nothing but churn.
      const layout = openMany(['1']);
      expect(splitTo(layout, gid(layout, 0), 'asset:1')).toBe(layout);
    });
  });

  describe('drag and drop', () => {
    it('reorders within a group', () => {
      let layout = openMany(['1', '2', '3']);
      layout = moveTab(layout, gid(layout, 0), 'asset:3', gid(layout, 0), 0);
      expect(titles(layout)).toEqual(['3', '1', '2']);
    });

    it('moves between groups at the requested index', () => {
      let layout = openMany(['1', '2', '3']);
      layout = splitTo(layout, gid(layout, 0), 'asset:3'); // g2 = [3]
      layout = moveTab(layout, gid(layout, 0), 'asset:1', gid(layout, 1), 0);

      expect(titles(layout, 0)).toEqual(['2']);
      expect(titles(layout, 1)).toEqual(['1', '3']);
      expect(layout.activeGroupId).toBe(gid(layout, 1));
      expect(activeTab(layout)?.resourceId).toBe('1');
    });

    it('a move that empties the source group removes it', () => {
      let layout = openMany(['1', '2']);
      layout = splitTo(layout, gid(layout, 0), 'asset:2'); // g1=[1], g2=[2]
      layout = moveTab(layout, gid(layout, 0), 'asset:1', gid(layout, 1), 0);

      expect(layout.groups).toHaveLength(1);
      expect(titles(layout, 0)).toEqual(['1', '2']);
      expect(layout.activeGroupId).toBe(layout.groups[0]?.id);
    });

    it('clamps an out-of-range drop index instead of tearing the list', () => {
      let layout = openMany(['1', '2']);
      layout = moveTab(layout, gid(layout, 0), 'asset:1', gid(layout, 0), 99);
      expect(titles(layout)).toEqual(['2', '1']);
    });

    it('leaves focus in the source group when a non-active tab moves out', () => {
      let layout = openMany(['1', '2', '3']); // '3' active in g1
      layout = splitTo(layout, gid(layout, 0), 'asset:3'); // g1=[1,2] active '2', g2=[3]
      layout = focus(layout, gid(layout, 0), 'asset:2');
      layout = moveTab(layout, gid(layout, 0), 'asset:1', gid(layout, 1), 0);

      expect(layout.groups[0]?.activeTabId).toBe('asset:2');
    });
  });
});
