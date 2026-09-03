// EP-20.6 — the basic dashboard: system-state counts, what's-new, wired to open real editors.
//
// What is worth testing is what fails QUIETLY: counts computed from page one only (the original
// version labelled the newest 50 assets "System State"), an open button that logs instead of
// opening, and a live event that never refreshes the numbers.

import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { AssetsService, type ListOptions, type Page } from '../core/assets.service.ts';
import type { Asset } from '../core/generated/mam.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { WebSocketService } from '../core/websocket.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import { Dashboard } from './dashboard.ts';

const asset = (id: string, state: Asset['state'], title = id): Asset => ({
  id,
  channelId: 'ch12',
  title,
  mediaType: 'video',
  fileType: 'mxf',
  state,
  version: 1,
  hasRenditions: false,
  createdBy: 'u1',
  createdAt: '2026-08-17T08:00:00.000Z',
  updatedAt: '2026-08-17T08:00:00.000Z',
});

/** One subject per call — see the media-panel spec for why a shared one would test itself. */
class FakeAssets {
  listCalls: ListOptions[] = [];
  lists: Subject<Page<Asset>>[] = [];

  list(options: ListOptions = {}) {
    this.listCalls.push(options);
    const subject = new Subject<Page<Asset>>();
    this.lists.push(subject);
    return subject;
  }
}

class FakeLocale {
  locale = () => 'en';
  loading = () => false;
  t(key: string): string {
    return key;
  }
}

interface InternalDashboard {
  loading: () => boolean;
  assets: () => Asset[];
  stateCounts: () => { state: Asset['state']; count: number; label: string }[];
  recentAssets: () => Asset[];
  openAsset(asset: Asset): void;
}

function setup() {
  const fake = new FakeAssets();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      EditorStore,
      { provide: AssetsService, useValue: fake },
      { provide: LocaleService, useClass: FakeLocale },
    ],
  });
  TestBed.inject(SessionStore).signIn({
    userId: 'u1',
    channelId: 'ch12',
    policy: { subjectId: 'u1', permVersion: 1, rules: [] },
  });
  const fixture = TestBed.createComponent(Dashboard);
  return { fixture, component: fixture.componentInstance as unknown as InternalDashboard, fake };
}

describe('Dashboard', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('counts states across PAGES, not just the first screen of results', () => {
    const { component, fake } = setup();
    expect(fake.listCalls[0]).toEqual({ limit: 200, order: 'desc' });

    fake.lists[0]?.next({ items: [asset('a1', 'ready'), asset('a2', 'ready')], nextCursor: 'a2' });
    // The next page is a follow-up request through the cursor, not a silent stop at 200.
    expect(fake.listCalls[1]).toEqual({ limit: 200, order: 'desc', cursor: 'a2' });

    fake.lists[1]?.next({ items: [asset('a3', 'approved')] });
    const count = (s: Asset['state']) =>
      component.stateCounts().find((sc) => sc.state === s)?.count;
    expect(count('ready')).toBe(2);
    expect(count('approved')).toBe(1);
    expect(count('created')).toBe(0);
    expect(component.loading()).toBe(false);
  });

  it('stops paging at the cap rather than streaming a whole archive into a glance widget', () => {
    const { fake } = setup();
    for (let i = 0; i < 10; i++) {
      fake.lists[i]?.next({ items: [asset(`a${i}`, 'ready')], nextCursor: `a${i}` });
    }
    // Five pages of 200 = the 1000-asset cap; the eleventh request must never exist.
    expect(fake.listCalls).toHaveLength(5);
  });

  it('the newest-first page doubles as the what-is-new list', () => {
    const { component, fake } = setup();
    fake.lists[0]?.next({ items: [asset('a1', 'ready', 'Newest'), asset('a2', 'ready')] });
    expect(component.recentAssets().map((a) => a.title)).toEqual(['Newest', 'a2']);
  });

  it('opening an asset opens a real editor tab, not a console.log', () => {
    const { component, fake } = setup();
    fake.lists[0]?.next({ items: [asset('01ABC', 'ready', 'Clip')] });
    const editors = TestBed.inject(EditorStore);

    component.openAsset(asset('01ABC', 'ready', 'Clip'));
    expect(editors.activeTab()?.resourceId).toBe('01ABC');
  });

  it('an asset event on this channel refetches the numbers', () => {
    const { fake } = setup();
    fake.lists[0]?.next({ items: [asset('a1', 'ready')] });
    expect(fake.listCalls).toHaveLength(1);

    TestBed.inject(WebSocketService).events$.next({
      subject: 'atlas.ch12.asset.created',
      payload: { type: 'asset.created', channelId: 'ch12', payload: { assetId: 'a9' } },
    });
    expect(fake.listCalls).toHaveLength(2);
  });

  it('an asset event on ANOTHER channel is tenant noise, not a refresh trigger', () => {
    const { fake } = setup();
    fake.lists[0]?.next({ items: [asset('a1', 'ready')] });

    TestBed.inject(WebSocketService).events$.next({
      subject: 'atlas.ch99.asset.created',
      payload: { type: 'asset.created', channelId: 'ch99', payload: { assetId: 'a9' } },
    });
    expect(fake.listCalls).toHaveLength(1);
  });
});
