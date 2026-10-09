import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  CopyResult,
  CopyScheduleInput,
  CreateSchedule,
  Schedule,
  SchedulePage,
  ScheduleItem,
  ScheduleItemInput,
  ScheduleWithItems,
  ValidationReport,
} from '../core/generated/scheduling.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { SchedulesService } from '../core/schedules.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { WebSocketService } from '../core/websocket.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import type { ReelRow } from './reel.model.ts';
import { ScheduleEditor } from './schedule-editor.ts';

const SID = '01K0000000000000000000SCHD';
const T0 = '2026-09-12T06:00:00.000Z';
const at = (min: number): string => new Date(Date.parse(T0) + min * 60_000).toISOString();

const header = (overrides: Partial<Schedule> = {}): Schedule => ({
  id: SID,
  channelId: 'ch12',
  broadcastDate: '2026-09-12',
  timezone: 'UTC',
  state: 'draft',
  version: 1,
  createdAt: T0,
  updatedAt: T0,
  ...overrides,
});

const item = (
  id: string,
  seq: number,
  startMin: number,
  durationMin: number,
  extra: Partial<ScheduleItem> = {},
): ScheduleItem => ({
  id,
  scheduleId: SID,
  seq,
  start: at(startMin),
  durationSec: durationMin * 60,
  end: at(startMin + durationMin),
  fixed: false,
  itemType: 'media',
  mediaId: `m-${id}`,
  mediaTitle: `Clip ${id}`,
  description: '',
  repeat: false,
  featured: false,
  ...extra,
});

class FakeSchedules {
  readonly gets: Array<{ id: string; result: Subject<ScheduleWithItems> }> = [];
  readonly saves: Array<{
    id: string;
    items: ScheduleItemInput[];
    result: Subject<ScheduleItem[]>;
  }> = [];

  get(id: string) {
    const result = new Subject<ScheduleWithItems>();
    this.gets.push({ id, result });
    return result;
  }

  replaceItems(id: string, items: ScheduleItemInput[]) {
    const result = new Subject<ScheduleItem[]>();
    this.saves.push({ id, items, result });
    return result;
  }

  readonly lists: Array<{ broadcastDate?: string; result: Subject<SchedulePage> }> = [];
  list(options: { broadcastDate?: string }) {
    const result = new Subject<SchedulePage>();
    this.lists.push({ ...options, result });
    return result;
  }

  readonly creates: Array<{ body: CreateSchedule; result: Subject<Schedule> }> = [];
  create(body: CreateSchedule) {
    const result = new Subject<Schedule>();
    this.creates.push({ body, result });
    return result;
  }

  readonly copies: Array<{ id: string; body: CopyScheduleInput; result: Subject<CopyResult> }> = [];
  copy(id: string, body: CopyScheduleInput) {
    const result = new Subject<CopyResult>();
    this.copies.push({ id, body, result });
    return result;
  }

  readonly validations: Array<{ id: string; result: Subject<ValidationReport> }> = [];
  validate(id: string) {
    const result = new Subject<ValidationReport>();
    this.validations.push({ id, result });
    return result;
  }
}

class FakeLocale {
  locale = () => 'en';
  loading = () => false;
  t(key: string): string {
    return key;
  }
  setLocale(_locale: 'en' | 'ar'): Promise<void> {
    return Promise.resolve();
  }
}

interface Internal {
  rows: () => readonly ReelRow[];
  top: () => ReelRow[];
  dirty: () => boolean;
  saved: () => boolean;
  saveError: () => string | null;
  overlapCount: () => number;
  formError: () => string | null;
  mayEdit: () => boolean;
  setForm(field: string, value: unknown): void;
  add(event: Event): void;
  moveRow(key: string, direction: 'up' | 'down'): void;
  removeRow(key: string): void;
  toggleFixed(key: string, fixed: boolean): void;
  setDuration(key: string, minutes: string): void;
  save(): void;
  gapBefore(key: string): number | undefined;
  validate(): void;
  report: () => ValidationReport | null;
  validateError: () => string | null;
  schedule: () => Schedule | null;
  setCopy(field: string, value: string): void;
  copy(event: Event): void;
  copyForm: () => { from: string; to: string; date: string; at: string; mode: string };
  copyError: () => string | null;
  copyDone: () => string | null;
}

