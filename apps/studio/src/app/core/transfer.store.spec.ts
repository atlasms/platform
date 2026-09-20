// The tray's numbers (EP-20.8): what counts as active, the one percentage across them, and
// what "clear finished" leaves behind.

import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { TransferStore } from './transfer.store.ts';

describe('TransferStore', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('the overall percentage is bytes over bytes across ACTIVE transfers only', () => {
    const store = TestBed.inject(TransferStore);
    expect(store.overallPercent()).toBe(100);
    const a = store.add({ name: 'a.mxf', sizeBytes: 1000 });
    const b = store.add({ name: 'b.mxf', sizeBytes: 3000 });
    expect(store.overallPercent()).toBe(0);
    store.update(a.id, { state: 'uploading', sentBytes: 1000 });
    store.update(b.id, { state: 'uploading', sentBytes: 1000 });
    expect(store.overallPercent()).toBe(50);
    // A finished transfer leaves the average: the bar is about what is still moving.
    store.update(a.id, { state: 'done' });
    expect(store.overallPercent()).toBe(33);
    expect(store.active().map((t) => t.id)).toEqual([b.id]);
    expect(store.finished().map((t) => t.id)).toEqual([a.id]);
  });

  it('newest first; a patch clears a field given as undefined; clearFinished keeps the active', () => {
    const store = TestBed.inject(TransferStore);
    const first = store.add({ name: 'first', sizeBytes: 1 });
    const second = store.add({ name: 'second', sizeBytes: 1 });
    expect(store.transfers().map((t) => t.name)).toEqual(['second', 'first']);

    store.update(first.id, { state: 'failed', error: 'boom', uploadId: 'u1' });
    expect(store.get(first.id)?.error).toBe('boom');
    store.update(first.id, { state: 'queued', error: undefined });
    expect('error' in store.get(first.id)!).toBe(false);
    expect(store.get(first.id)?.uploadId).toBe('u1');

    store.update(second.id, { state: 'cancelled' });
    store.clearFinished();
    expect(store.transfers().map((t) => t.id)).toEqual([first.id]);
    store.remove(first.id);
    expect(store.transfers()).toEqual([]);
  });
});
