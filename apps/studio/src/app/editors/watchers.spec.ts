// Folder watchers in Studio (EP-15.2): the form's body is what RIM is sent, whole; RIM's 422 lands
// under the field it names and its 409 (a folder another watcher has) above the form; a new watcher
// opens as its own tab; someone without ingest:admin sees the settings and cannot change them.

import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Watcher, WatcherInput } from '../core/generated/rim.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { WatchersService } from '../core/watchers.service.ts';
import { WatchersView } from '../panels/ingest/watchers-view.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import { WatcherEditor, draftOf, inputOf } from './watcher-editor.ts';

const ID = '01WATCHER0000000000000000A';
const stored = (over: Partial<Watcher> = {}): Watcher => ({
  id: ID,
  channelId: 'ch12',
  name: 'Playout drops',
  path: 'playout',
  settleSeconds: 10,
  afterPickup: 'delete',
  enabled: true,
  createdBy: 'admin',
  createdAt: '2026-09-26T10:00:00.000Z',
  updatedAt: '2026-09-26T10:00:00.000Z',
  version: 1,
  ...over,
});

class FakeWatchers {
  readonly gets: Subject<Watcher>[] = [];
  readonly creates: { body: WatcherInput; result: Subject<Watcher> }[] = [];
  readonly replaces: { id: string; body: WatcherInput; result: Subject<Watcher> }[] = [];
  get() {
    const s = new Subject<Watcher>();
    this.gets.push(s);
    return s;
  }
  create(body: WatcherInput) {
    const result = new Subject<Watcher>();
    this.creates.push({ body, result });
    return result;
  }
  replace(id: string, body: WatcherInput) {
    const result = new Subject<Watcher>();
    this.replaces.push({ id, body, result });
    return result;
  }
}

function configure(permissions: string[] = ['ingest:admin']) {
  TestBed.configureTestingModule({
    providers: [
      EditorStore,
      { provide: WatchersService, useValue: new FakeWatchers() },
      { provide: LocaleService, useValue: { t: (k: string) => k } },
    ],
  });
  TestBed.inject(SessionStore).signIn({
    userId: 'admin',
    channelId: 'ch12',
    policy: {
      subjectId: 'admin',
      permVersion: 1,
      rules: [{ id: 'r', permissions, scope: { channelIds: ['ch12'] } }],
    },
  });
  return {
    api: TestBed.inject(WatchersService) as unknown as FakeWatchers,
    editors: TestBed.inject(EditorStore),
  };
}

describe('watcher form model', () => {
  it('sends the whole watcher; extensions are parsed as typed, and empty means every file', () => {
    const d = { ...draftOf(stored()), extensions: '.MXF, mov  wav,,' };
    expect(inputOf(d)).toEqual({
      name: 'Playout drops',
      path: 'playout',
      settleSeconds: 10,
      extensions: ['mxf', 'mov', 'wav'],
      afterPickup: 'delete',
      enabled: true,
    });
    expect(inputOf({ ...d, extensions: '  ' }).extensions).toEqual([]);
    // An emptied settle box is RIM's default, not a zero.
    expect(inputOf({ ...d, settleSeconds: null })).not.toHaveProperty('settleSeconds');
  });

  it('round-trips, so opening a watcher is not an edit', () => {
    const w = stored({ extensions: ['mxf'], afterPickup: 'keep' });
    expect(inputOf(draftOf(w))).toEqual({
      name: w.name,
      path: w.path,
      settleSeconds: w.settleSeconds,
      extensions: ['mxf'],
      afterPickup: 'keep',
      enabled: true,
    });
    expect(draftOf(w).extensions).toBe('mxf');
  });
});

describe('WatchersView', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it("creates with RIM's defaults, announces it, and opens it; RIM's refusal is shown as said", () => {
    const { api, editors } = configure();
    const fixture = TestBed.createComponent(WatchersView);
    fixture.componentRef.setInput('watchers', [stored({ enabled: false })]);
    const created: Watcher[] = [];
    fixture.componentInstance.created.subscribe((w) => created.push(w));
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.items')?.textContent).toContain('watchers.disabled');

    const view = fixture.componentInstance as unknown as {
      name: string;
      path: string;
      create(): void;
    };
    view.name = ' News desk ';
    view.path = 'news';
    view.create();
    expect(api.creates[0]?.body).toEqual({ name: 'News desk', path: 'news' });
    api.creates[0]?.result.next(stored({ id: '01NEWS', name: 'News desk', path: 'news' }));
    expect(created.map((w) => w.id)).toEqual(['01NEWS']);
    expect(editors.activeTab()?.type).toBe('watcher');
    expect(editors.activeTab()?.resourceId).toBe('01NEWS');

    view.name = 'Out';
    view.path = '../ch99';
    view.create();
    api.creates[1]?.result.error({
      status: 422,
      error: {
        message: "path is relative to the channel's watch directory, and never climbs out of it",
      },
    });
    fixture.detectChanges();
    expect(root.querySelector('[role=alert]')?.textContent).toContain('never climbs out');
  });
});

describe('WatcherEditor', () => {
  beforeEach(() => TestBed.resetTestingModule());

  function open(t: ReturnType<typeof configure>) {
    t.editors.open({ type: 'watcher', resourceId: ID, title: 'w', icon: '⌖' });
    const fixture = TestBed.createComponent(WatcherEditor);
    fixture.componentRef.setInput('watcherId', ID);
    fixture.componentRef.setInput('tabId', t.editors.activeTab()!.id);
    fixture.detectChanges();
    t.api.gets[0]?.next(stored());
    fixture.detectChanges();
    const editor = fixture.componentInstance as unknown as {
      set(key: string, value: unknown): void;
      save(): void;
    };
    return { fixture, editor, root: fixture.nativeElement as HTMLElement };
  }

  it("saves the whole watcher; RIM's 422 lands under its field, its 409 above the form", () => {
    const t = configure();
    const { fixture, editor, root } = open(t);
    const save = () => root.querySelector<HTMLButtonElement>('button[type=submit]')!;
    expect(save().disabled).toBe(true);

    editor.set('path', 'link-out');
    editor.set('afterPickup', 'keep');
    fixture.detectChanges();
    expect(t.editors.activeTab()?.dirty).toBe(true);
    editor.save();
    expect(t.api.replaces[0]).toMatchObject({
      id: ID,
      body: { name: 'Playout drops', path: 'link-out', afterPickup: 'keep', extensions: [] },
    });
    t.api.replaces[0]?.result.error({
      status: 422,
      error: { message: "path resolves outside the channel's watch directory" },
    });
    fixture.detectChanges();
    const pathLabel = root.querySelector('input[name=path]')!.closest('label')!;
    expect(pathLabel.textContent).toContain('resolves outside');

    editor.set('path', 'shared');
    editor.save();
    t.api.replaces[1]?.result.error({
      status: 409,
      error: { message: 'watcher 01OTHER already watches shared; disable it first' },
    });
    fixture.detectChanges();
    expect(root.querySelector('[role=alert]')?.textContent).toContain('already watches shared');

    editor.save();
    t.api.replaces[2]?.result.next(stored({ path: 'shared', afterPickup: 'keep', version: 2 }));
    fixture.detectChanges();
    expect(root.textContent).toContain('v2');
    expect(t.editors.activeTab()?.dirty).toBe(false);
  });

  it('is read-only without ingest:admin', () => {
    const { root } = open(configure(['ingest:read']));
    expect(root.querySelector('fieldset')?.disabled).toBe(true);
    expect(root.querySelector('button[type=submit]')).toBeNull();
  });
});
