import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  Schedule,
  ScheduleItem,
  ScheduleItemInput,
  ScheduleWithItems,
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
});
