// EP-20.1 — the Media panel against real MAM reads.
//
// The panel replaced a hard-coded stand-in list. What is worth testing is not that it renders, but
// the three things that fail QUIETLY: a stale search response overwriting a newer one, "Recent"
// silently becoming "oldest", and an empty channel being indistinguishable from a failed search.

import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { Subject } from 'rxjs';
import { AssetsService, type ListOptions, type Page } from '../core/assets.service.ts';
import type { Asset, Tag } from '../core/generated/mam.types.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import { MediaPanel } from './media-panel.ts';

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

/**
 * A stand-in AssetsService whose responses the test resolves by hand, in whatever order it likes.
 *
 * ONE SUBJECT PER CALL, which matters: a shared subject would deliver every response to every
 * subscriber, so the newest request would receive the older request's answer as well and the test
 * would "fail" against a perfectly correct implementation. Real HTTP hands each call its own
 * observable, and the fake has to do the same or it is testing itself.
 */
class FakeAssets {
  listCalls: ListOptions[] = [];
  searchCalls: string[] = [];
  lists: Subject<Page<Asset>>[] = [];
  searches: Subject<Page<Asset>>[] = [];
  tags$ = new Subject<Tag[]>();

  list(options: ListOptions = {}) {
    this.listCalls.push(options);
    const subject = new Subject<Page<Asset>>();
    this.lists.push(subject);
    return subject;
  }
  search(q: string) {
    this.searchCalls.push(q);
    const subject = new Subject<Page<Asset>>();
    this.searches.push(subject);
    return subject;
  }
  tags() {
    return this.tags$;
  }

  /** The most recent list response channel — what most tests want. */
  get list$() {
    return this.lists[this.lists.length - 1] as Subject<Page<Asset>>;
  }
}

function panel() {
  const fake = new FakeAssets();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      EditorStore,
      { provide: AssetsService, useValue: fake },
    ],
  });
  const fixture = TestBed.createComponent(MediaPanel);
  return { fixture, component: fixture.componentInstance as unknown as InternalPanel, fake };
}

/** The panel's protected surface, which the test drives directly rather than through the DOM. */
interface InternalPanel {
  assets: () => Asset[];
  tags: () => Tag[];
  query: () => string;
  error: () => string | null;
  cursor: () => string | undefined;
  heading: () => string;
  onQuery(value: string): void;
  toggleTag(tag: Tag): void;
  loadMore(): void;
  open(asset: Asset): void;
}

describe('MediaPanel', () => {
  let harness: ReturnType<typeof panel>;
  beforeEach(() => {
    harness = panel();
  });

  it('asks for RECENT — newest first — not whatever order the store defaults to', () => {
    // Page one of an ascending list is the OLDEST assets in the channel, so a client-side sort
    // cannot produce "Recent". MAM grew `order: desc` precisely for this.
    const { fake, component } = harness;
    expect(fake.listCalls[0]).toEqual({ order: 'desc' });
    expect(component.heading()).toBe('Recent');
  });

  it('renders the page it is given and keeps the cursor', () => {
    const { fake, component } = harness;
    fake.lists[0]?.next({ items: [asset('a1', 'Newest'), asset('a2')], nextCursor: 'a2' });

    expect(component.assets().map((a) => a.title)).toEqual(['Newest', 'a2']);
    expect(component.cursor()).toBe('a2');
  });

  it('DANGER: a stale search response cannot overwrite a newer one', () => {
    // Typing "foo" fires a request per keystroke and they can return in any order. Without the
    // guard, the results for "f" land after the results for "foo" and the list shows one thing
    // while the search box says another — a bug that only appears on a slow connection.
    const { fake, component } = harness;
    fake.lists[0]?.next({ items: [asset('recent')] });

    component.onQuery('f');
    component.onQuery('foo');
    expect(fake.searchCalls).toEqual(['f', 'foo']);

    // The NEWER request answers first, then the older one arrives late — which is exactly the
    // ordering a slow connection produces and the one the guard exists for.
    fake.searches[1]?.next({ items: [asset('foo-hit', 'Foo result')] });
    fake.searches[0]?.next({ items: [asset('f-hit', 'Stale result')] });

    expect(component.assets().map((a) => a.title)).toEqual(['Foo result']);
  });

  it('clearing the box goes back to recent rather than searching for nothing', () => {
    // An empty `q` is a 422 at MAM — a search box that submits empty must not become an
    // unpaginated dump of the channel — so the panel must not send one.
    const { fake, component } = harness;
    component.onQuery('clip');
    component.onQuery('   ');

    expect(fake.searchCalls).toEqual(['clip']);
    expect(fake.listCalls.length).toBe(2);
    expect(fake.listCalls[1]).toEqual({ order: 'desc' });
  });

  it('a tag chip filters, and clicking it again clears the filter', () => {
    const { fake, component } = harness;
    const tag: Tag = { id: 't1', label: 'Football', normalized: 'football' } as Tag;

    component.toggleTag(tag);
    expect(fake.searchCalls).toEqual(['Football']);
    expect(component.query()).toBe('Football');

    component.toggleTag(tag);
    expect(component.query()).toBe('');
    expect(fake.listCalls.length).toBe(2);
  });

  it('load more APPENDS rather than replacing, and passes the cursor', () => {
    const { fake, component } = harness;
    fake.lists[0]?.next({ items: [asset('a1')], nextCursor: 'a1' });

    component.loadMore();
    expect(fake.listCalls[1]).toEqual({ order: 'desc', cursor: 'a1' });

    fake.lists[1]?.next({ items: [asset('a2')] });
    expect(component.assets().map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(component.cursor()).toBeUndefined();
  });

  it('a failed read shows a message rather than an empty list pretending to be an empty channel', () => {
    const { fake, component } = harness;
    fake.lists[0]?.error(new Error('network'));

    expect(component.error()).toBe('Could not load media.');
  });

  it('a failing tag list does not break the panel', () => {
    // The filters simply do not appear. Losing the tag cloud is not worth an error banner over the
    // catalogue the user actually came for.
    const { fake, component } = harness;
    fake.tags$.error(new Error('nope'));
    fake.lists[0]?.next({ items: [asset('a1')] });

    expect(component.tags()).toEqual([]);
    expect(component.error()).toBeNull();
    expect(component.assets().length).toBe(1);
  });

  it('opening an asset adds a tab identified by the contract-required id', () => {
    const { component } = harness;
    const editors = TestBed.inject(EditorStore);
    const openTabs = () => editors.groups().flatMap((g) => g.tabs);
    const before = openTabs().length;

    component.open(asset('01ABC', 'Clip'));
    expect(editors.activeTab()?.resourceId).toBe('01ABC');
    expect(openTabs().length).toBe(before + 1);
  });
});
