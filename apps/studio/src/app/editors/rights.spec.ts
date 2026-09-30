// Rights windows in Studio (EP-31): the form's body is what Scheduling is sent, whole, in instants;
// a change carries the version it was read at, and a 409 is a reload, never a retry; the service's
// 422 lands under the control it names; the Schedule panel shows the view only to whoever may read
// asset rights, and the create form only to whoever may write them.

import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RightsWindow, RightsWindowInput } from '../core/generated/scheduling.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { RightsService } from '../core/rights.service.ts';
import { SchedulesService } from '../core/schedules.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { SchedulePanel } from '../panels/schedule-panel.ts';
import { RightsView } from '../panels/schedule/rights-view.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import { RightsWindowEditor } from './rights-window-editor.ts';
import { draftOf, inputOf, localInput } from './rights-window.model.ts';

const ID = '01RIGHTS00000000000000000A';
const ASSET = '01ASSET000000000000000000A';
const stored = (over: Partial<RightsWindow> = {}): RightsWindow => ({
  id: ID,
  channelId: 'ch12',
  assetId: ASSET,
  validFrom: '2026-10-01T08:00:00.000Z',
  validTo: '2026-12-31T22:00:00.000Z',
  territory: 'GB',
  version: 3,
  createdBy: 'lib',
  createdAt: '2026-09-30T10:00:00.000Z',
  updatedAt: '2026-09-30T10:00:00.000Z',
  ...over,
});

function withoutAsset(w: RightsWindow): RightsWindow {
  const { assetId: _a, ...rest } = w;
  void _a;
  return rest;
}

class FakeRights {
  readonly lists: Subject<RightsWindow[]>[] = [];
  readonly gets: Subject<RightsWindow>[] = [];
  readonly creates: { body: RightsWindowInput; result: Subject<RightsWindow> }[] = [];
  readonly replaces: {
    id: string;
    version: number;
    body: RightsWindowInput;
    result: Subject<RightsWindow>;
  }[] = [];
  readonly removes: { id: string; version: number; result: Subject<void> }[] = [];
  list() {
    const s = new Subject<RightsWindow[]>();
    this.lists.push(s);
    return s;
  }
  get() {
    const s = new Subject<RightsWindow>();
    this.gets.push(s);
    return s;
  }
  create(body: RightsWindowInput) {
    const result = new Subject<RightsWindow>();
    this.creates.push({ body, result });
    return result;
  }
  replace(id: string, version: number, body: RightsWindowInput) {
    const result = new Subject<RightsWindow>();
    this.replaces.push({ id, version, body, result });
    return result;
  }
  remove(id: string, version: number) {
    const result = new Subject<void>();
    this.removes.push({ id, version, result });
    return result;
  }
}

class FakeSchedules {
  list() {
    return new Subject();
  }
}

function configure(
  rules: { id: string; permissions: string[]; fieldGroups?: string[] }[] = [
    { id: 'read', permissions: ['asset:read', 'schedule:read'] },
    { id: 'rights', permissions: ['asset:write'], fieldGroups: ['rights'] },
  ],
) {
  TestBed.configureTestingModule({
    providers: [
      EditorStore,
      { provide: RightsService, useValue: new FakeRights() },
      { provide: SchedulesService, useValue: new FakeSchedules() },
      { provide: LocaleService, useValue: { t: (k: string) => k } },
    ],
  });
  TestBed.inject(SessionStore).signIn({
    userId: 'lib',
    channelId: 'ch12',
    policy: {
      subjectId: 'lib',
      permVersion: 1,
      rules: rules.map((r) => ({ ...r, scope: { channelIds: ['ch12'] } })),
    },
  });
  return {
    api: TestBed.inject(RightsService) as unknown as FakeRights,
    editors: TestBed.inject(EditorStore),
  };
}

describe('rights window form model', () => {
  it('round-trips — opening a window is not an edit — and sends instants, not wall-clock text', () => {
    const w = stored();
    expect(inputOf(draftOf(w))).toEqual({
      assetId: ASSET,
      validFrom: w.validFrom,
      validTo: w.validTo,
      territory: 'GB',
    });
    expect(draftOf(w).from).toBe(localInput(w.validFrom));
  });

  it('names one subject; empty optional fields are left out; what does not parse is sent as typed', () => {
    const d = {
      ...draftOf(stored()),
      subject: 'category' as const,
      subjectId: ' films ',
      territory: ' ',
      to: 'not a time',
    };
    const body = inputOf(d);
    expect(body).toEqual({
      categoryId: 'films',
      validFrom: stored().validFrom,
      validTo: 'not a time',
    });
  });
});