function setup(permissions: string[] = ['schedule:read', 'schedule:write']) {
  localStorage.clear();
  const fake = new FakeSchedules();
  TestBed.configureTestingModule({
    providers: [
      EditorStore,
      { provide: SchedulesService, useValue: fake },
      { provide: LocaleService, useClass: FakeLocale },
    ],
  });
  TestBed.inject(SessionStore).signIn({
    userId: 'u1',
    channelId: 'ch12',
    policy: { subjectId: 'u1', permVersion: 1, rules: [{ id: 'r', permissions }] },
  });
  const editors = TestBed.inject(EditorStore);
  editors.open({ type: 'schedule', resourceId: SID, title: 'Schedule 2026-09-12' });

  const fixture = TestBed.createComponent(ScheduleEditor);
  fixture.componentRef.setInput('scheduleId', SID);
  fixture.componentRef.setInput('tabId', `schedule:${SID}`);
  fixture.detectChanges();
  const ws = TestBed.inject(WebSocketService);
  return {
    fixture,
    component: fixture.componentInstance as unknown as Internal,
    fake,
    editors,
    ws,
  };
}

/** The three-item reel most tests start from: 06:00–06:30, 06:30–06:40, 06:40–06:45. */
function loaded(
  t: ReturnType<typeof setup>,
  items = [item('a', 0, 0, 30), item('b', 1, 30, 10), item('c', 2, 40, 5)],
) {
  t.fake.gets[0]?.result.next({ ...header(), items });
  t.fixture.detectChanges();
  return t;
}

const keys = (rows: readonly ReelRow[]) => rows.map((r) => r.key);
const startMin = (r: ReelRow) => (Date.parse(r.start) - Date.parse(T0)) / 60_000;

