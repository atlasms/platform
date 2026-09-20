// The tray (EP-20.8; FR-UI-9): hidden when there is nothing, grouped when there is, minimizable,
// and each row's one action is the right one for its state — cancel, retry, dismiss.

import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { LocaleService } from '../core/locale.service.ts';
import { TransferStore } from '../core/transfer.store.ts';
import { UploadService } from '../core/upload.service.ts';
import { TransferTray } from './transfer-tray.ts';

class FakeUploads {
  cancelled: string[] = [];
  retried: string[] = [];
  cancel(id: string) {
    this.cancelled.push(id);
    return Promise.resolve();
  }
  retry(id: string) {
    this.retried.push(id);
    return Promise.resolve();
  }
}

function setup() {
  const uploads = new FakeUploads();
  TestBed.configureTestingModule({
    providers: [
      { provide: UploadService, useValue: uploads },
      { provide: LocaleService, useValue: { t: (k: string) => k } },
    ],
  });
  const store = TestBed.inject(TransferStore);
  const fixture = TestBed.createComponent(TransferTray);
  const el = fixture.nativeElement as HTMLElement;
  const text = (): string => el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  return { fixture, el, text, store, uploads };
}

describe('TransferTray', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders nothing without transfers, and the group summary with them', async () => {
    const { fixture, el, text, store } = setup();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('.tray')).toBeNull();

    const a = store.add({ name: 'a.mxf', sizeBytes: 1000 });
    store.update(a.id, { state: 'uploading', sentBytes: 250 });
    store.add({ name: 'b.mxf', sizeBytes: 1000 });
    fixture.detectChanges();
    expect(text()).toContain('2 transfers.active · 12%');
    expect(el.querySelectorAll('li')).toHaveLength(2);
    expect(el.querySelector('progress')?.getAttribute('value')).toBe('0'); // b, newest first
  });

  it('minimizes to the header, and comes back', () => {
    const { fixture, el, store } = setup();
    store.add({ name: 'a.mxf', sizeBytes: 1 });
    fixture.detectChanges();
    (el.querySelector('.toggle') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(el.querySelector('ul')).toBeNull();
    expect(el.querySelector('.toggle')?.getAttribute('aria-expanded')).toBe('false');
    (el.querySelector('.toggle') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(el.querySelector('ul')).not.toBeNull();
  });

  it('one action per row: cancel while active, retry when failed, dismiss when over — and the verdict as the state once done', () => {
    const { fixture, el, text, store, uploads } = setup();
    const active = store.add({ name: 'active.mxf', sizeBytes: 10 });
    store.update(active.id, { state: 'uploading' });
    const failed = store.add({ name: 'failed.mxf', sizeBytes: 10 });
    store.update(failed.id, { state: 'failed', error: '502 Bad Gateway' });
    const done = store.add({ name: 'done.mxf', sizeBytes: 10 });
    store.update(done.id, {
      state: 'done',
      sentBytes: 10,
      job: {
        id: '01J00000000000000000000000',
        channelId: 'ch12',
        state: 'quarantined',
        reason: 'under the minimum',
        version: 3,
        createdAt: '',
        updatedAt: '',
      },
    });
    fixture.detectChanges();

    const rows = Array.from(el.querySelectorAll('li'));
    expect(rows.map((r) => r.querySelector('.link')?.textContent?.trim())).toEqual([
      'transfers.dismiss', // done, newest first
      'common.retry',
      'common.cancel',
    ]);
    expect(rows[0]?.querySelector('.state')?.textContent?.trim()).toBe('ingest.state.quarantined');
    expect(text()).toContain('under the minimum');
    expect(text()).toContain('502 Bad Gateway');

    (rows[2]?.querySelector('.link') as HTMLButtonElement).click();
    (rows[1]?.querySelector('.link') as HTMLButtonElement).click();
    (rows[0]?.querySelector('.link') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(uploads.cancelled).toEqual([active.id]);
    expect(uploads.retried).toEqual([failed.id]);
    expect(store.transfers().map((t) => t.id)).toEqual([failed.id, active.id]);

    (el.querySelector('header .link') as HTMLButtonElement).click(); // clear finished
    fixture.detectChanges();
    expect(store.transfers().map((t) => t.id)).toEqual([active.id]);
  });
});