describe('RightsView', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('lists the channel’s windows, creates one in instants and opens it as a tab', () => {
    const { api, editors } = configure();
    const fixture = TestBed.createComponent(RightsView);
    fixture.detectChanges();
    api.lists[0]!.next([stored()]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.items')?.textContent).toContain(`rights.subject.asset ${ASSET}`);
    expect(root.querySelector('.items')?.textContent).toContain('GB');

    const view = fixture.componentInstance as unknown as {
      draft: { subject: string; subjectId: string; from: string; to: string };
      create(): void;
    };
    view.draft = {
      ...view.draft,
      subject: 'category',
      subjectId: 'films',
      from: '2026-10-01T00:00',
      to: '2026-10-02T00:00',
    };
    view.create();
    expect(api.creates[0]!.body).toEqual({
      categoryId: 'films',
      validFrom: new Date('2026-10-01T00:00').toISOString(),
      validTo: new Date('2026-10-02T00:00').toISOString(),
    });
    api.creates[0]!.result.next({
      ...withoutAsset(stored()),
      id: '01RIGHTS00000000000000000B',
      categoryId: 'films',
    });
    const tabs = editors.groups().flatMap((g) => g.tabs);
    expect(tabs.map((t) => [t.type, t.title])).toEqual([['rights-window', 'films']]);
  });

  it('someone who may only read rights sees the list and no create form', () => {
    configure([{ id: 'read', permissions: ['asset:read'] }]);
    const fixture = TestBed.createComponent(RightsView);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('details.new')).toBeNull();
  });
});

describe('SchedulePanel views', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('offers Rights only to whoever may read asset rights', () => {
    configure();
    let fixture = TestBed.createComponent(SchedulePanel);
    fixture.detectChanges();
    const tabs = (f: typeof fixture) =>
      [...(f.nativeElement as HTMLElement).querySelectorAll('[role=tab]')].map((t) =>
        t.textContent?.trim(),
      );
    expect(tabs(fixture)).toEqual(['schedulePanel.view.days', 'schedulePanel.view.rights']);

    TestBed.resetTestingModule();
    configure([{ id: 'read', permissions: ['asset:read'], fieldGroups: ['core'] }]);
    fixture = TestBed.createComponent(SchedulePanel);
    fixture.detectChanges();
    expect(tabs(fixture)).toEqual([]);
  });
});

describe('RightsWindowEditor', () => {
  beforeEach(() => TestBed.resetTestingModule());

  function open(rules?: Parameters<typeof configure>[0]) {
    const ctx = configure(rules);
    ctx.editors.open({ type: 'rights-window', resourceId: ID, title: ASSET });
    const fixture = TestBed.createComponent(RightsWindowEditor);
    fixture.componentRef.setInput('windowId', ID);
    fixture.componentRef.setInput('tabId', `rights-window:${ID}`);
    fixture.detectChanges();
    ctx.api.gets[0]!.next(stored());
    fixture.detectChanges();
    const editor = fixture.componentInstance as unknown as {
      set(key: string, value: unknown): void;
      save(): void;
      remove(): void;
      reload(): void;
      conflict(): boolean;
      problemsFor(control: string): readonly string[];
      readOnly(): boolean;
      dirty(): boolean;
    };
    return { ...ctx, fixture, editor };
  }

  it('saves the whole window over the version it read', () => {
    const { api, editor } = open();
    editor.set('territory', 'IE');
    expect(editor.dirty()).toBe(true);
    editor.save();
    expect(api.replaces[0]).toMatchObject({ id: ID, version: 3 });
    expect(api.replaces[0]!.body).toEqual({
      assetId: ASSET,
      validFrom: stored().validFrom,
      validTo: stored().validTo,
      territory: 'IE',
    });
    api.replaces[0]!.result.next(stored({ territory: 'IE', version: 4 }));
    expect(editor.dirty()).toBe(false);
  });

  it('a 409 says someone else changed it and offers a reload — it never re-sends', () => {
    const { api, editor, fixture } = open();
    editor.set('territory', 'IE');
    editor.save();
    api.replaces[0]!.result.error({ status: 409, error: { message: 'not at version 3' } });
    fixture.detectChanges();
    expect(editor.conflict()).toBe(true);
    expect(api.replaces).toHaveLength(1);
    editor.reload();
    expect(api.gets).toHaveLength(2);
  });

  it('the service’s 422 lands under the control it names', () => {
    const { api, editor } = open();
    editor.set('to', '2026-09-01T00:00');
    editor.save();
    api.replaces[0]!.result.error({
      status: 422,
      error: { message: 'validTo must be after validFrom; assetId must be a ULID' },
    });
    expect(editor.problemsFor('to')).toEqual(['validTo must be after validFrom']);
    expect(editor.problemsFor('subjectId')).toEqual(['assetId must be a ULID']);
  });

  it('removes at the version read and closes its tab', () => {
    const { api, editor, editors } = open();
    editor.remove();
    expect(api.removes[0]).toMatchObject({ id: ID, version: 3 });
    api.removes[0]!.result.next();
    expect(editors.groups().flatMap((g) => g.tabs)).toHaveLength(0);
  });

  it('someone who may only read rights sees the terms and cannot change them', () => {
    const { editor, fixture } = open([{ id: 'read', permissions: ['asset:read'] }]);
    expect(editor.readOnly()).toBe(true);
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('fieldset')?.disabled).toBe(true);
    expect(root.querySelector('button.danger')).toBeNull();
  });
});
