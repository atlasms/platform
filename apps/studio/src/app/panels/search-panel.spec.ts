// EP-20.4 — the Search panel.
//
// The panel had no spec, and the thing it gets wrong fails QUIETLY: an out-of-order response
// overwriting a newer one. It carries the media panel's request-id guard, so the test is whether
// the guard is actually armed on every path into a search — including Enter, which used to re-run
// the search under the id already in flight and so raced against itself.

import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { AssetsService, type Page } from '../core/assets.service.ts';
import type { Asset } from '../core/generated/mam.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import { SearchPanel } from './search-panel.ts';

const asset = (id: string, title = id): Asset => ({
  id,
  channelId: 'ch12',
  title,
  mediaType: 'video',
  fileType: 'mxf',
  state: 'ready',
  version: 1,
  hasRenditions: true,
  createdBy: 'u1',
  createdAt: '2026-08-17T08:00:00.000Z',
  updatedAt: '2026-08-17T08:00:00.000Z',
});

/** One subject per call — a shared one would deliver every response to every subscriber. */
class FakeAssets {
  searchCalls: string[] = [];
  searches: Subject<Page<Asset>>[] = [];

  search(q: string) {
    this.searchCalls.push(q);
    const subject = new Subject<Page<Asset>>();
    this.searches.push(subject);
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

interface InternalSearchPanel {
  assets: () => Asset[];
  query: () => string;
  loading: () => boolean;
  error: () => string | null;
  onQuery(value: string): void;
  onEnter(): void;
  open(asset: Asset): void;
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
  const fixture = TestBed.createComponent(SearchPanel);
  return { fixture, component: fixture.componentInstance as unknown as InternalSearchPanel, fake };
}

describe('SearchPanel', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('a slower earlier search cannot overwrite a newer one', () => {
    const { component, fake } = setup();
    component.onQuery('f');
    component.onQuery('foo');

    // "foo" answers first, then the older "f" arrives late.
    fake.searches[1]?.next({ items: [asset('a2', 'Foo')] });
    fake.searches[0]?.next({ items: [asset('a1', 'F')] });

    expect(component.assets().map((a) => a.title)).toEqual(['Foo']);
  });

  it('Enter takes a NEW request id, so it cannot race the search already in flight', () => {
    // Enter used to re-run under the id already issued. Two in-flight requests then shared one id,
    // both passed the staleness check, and whichever answered LAST won — which is exactly the race
    // the id exists to lose. The old response must now be discarded on arrival.
    const { component, fake } = setup();
    component.onQuery('foo');
    component.onEnter();
    expect(fake.searchCalls).toEqual(['foo', 'foo']);

    fake.searches[1]?.next({ items: [asset('fresh', 'Fresh')] });
    fake.searches[0]?.next({ items: [asset('stale', 'Stale')] });

    expect(component.assets().map((a) => a.title)).toEqual(['Fresh']);
  });

  it('clearing the box clears the results instead of searching for nothing', () => {
    const { component, fake } = setup();
    component.onQuery('foo');
    fake.searches[0]?.next({ items: [asset('a1')] });
    expect(component.assets()).toHaveLength(1);

    component.onQuery('   ');
    expect(component.assets()).toEqual([]);
    expect(component.loading()).toBe(false);
    expect(fake.searchCalls).toEqual(['foo']); // whitespace is not a query
  });

  it('a result opens a real editor tab', () => {
    const { component } = setup();
    component.open(asset('01ABC', 'Clip'));
    expect(TestBed.inject(EditorStore).activeTab()?.resourceId).toBe('01ABC');
  });

  it('a failed search reports without echoing the server back at the user', () => {
    const { component, fake } = setup();
    component.onQuery('foo');
    fake.searches[0]?.error(new Error('ECONNREFUSED postgres://user:pw@host'));

    expect(component.error()).toBe('Could not search.');
    expect(component.loading()).toBe(false);
  });
});
