import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CreateSchedule, Schedule, SchedulePage } from '../core/generated/scheduling.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { SchedulesService } from '../core/schedules.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import { SchedulePanel } from './schedule-panel.ts';

const schedule = (overrides: Partial<Schedule> = {}): Schedule => ({
  id: '01K0000000000000000000SCHD',
  channelId: 'ch12',
  broadcastDate: '2026-09-12',
  timezone: 'UTC',
  state: 'draft',
  version: 1,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...overrides,
});

class FakeSchedules {
  readonly lists: Array<{ options: Record<string, unknown>; result: Subject<SchedulePage> }> = [];
  readonly creates: Array<{ body: CreateSchedule; result: Subject<Schedule> }> = [];

  list(options: Record<string, unknown> = {}) {
    const result = new Subject<SchedulePage>();
    this.lists.push({ options, result });
    return result;
  }

  create(body: CreateSchedule) {
    const result = new Subject<Schedule>();
    this.creates.push({ body, result });
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
  day: { set(v: string): void };
  missing: () => string | null;
  error: () => string | null;
  recent: () => Schedule[];
  openDay(event: Event): void;
  create(day: string): void;
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
  const fixture = TestBed.createComponent(SchedulePanel);
  fixture.detectChanges();
  return {
    fixture,
    component: fixture.componentInstance as unknown as Internal,
    fake,
    editors: TestBed.inject(EditorStore),
  };
}

describe('SchedulePanel', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('lists the recent program tables, newest first as the service gives them, and opens one as a tab', () => {
    const t = setup();
    expect(t.fake.lists[0]?.options).toEqual({ limit: 30 });
    t.fake.lists[0]?.result.next({
      items: [schedule({ broadcastDate: '2026-09-13', id: 'b' }), schedule({ id: 'a' })],
    });
    t.fixture.detectChanges();
    const root = t.fixture.nativeElement as HTMLElement;
    const buttons = [...root.querySelectorAll('.items button')];
    expect(buttons.map((b) => b.querySelector('.title')?.textContent)).toEqual([
      '2026-09-13',
      '2026-09-12',
    ]);
    (buttons[1] as HTMLButtonElement).click();
    expect(t.editors.activeTab()?.type).toBe('schedule');
    expect(t.editors.activeTab()?.resourceId).toBe('a');
    expect(t.editors.activeTab()?.title).toBe('schedulePanel.tabPrefix 2026-09-12');
  });

  it('opening a day that has a table opens it; a day without one offers to create it', () => {
    const t = setup();
    t.component.day.set('2026-09-12');
    t.component.openDay(new Event('submit'));
    expect(t.fake.lists[1]?.options).toEqual({ broadcastDate: '2026-09-12', limit: 1 });
    t.fake.lists[1]?.result.next({ items: [schedule()] });
    expect(t.editors.activeTab()?.resourceId).toBe('01K0000000000000000000SCHD');

    t.component.day.set('2026-09-20');
    t.component.openDay(new Event('submit'));
    t.fake.lists[2]?.result.next({ items: [] });
    t.fixture.detectChanges();
    expect(t.component.missing()).toBe('2026-09-20');
    const root = t.fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.link')?.textContent).toContain('schedulePanel.createIt');
  });

  it('creating a day POSTs the date with the browser’s zone, then opens the new table', () => {
    const t = setup();
    t.component.create('2026-09-20');
    expect(t.fake.creates[0]?.body.broadcastDate).toBe('2026-09-20');
    expect(typeof t.fake.creates[0]?.body.timezone).toBe('string');
    t.fake.creates[0]?.result.next(schedule({ id: 'new', broadcastDate: '2026-09-20' }));
    expect(t.editors.activeTab()?.resourceId).toBe('new');
    expect(t.component.recent()[0]?.id).toBe('new');
  });

  it('a reader is not offered "create"', () => {
    const t = setup(['schedule:read']);
    t.component.day.set('2026-09-20');
    t.component.openDay(new Event('submit'));
    t.fake.lists[1]?.result.next({ items: [] });
    t.fixture.detectChanges();
    const root = t.fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.link')).toBeNull();
    expect(root.textContent).toContain('schedulePanel.noTableFor 2026-09-20');
  });
});