describe('ScheduleEditor', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('loads the schedule with its reel and renders the rows in reel order, with wall-clock times', () => {
    const t = loaded(setup());
    expect(t.fake.gets[0]?.id).toBe(SID);
    expect(keys(t.component.top())).toEqual(['a', 'b', 'c']);
    const root = t.fixture.nativeElement as HTMLElement;
    const cells = [...root.querySelectorAll('tbody tr:not(.gap) td.time')].map((td) =>
      td.textContent?.trim(),
    );
    expect(cells.slice(0, 2)).toEqual(['06:00:00', '06:30:00']);
    expect(t.component.dirty()).toBe(false);
  });

  it('adds an item at the end of the reel, re-timed, and marks the tab dirty', () => {
    const t = loaded(setup());
    t.component.setForm('itemType', 'media');
    t.component.setForm('minutes', '15');
    t.component.setForm('mediaId', '01K00000000000000000000MEDIA');
    t.component.setForm('title', 'Weather');
    t.component.add(new Event('submit'));

    const top = t.component.top();
    expect(top).toHaveLength(4);
    expect(startMin(top[3] as ReelRow)).toBe(45);
    expect(top[3]?.mediaTitle).toBe('Weather');
    expect(top[3]?.id).toBeUndefined();
    expect(t.component.dirty()).toBe(true);
    expect(t.editors.activeTab()?.dirty).toBe(true);
  });

  it('refuses a media item without a media id, and a zero duration, without touching the reel', () => {
    const t = loaded(setup());
    t.component.setForm('minutes', '10');
    t.component.setForm('mediaId', '');
    t.component.add(new Event('submit'));
    expect(t.component.formError()).toBe('scheduleEditor.mediaRequired');
    t.component.setForm('mediaId', 'm');
    t.component.setForm('minutes', '0');
    t.component.add(new Event('submit'));
    expect(t.component.formError()).toBe('scheduleEditor.invalidDuration');
    expect(t.component.top()).toHaveLength(3);
    expect(t.component.dirty()).toBe(false);
  });

  it('a live item needs no media id', () => {
    const t = loaded(setup());
    t.component.setForm('itemType', 'live');
    t.component.setForm('minutes', '60');
    t.component.add(new Event('submit'));
    expect(t.component.top()[3]?.itemType).toBe('live');
    expect(t.component.top()[3]?.mediaId).toBeUndefined();
  });

  it('a fixed item lands at its wall-clock time in the schedule’s zone; a gap before it is flagged, not blocked', () => {
    const t = loaded(setup());
    t.component.setForm('itemType', 'title');
    t.component.setForm('minutes', '1');
    t.component.setForm('fixed', true);
    t.component.setForm('time', '07:00');
    t.component.add(new Event('submit'));
    const anchor = t.component.top()[3] as ReelRow;
    expect(startMin(anchor)).toBe(60);
    expect(anchor.fixed).toBe(true);
    expect(t.component.gapBefore(anchor.key)).toBe(15 * 60);
    expect(t.component.overlapCount()).toBe(0);
    t.fixture.detectChanges();
    const root = t.fixture.nativeElement as HTMLElement;
    expect(root.querySelector('tr.gap')?.textContent).toContain('scheduleEditor.gap');
    expect((root.querySelector('.actions button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a fixed time is read in the SCHEDULE’S zone, not the browser’s: 07:00 London in September is 06:00Z', () => {
    const t = setup();
    t.fake.gets[0]?.result.next({ ...header({ timezone: 'Europe/London' }), items: [] });
    t.fixture.detectChanges();
    t.component.setForm('itemType', 'title');
    t.component.setForm('minutes', '1');
    t.component.setForm('fixed', true);
    t.component.setForm('time', '07:00');
    t.component.add(new Event('submit'));
    expect(t.component.top()[0]?.start).toBe('2026-09-12T06:00:00.000Z');
    // And the clock column shows it back as 07:00 in that zone.
    t.fixture.detectChanges();
    const root = t.fixture.nativeElement as HTMLElement;
    expect(root.querySelector('tbody td.time')?.textContent?.trim()).toBe('07:00:00');
  });

  it('moves a row, re-times the reel, and removes a row closing the hole', () => {
    const t = loaded(setup());
    t.component.moveRow('c', 'up');
    expect(keys(t.component.top())).toEqual(['a', 'c', 'b']);
    expect(t.component.top().map(startMin)).toEqual([0, 30, 35]);
    t.component.removeRow('a');
    expect(keys(t.component.top())).toEqual(['c', 'b']);
    expect(t.component.top().map(startMin)).toEqual([30, 35]);
    expect(t.component.dirty()).toBe(true);
  });

  it('OVERLAPS BLOCK THE SAVE: fixing an item inside the previous one disables Save and says why', () => {
    const t = loaded(setup());
    // Make b an anchor, then lengthen a past it: a is 06:00–06:30, b fixed at 06:30 — no overlap
    // yet; lengthening a to 40 min puts b inside a.
    t.component.toggleFixed('b', true);
    expect(t.component.overlapCount()).toBe(0);
    t.component.setDuration('a', '40');
    t.fixture.detectChanges();
    expect(t.component.overlapCount()).toBe(1);
    const root = t.fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.message.error')?.textContent).toContain('overlapsBlockSave');
    expect((root.querySelector('.actions button') as HTMLButtonElement).disabled).toBe(true);
    t.component.save();
    expect(t.fake.saves).toHaveLength(0);
  });

  it('SAVE sends the whole reel as inputs — positions, ids kept, no client keys — and takes back the stored reel', () => {
    const t = loaded(setup());
    t.component.setForm('minutes', '5');
    t.component.setForm('mediaId', 'm-new');
    t.component.add(new Event('submit'));
    t.component.moveRow('c', 'down'); // c after the new row

    t.component.save();
    expect(t.fake.saves).toHaveLength(1);
    const sent = t.fake.saves[0]?.items as ScheduleItemInput[];
    expect(sent.map((i) => [i.id, i.seq, i.mediaId])).toEqual([
      ['a', 0, 'm-a'],
      ['b', 1, 'm-b'],
      [undefined, 2, 'm-new'],
      ['c', 3, 'm-c'],
    ]);
    expect(sent[2]).not.toHaveProperty('key');
    expect(sent[2]).not.toHaveProperty('end');

    const stored = [
      item('a', 0, 0, 30),
      item('b', 1, 30, 10),
      item('n', 2, 40, 5, { mediaId: 'm-new' }),
      item('c', 3, 45, 5),
    ];
    t.fake.saves[0]?.result.next(stored);
    expect(keys(t.component.top())).toEqual(['a', 'b', 'n', 'c']);
    expect(t.component.dirty()).toBe(false);
    expect(t.editors.activeTab()?.dirty).toBe(false);
    expect(t.component.saved()).toBe(true);
    // The header is refetched for the new version.
    expect(t.fake.gets).toHaveLength(2);
  });

  it('a failed save keeps the edits and the dirty marker', () => {
    const t = loaded(setup());
    t.component.removeRow('b');
    t.component.save();
    t.fake.saves[0]?.result.error(new Error('422'));
    expect(t.component.saveError()).toBe('scheduleEditor.saveError');
    expect(keys(t.component.top())).toEqual(['a', 'c']);
    expect(t.component.dirty()).toBe(true);
  });

  it('a reader sees the reel and no controls', () => {
    const t = loaded(setup(['schedule:read']));
    expect(t.component.mayEdit()).toBe(false);
    const root = t.fixture.nativeElement as HTMLElement;
    expect(root.querySelector('form.add')).toBeNull();
    expect(root.querySelectorAll('.row-actions button')).toHaveLength(0);
    expect(root.querySelectorAll('tbody tr:not(.gap)')).toHaveLength(3);
  });

  it('a live schedule.updated for THIS schedule reloads when clean and never while dirty', () => {
    const t = loaded(setup());
    const emit = (scheduleId: string) =>
      t.ws.events$.next({
        subject: 'atlas.ch12.schedule.updated',
        payload: { type: 'schedule.updated', channelId: 'ch12', payload: { scheduleId } },
      });
    emit('other');
    expect(t.fake.gets).toHaveLength(1);
    emit(SID);
    expect(t.fake.gets).toHaveLength(2);

    t.fake.gets[1]?.result.next({ ...header({ version: 2 }), items: [item('a', 0, 0, 30)] });
    t.component.removeRow('a');
    emit(SID);
    expect(t.fake.gets).toHaveLength(2);
  });

  it('VALIDATE: the stored reel only; the report names its rows, and the header takes the new state', () => {
    const t = loaded(setup());
    const root = t.fixture.nativeElement as HTMLElement;
    const button = () =>
      [...root.querySelectorAll<HTMLButtonElement>('.actions button')].find(
        (b) => b.textContent?.trim() === 'scheduleEditor.validate',
      )!;

    // Unsaved edits: validation checks what is stored, so it waits for the save.
    t.component.removeRow('c');
    t.fixture.detectChanges();
    expect(button().disabled).toBe(true);
    t.component.validate();
    expect(t.fake.validations).toHaveLength(0);
    t.component.save();
    t.fake.saves[0]?.result.next([item('a', 0, 0, 30), item('b', 1, 30, 10)]);
    t.fake.gets[1]?.result.next({ ...header({ version: 2 }), items: [] });
    t.fixture.detectChanges();
    expect(button().disabled).toBe(false);

    button().click();
    expect(t.fake.validations[0]?.id).toBe(SID);
    t.fake.validations[0]?.result.next({
      scheduleId: SID,
      version: 2,
      state: 'draft',
      valid: false,
      issues: [
        {
          kind: 'approval',
          itemId: 'b',
          severity: 'critical',
          message: 'media m-b has no approval',
        },
        { kind: 'gap', itemId: 'b', severity: 'warning', message: '60 s of dead air', seconds: 60 },
      ],
      unchecked: ['rights', 'availability'],
      validatedAt: T0,
    });
    t.fixture.detectChanges();
    const report = root.querySelector('section.report')!;
    expect(report.querySelector('.summary')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      '1 scheduleEditor.reportInvalid · scheduleEditor.unchecked scheduleEditor.issue.rights, scheduleEditor.issue.availability',
    );
    expect(report.querySelectorAll('li')).toHaveLength(2);
    const flagged = [...root.querySelectorAll('tbody tr.flagged td.title .flag')].map((f) =>
      f.textContent?.trim(),
    );
    expect(flagged).toEqual(['scheduleEditor.issue.approval', 'scheduleEditor.issue.gap']);

    // A clean run: validated, and the version the service moved it to.
    button().click();
    t.fake.validations[1]?.result.next({
      scheduleId: SID,
      version: 3,
      state: 'validated',
      valid: true,
      issues: [],
      unchecked: ['rights', 'availability'],
      validatedAt: T0,
    });
    t.fixture.detectChanges();
    expect(t.component.schedule()?.state).toBe('validated');
    expect(root.querySelector('.eyebrow')?.textContent).toContain('validated');
    expect(root.querySelector('section.report.valid')).not.toBeNull();

    // A newer version on screen (someone saved): the report is stale, and is not shown.
    t.ws.events$.next({
      subject: 'atlas.ch12.schedule.updated',
      payload: { type: 'schedule.updated', channelId: 'ch12', payload: { scheduleId: SID } },
    });
    t.fake.gets.at(-1)?.result.next({ ...header({ version: 4 }), items: [] });
    t.fixture.detectChanges();
    expect(t.component.report()).toBeNull();
    expect(root.querySelector('section.report')).toBeNull();
  });

  it('COPY: a range in the schedule’s zone onto the next day, found by date — a range past midnight runs into the next day', () => {
    const t = setup();
    t.fake.gets[0]?.result.next({ ...header({ timezone: 'Europe/London' }), items: [] });
    t.fixture.detectChanges();
    expect(t.component.copyForm().date).toBe('2026-09-13');
    t.component.setCopy('from', '18:00');
    t.component.setCopy('to', '01:00');
    t.component.setCopy('at', '06:00');
    t.component.setCopy('mode', 'overwrite');
    t.component.copy(new Event('submit'));

    expect(t.fake.lists[0]?.broadcastDate).toBe('2026-09-13');
    const target = header({
      id: '01K0000000000000000000TRGT',
      broadcastDate: '2026-09-13',
      version: 4,
    });
    t.fake.lists[0]?.result.next({ items: [target] });
    expect(t.fake.creates).toHaveLength(0);
    // London is UTC+1 in September: 18:00 → 17:00Z, and 01:00 is the NEXT morning.
    expect(t.fake.copies[0]).toMatchObject({
      id: SID,
      body: {
        from: '2026-09-12T17:00:00.000Z',
        to: '2026-09-13T00:00:00.000Z',
        targetScheduleId: target.id,
        targetVersion: 4,
        at: '2026-09-13T05:00:00.000Z',
        mode: 'overwrite',
      },
    });
    t.fake.copies[0]?.result.next({
      schedule: { ...target, version: 5 },
      items: [],
      copied: 3,
      removed: 1,
    });
    expect(t.component.copyDone()).toBe('scheduleEditor.copy.done');
    expect(t.fake.gets).toHaveLength(1); // another schedule: this one is not reloaded
  });

  it('COPY: no target day yet makes one in this zone; the whole reel when no range; refused while dirty', () => {
    const t = loaded(setup());
    t.component.copy(new Event('submit'));
    t.fake.lists[0]?.result.next({ items: [] });
    expect(t.fake.creates[0]?.body).toEqual({ broadcastDate: '2026-09-13', timezone: 'UTC' });
    t.fake.creates[0]?.result.next(header({ id: '01K0000000000000000000NEWD', version: 1 }));
    const body = t.fake.copies[0]?.body;
    expect(body?.from).toBeUndefined();
    expect(body?.to).toBeUndefined();
    expect(body).toMatchObject({ at: '2026-09-13T06:00:00.000Z', mode: 'merge', targetVersion: 1 });
    t.fake.copies[0]?.result.next({
      schedule: header({ id: '01K0000000000000000000NEWD', version: 2 }),
      items: [],
      copied: 3,
      removed: 0,
    });

    t.component.setCopy('from', '07:00');
    t.component.copy(new Event('submit'));
    expect(t.component.copyError()).toBe('scheduleEditor.copy.rangeBoth');

    t.component.setDuration('a', '45');
    t.component.setCopy('to', '08:00');
    t.component.copy(new Event('submit'));
    expect(t.fake.lists).toHaveLength(1); // dirty: nothing sent
  });

  it('COPY: a 409 says the target changed; a 422 shows the service’s words; onto itself reloads', () => {
    const t = loaded(setup());
    t.component.setCopy('date', '2026-09-12');
    t.component.copy(new Event('submit'));
    t.fake.lists[0]?.result.next({ items: [header()] });
    t.fake.copies[0]?.result.error(new HttpErrorResponse({ status: 409 }));
    expect(t.component.copyError()).toBe('scheduleEditor.copy.conflict');

    t.component.copy(new Event('submit'));
    t.fake.lists[1]?.result.next({ items: [header()] });
    t.fake.copies[1]?.result.error(
      new HttpErrorResponse({
        status: 422,
        error: { detail: 'nothing starts in that range: nothing to copy' },
      }),
    );
    expect(t.component.copyError()).toBe('nothing starts in that range: nothing to copy');

    t.component.copy(new Event('submit'));
    t.fake.lists[2]?.result.next({ items: [header()] });
    t.fake.copies[2]?.result.next({
      schedule: header({ version: 2 }),
      items: [],
      copied: 3,
      removed: 0,
    });
    expect(t.fake.gets).toHaveLength(2); // the reel on screen is the target: reloaded
  });

  it('VALIDATE: a 409 says the schedule changed, anything else that it could not validate', () => {
    const t = loaded(setup());
    t.component.validate();
    t.fake.validations[0]?.result.error(new HttpErrorResponse({ status: 409 }));
    expect(t.component.validateError()).toBe('scheduleEditor.validateConflict');
    t.component.validate();
    t.fake.validations[1]?.result.error(new HttpErrorResponse({ status: 500 }));
    expect(t.component.validateError()).toBe('scheduleEditor.validateError');
  });
});
