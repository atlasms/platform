// Recorders in Studio (EP-39; ADR-0007): the body is the whole recorder with days in week order;
// a new one starts switched OFF; RIM's reasons land under the field they name; the captures show
// in the recorder's own zone, and a missed one — a hole in the recording — is marked.

import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Capture, Recorder, RecorderInput } from '../core/generated/rim.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { RecordersService } from '../core/recorders.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { RecordersView } from '../panels/ingest/recorders-view.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import { RecorderEditor } from './recorder-editor.ts';
import { allDay, describeWindows, draftOf, inputOf, localTime } from './recorder.model.ts';
import { describeScope, inputOfSet, scopeOf } from './rule-set.model.ts';

const ID = '01RECORDER000000000000000A';
const stored = (over: Partial<Recorder> = {}): Recorder => ({
  id: ID,
  channelId: 'ch12',
  name: 'Channel 1 air',
  input: { url: 'udp://239.1.1.1:5000' },
  timezone: 'Europe/London',
  windows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '06:00', to: '24:00' }],
  fileMinutes: 60,
  padSeconds: 5,
  enabled: true,
  createdBy: 'admin',
  createdAt: '2026-09-27T10:00:00.000Z',
  updatedAt: '2026-09-27T10:00:00.000Z',
  version: 1,
  ...over,
});

describe('recorder model', () => {
  it('sends the whole recorder, days in week order however they were ticked, no empty secret', () => {
    const d = draftOf(stored());
    d.windows[0]!.days = ['fri', 'mon', 'wed'];
    expect(inputOf(d)).toEqual({
      name: 'Channel 1 air',
      input: { url: 'udp://239.1.1.1:5000' },
      timezone: 'Europe/London',
      windows: [{ days: ['mon', 'wed', 'fri'], from: '06:00', to: '24:00' }],
      fileMinutes: 60,
      padSeconds: 5,
      enabled: true,
    });
    // Round trip: opening a recorder is not an edit.
    const r = stored({ input: { url: 'srt://e:9000', passphraseSecret: 'srt/ch1' } });
    expect(inputOf(draftOf(r))).toEqual({
      name: r.name,
      input: r.input,
      timezone: r.timezone,
      windows: r.windows,
      fileMinutes: 60,
      padSeconds: 5,
      enabled: true,
    });
  });

  it('says a recorder’s windows in one line, and a capture’s time in its zone', () => {
    expect(
      describeWindows([
        { days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '06:00', to: '24:00' },
        { days: ['sat', 'sun'], from: '08:00', to: '22:00' },
        { days: ['mon', 'wed'], from: '01:00', to: '02:00' },
      ]),
    ).toBe('mon–fri 06:00–24:00; sat, sun 08:00–22:00; mon, wed 01:00–02:00');
    expect(describeWindows([allDay()])).toBe('mon–sun 00:00–24:00');
    // 12:00 UTC is 13:00 in London in September (BST).
    expect(localTime('2026-09-28T12:00:00.000Z', 'Europe/London')).toBe('13:00:00');
  });

  it('a rule set scoped to ONE recorder round-trips as a recorder, not a watcher', () => {
    const scope = { sourceKind: 'recorder' as const, sourceId: ID };
    expect(scopeOf(scope)).toBe(`source:recorder:${ID}`);
    const body = inputOfSet({ name: 'x', enabled: true, scope: scopeOf(scope), rules: [] });
    expect(body.scope).toEqual(scope);
    const t = (k: string) => k;
    expect(
      describeScope(scope, t, (kind, id) =>
        kind === 'recorder' && id === ID ? 'Channel 1 air' : undefined,
      ),
    ).toBe('Channel 1 air');
    expect(describeScope({ sourceKind: 'recorder', sourceId: '01GONE' }, t, () => undefined)).toBe(
      'rules.scope.kind.recorder (01GONE)',
    );
  });
});

class FakeRecorders {
  readonly gets: Subject<Recorder>[] = [];
  readonly captureReads: Subject<Capture[]>[] = [];
  readonly creates: { body: RecorderInput; result: Subject<Recorder> }[] = [];
  readonly replaces: { id: string; body: RecorderInput; result: Subject<Recorder> }[] = [];
  get() {
    const s = new Subject<Recorder>();
    this.gets.push(s);
    return s;
  }
  captures() {
    const s = new Subject<Capture[]>();
    this.captureReads.push(s);
    return s;
  }
  create(body: RecorderInput) {
    const result = new Subject<Recorder>();
    this.creates.push({ body, result });
    return result;
  }
  replace(id: string, body: RecorderInput) {
    const result = new Subject<Recorder>();
    this.replaces.push({ id, body, result });
    return result;
  }
}

