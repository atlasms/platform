import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { EditorStore } from './editor.store.ts';

const STORAGE_KEY = 'atlas.studio.workspace.v1';

const store = (): EditorStore => {
  TestBed.resetTestingModule();
  return TestBed.inject(EditorStore);
};

describe('EditorStore', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('opens editors and tracks the active tab', () => {
    const s = store();
    expect(s.isEmpty()).toBe(true);

    s.open({ type: 'asset', resourceId: '42', title: 'Clip 42' });
    expect(s.isEmpty()).toBe(false);
    expect(s.activeTab()?.title).toBe('Clip 42');
  });

  it('reports unsaved changes across every group', () => {
    const s = store();
    s.open({ type: 'asset', resourceId: '1', title: 'One' });
    s.open({ type: 'asset', resourceId: '2', title: 'Two' });
    expect(s.hasUnsavedChanges()).toBe(false);

    s.setDirty('asset:1', true);
    expect(s.hasUnsavedChanges()).toBe(true);
  });

  describe('workspace persistence (FR-UI-3)', () => {
    it('restores tabs, groups and focus in a new session', () => {
      const first = store();
      first.open({ type: 'asset', resourceId: '1', title: 'One' });
      first.open({ type: 'asset', resourceId: '2', title: 'Two' });
      first.splitTo(first.activeGroupId()!, 'asset:2');

      const restored = store(); // fresh injector, same storage
      expect(restored.groups()).toHaveLength(2);
      expect(restored.groups()[0]?.tabs.map((t) => t.resourceId)).toEqual(['1']);
      expect(restored.groups()[1]?.tabs.map((t) => t.resourceId)).toEqual(['2']);
      expect(restored.activeTab()?.resourceId).toBe('2');
    });

    it('does NOT restore dirty state', () => {
      // Unsaved edits do not survive a reload, so a tab still marked dirty would promise changes
      // that no longer exist.
      const first = store();
      first.open({ type: 'asset', resourceId: '1', title: 'One' });
      first.setDirty('asset:1', true);
      expect(first.hasUnsavedChanges()).toBe(true);

      expect(store().hasUnsavedChanges()).toBe(false);
    });

    it('starts clean when storage holds corrupt JSON', () => {
      localStorage.setItem(STORAGE_KEY, '{not json');
      expect(store().isEmpty()).toBe(true);
    });

    it('starts clean when storage holds well-formed but wrong-shaped data', () => {
      // localStorage is user-writable and survives deploys, so the shape is checked rather than
      // trusted. Booting into a crash because someone edited devtools is not acceptable.
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ groups: [{ id: 5, tabs: 'nope' }] }));
      expect(store().isEmpty()).toBe(true);

      localStorage.setItem(STORAGE_KEY, JSON.stringify({ groups: 'not-an-array' }));
      expect(store().isEmpty()).toBe(true);

      localStorage.setItem(STORAGE_KEY, JSON.stringify(null));
      expect(store().isEmpty()).toBe(true);
    });

    it('a closed workspace stays closed', () => {
      const first = store();
      first.open({ type: 'asset', resourceId: '1', title: 'One' });
      first.close(first.activeGroupId()!, 'asset:1');

      expect(store().isEmpty()).toBe(true);
    });
  });
});
