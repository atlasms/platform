// The editor area's tabs are keyboard-operable (angular-eslint's template accessibility rules
// found them clickable only): each is a focusable `role="tab"` that Enter and Space select, and
// the same keys on its close button close it without re-selecting it on the way.

import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { ProfilesService } from '../core/profiles.service.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import { LocaleService } from '../core/locale.service.ts';
import { EditorArea } from './editor-area.ts';
import { EditorStore } from './editor.store.ts';

function setup() {
  TestBed.configureTestingModule({
    providers: [EditorStore, { provide: LocaleService, useValue: { t: (k: string) => k } }],
  });
  const store = TestBed.inject(EditorStore);
  // Tab types with no editor render the placeholder pane, so nothing else needs providing.
  store.open({ type: 'note', resourceId: 'a', title: 'A', icon: '·' });
  store.open({ type: 'note', resourceId: 'b', title: 'B', icon: '·' });
  const fixture = TestBed.createComponent(EditorArea);
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  const tab = (title: string) =>
    Array.from(root.querySelectorAll<HTMLElement>('[role=tab]')).find(
      (t) => t.querySelector('.label')?.textContent === title,
    )!;
  return { store, fixture, root, tab };
}

const key = (target: HTMLElement, name: string) =>
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
  );

describe('EditorArea tabs', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('are focusable tabs in a tablist, the active one marked selected', () => {
    const { root, tab } = setup();
    expect(root.querySelector('[role=tablist]')).not.toBeNull();
    expect(tab('A').tabIndex).toBe(0);
    expect(tab('B').getAttribute('aria-selected')).toBe('true');
    expect(tab('A').getAttribute('aria-selected')).toBe('false');
  });

  it('select on Enter and on Space, which does not scroll', () => {
    const { store, fixture, tab } = setup();
    key(tab('A'), 'Enter');
    fixture.detectChanges();
    expect(store.activeTab()?.resourceId).toBe('a');

    const notCancelled = key(tab('B'), ' ');
    fixture.detectChanges();
    expect(store.activeTab()?.resourceId).toBe('b');
    expect(notCancelled).toBe(false); // preventDefault'ed
  });

  it('leave keys on the close button to the button: Enter there does not select the tab', () => {
    const { store, fixture, tab } = setup();
    const close = tab('A').querySelector<HTMLElement>('button.close')!;
    key(close, 'Enter');
    fixture.detectChanges();
    expect(store.activeTab()?.resourceId).toBe('b');
  });
});

describe('EditorArea editors', () => {
  beforeEach(() => TestBed.resetTestingModule());

  // Each editor kind is `@defer`red out of the initial bundle. The risk of that is quiet: a
  // wrapper that never resolves still compiles, and the pane shows "Opening…" forever.
  it('render a deferred editor once its chunk has loaded, with a placeholder meanwhile', async () => {
    TestBed.configureTestingModule({
      providers: [
        EditorStore,
        { provide: LocaleService, useValue: { t: (k: string) => k } },
        { provide: ProfilesService, useValue: { get: () => new Subject() } },
      ],
    });
    TestBed.inject(EditorStore).open({
      type: 'profile',
      resourceId: 'channel/broadcast',
      title: 'Broadcast',
      icon: '⚙',
    });
    const fixture = TestBed.createComponent(EditorArea);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('atlas-profile-editor')).toBeNull();
    expect(root.textContent).toContain('editor.loading');

    await fixture.whenStable();
    fixture.detectChanges();
    expect(root.querySelector('atlas-profile-editor')).not.toBeNull();
    expect(root.textContent).not.toContain('editor.loading');
  });
});