function configure(permissions: string[] = ['ingest:admin']) {
  TestBed.configureTestingModule({
    providers: [
      EditorStore,
      { provide: RecordersService, useValue: new FakeRecorders() },
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
    api: TestBed.inject(RecordersService) as unknown as FakeRecorders,
    editors: TestBed.inject(EditorStore),
  };
}

describe('RecordersView', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('lists windows in a line; a new recorder starts OFF, all day, hourly, and opens', () => {
    const { api, editors } = configure();
    const fixture = TestBed.createComponent(RecordersView);
    fixture.componentRef.setInput('recorders', [stored({ enabled: false })]);
    fixture.detectChanges();
    const row = (fixture.nativeElement as HTMLElement).querySelector('.items button')!;
    expect(row.textContent).toContain('mon–fri 06:00–24:00 (Europe/London)');
    expect(row.textContent).toContain('recorders.disabled');

    const view = fixture.componentInstance as unknown as {
      name: string;
      url: string;
      create(): void;
    };
    view.name = 'News 24';
    view.url = 'srt://encoder:9000';
    view.create();
    const body = api.creates[0]!.body;
    expect(body).toMatchObject({
      name: 'News 24',
      input: { url: 'srt://encoder:9000' },
      windows: [allDay()],
      fileMinutes: 60,
      padSeconds: 5,
      enabled: false,
    });
    expect(body.timezone).toBeTruthy();
    api.creates[0]!.result.next(stored({ id: '01NEWS', name: 'News 24', enabled: false }));
    expect(editors.activeTab()?.type).toBe('recorder');
    expect(editors.activeTab()?.resourceId).toBe('01NEWS');
  });
});

describe('RecorderEditor', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const capture = (over: Partial<Capture>): Capture => ({
    id: '01C',
    recorderId: ID,
    channelId: 'ch12',
    fileStart: '2026-09-28T12:00:00.000Z',
    fileEnd: '2026-09-28T13:00:00.000Z',
    captureFrom: '2026-09-28T11:59:55.000Z',
    captureTo: '2026-09-28T13:00:05.000Z',
    slot: 0,
    part: 1,
    state: 'completed',
    ...over,
  });

  function open(t: ReturnType<typeof configure>) {
    t.editors.open({ type: 'recorder', resourceId: ID, title: 'r', icon: '●' });
    const fixture = TestBed.createComponent(RecorderEditor);
    fixture.componentRef.setInput('recorderId', ID);
    fixture.componentRef.setInput('tabId', t.editors.activeTab()!.id);
    fixture.detectChanges();
    t.api.gets[0]?.next(stored());
    t.api.captureReads[0]?.next([
      capture({ id: '01A', holder: 'rim-recorder-0' }),
      capture({
        id: '01B',
        fileStart: '2026-09-28T13:00:00.000Z',
        fileEnd: '2026-09-28T14:00:00.000Z',
        state: 'missed',
        reason: 'no recorder worker took it',
      }),
    ] as Capture[]);
    fixture.detectChanges();
    const editor = fixture.componentInstance as unknown as {
      toggleDay(i: number, day: string, on: boolean): void;
      addWindow(): void;
      save(): void;
    };
    return { fixture, editor, root: fixture.nativeElement as HTMLElement };
  }

  it('shows captures in the recorder’s zone and marks the missed one; saves the whole recorder; places RIM’s reasons', () => {
    const t = configure();
    const { fixture, editor, root } = open(t);
    const rows = root.querySelectorAll('table.captures tbody tr');
    expect(rows[0]?.textContent).toContain('13:00:00–14:00:00'); // BST
    expect(rows[0]?.textContent).toContain('rim-recorder-0');
    expect(rows[1]?.classList.contains('hole')).toBe(true);
    expect(rows[1]?.textContent).toContain('recorders.captureState.missed');
    expect(rows[1]?.textContent).toContain('no recorder worker took it');

    editor.toggleDay(0, 'sat', true);
    editor.addWindow();
    fixture.detectChanges();
    expect(t.editors.activeTab()?.dirty).toBe(true);
    editor.save();
    expect(t.api.replaces[0]?.body.windows).toEqual([
      { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], from: '06:00', to: '24:00' },
      { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '00:00', to: '24:00' },
    ]);

    t.api.replaces[0]?.result.error({
      status: 422,
      error: {
        message:
          'input.url must carry no credential; name its Secret in input.passphraseSecret; windows[1].to must be after from — a window across midnight is two windows',
      },
    });
    fixture.detectChanges();
    const urlLabel = root.querySelector('input[name=url]')!.closest('label')!;
    expect(urlLabel.textContent).toContain('must carry no credential');
    const windows = root.querySelector('section')!;
    expect(windows.textContent).toContain('windows[1].to must be after from');

    editor.save();
    t.api.replaces[1]?.result.next(stored({ version: 2 }));
    fixture.detectChanges();
    expect(root.textContent).toContain('v2');
    expect(t.api.captureReads.length).toBe(2); // re-read: RIM planned again
  });

  it('is read-only without ingest:admin', () => {
    const { root } = open(configure(['ingest:read']));
    expect(root.querySelector('fieldset')?.disabled).toBe(true);
    expect(root.querySelector('button[type=submit]')).toBeNull();
  });
});
