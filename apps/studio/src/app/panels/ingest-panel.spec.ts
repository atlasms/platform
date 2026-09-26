// EP-20.3 — the Ingest/Import panel.
//
// Written while the panel was `available: false` (RIM did not exist), which is precisely why it
// needed a spec: nothing else exercised it for months. What it got wrong was reading the contract
// — three fields the contract leaves OPTIONAL were typed required in a hand-written "generated"
// file, so the panel rendered "NaN GB" and a raw undefined against a perfectly valid response.
// Since EP-15.6 the queue is a PAGE (`{ items, nextCursor }`), like every list on the platform.

import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { IngestJob, IngestQueuePage, Watcher } from '../core/generated/rim.types.ts';
import { IngestService } from '../core/ingest.service.ts';
import { LocaleService } from '../core/locale.service.ts';
import { PermissionService } from '../core/permission.service.ts';
import type { Transfer } from '../core/transfer.store.ts';
import { UploadService } from '../core/upload.service.ts';
import { WatchersService } from '../core/watchers.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import { IngestPanel } from './ingest-panel.ts';

const job = (over: Partial<IngestJob> = {}): IngestJob => ({
  id: '01ABC',
  channelId: 'ch12',
  source: 'watch/news',
  state: 'quarantined',
  sizeBytes: 1024,
  createdAt: '2026-09-14T12:00:00.000Z',
  updatedAt: '2026-09-14T12:00:00.000Z',
  version: 1,
  ...over,
});

/**
 * A job the contract allows and the old types did not: detected, not yet sized or sourced.
 *
 * Written as a literal rather than `job({ sizeBytes: undefined })` because
 * `exactOptionalPropertyTypes` is on — an absent key and a key holding `undefined` are different
 * statements, and only the absent one is what RIM would actually send.
 */
const unsizedJob: IngestJob = {
  id: '01DEF',
  channelId: 'ch12',
  state: 'detected',
  createdAt: '2026-09-14T12:00:00.000Z',
  updatedAt: '2026-09-14T12:00:00.000Z',
  version: 1,
};

class FakeIngest {
  listCalls: { limit?: number; cursor?: string }[] = [];
  lists: Subject<IngestQueuePage>[] = [];
  accepts: Subject<IngestJob>[] = [];
  rejectCalls: { id: string; reason: string }[] = [];
  rejects: Subject<IngestJob>[] = [];

  list(options: { limit?: number; cursor?: string } = {}) {
    this.listCalls.push(options);
    const subject = new Subject<IngestQueuePage>();
    this.lists.push(subject);
    return subject;
  }
  accept(_id: string) {
    const subject = new Subject<IngestJob>();
    this.accepts.push(subject);
    return subject;
  }
  reject(id: string, reason: string) {
    this.rejectCalls.push({ id, reason });
    const subject = new Subject<IngestJob>();
    this.rejects.push(subject);
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

/** The uploader: records what it was handed, and settles each transfer when the test says. */
class FakeUploads {
  started: { file: File; settle: (t: Transfer) => void }[] = [];
  start(file: File): Promise<Transfer> {
    return new Promise((settle) => this.started.push({ file, settle }));
  }
}

/**
 * The panel's own template gates on `ingest:*`; most tests drive the class, not the gate, and
 * hold everything. `withoutAdmin` is the operator who may review but not administer sources.
 */
class FakePermissions {
  denied = new Set<string>();
  can(permission: string): boolean {
    return !this.denied.has(permission);
  }
}

/** Always faked: the panel lists watchers when it may, and a real client would really call. */
class FakeWatchers {
  lists: Subject<Watcher[]>[] = [];
  list() {
    const subject = new Subject<Watcher[]>();
    this.lists.push(subject);
    return subject;
  }
}

const watcher = (over: Partial<Watcher> = {}): Watcher => ({
  id: '01WATCHER0000000000000000A',
  channelId: 'ch12',
  name: 'Playout drops',
  path: 'playout',
  settleSeconds: 10,
  afterPickup: 'delete',
  enabled: true,
  createdBy: 'admin',
  createdAt: '2026-09-26T10:00:00.000Z',
  updatedAt: '2026-09-26T10:00:00.000Z',
  version: 1,
  ...over,
});

interface InternalIngestPanel {
  jobs: () => IngestJob[];
  onFilesPicked(event: Event): void;
  error: () => string | null;
  loading: () => boolean;
  formatSize(bytes: number | undefined): string;
  formatTech(tech: NonNullable<IngestJob['technicalMetadata']>): string;
  accept(job: IngestJob): void;
  reject(job: IngestJob, reason: string): void;
  sourceLabel(job: IngestJob): string;
}

function setup(options: { withoutAdmin?: boolean } = {}) {
  const fake = new FakeIngest();
  const uploads = new FakeUploads();
  const watchers = new FakeWatchers();
  const permissions = new FakePermissions();
  if (options.withoutAdmin) permissions.denied.add('ingest:admin');
  TestBed.configureTestingModule({
    providers: [
      EditorStore,
      { provide: IngestService, useValue: fake },
      { provide: UploadService, useValue: uploads },
      { provide: WatchersService, useValue: watchers },
      { provide: LocaleService, useClass: FakeLocale },
      { provide: PermissionService, useValue: permissions },
    ],
  });
  const fixture = TestBed.createComponent(IngestPanel);
  return {
    fixture,
    component: fixture.componentInstance as unknown as InternalIngestPanel,
    fake,
    uploads,
    watchers,
  };
}

/** A `change` on a file input whose files are these — jsdom lets the list be set this way. */
function picked(files: File[]): Event {
  const input = document.createElement('input');
  input.type = 'file';
  Object.defineProperty(input, 'files', { value: files });
  const event = new Event('change');
  Object.defineProperty(event, 'target', { value: input });
  return event;
}

describe('IngestPanel', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('a job with no size yet reads as unknown, not as NaN', () => {
    // rim.yaml requires only id, channelId and state: a `detected` job exists before the watcher
    // has finished sizing the file. `undefined / 1024**3` is NaN, and "NaN GB" is a bug report
    // from the operator, not a size.
    const { component } = setup();
    expect(component.formatSize(undefined)).toBe('—');
    expect(component.formatSize(0)).toBe('0 B');
    expect(component.formatSize(2048)).toBe('2.0 KB');
    expect(component.formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(component.formatSize(3 * 1024 ** 3)).toBe('3.0 GB');
  });

  it('what the probe read is one line, with only what is known', () => {
    const { component } = setup();
    expect(
      component.formatTech({
        container: 'mxf',
        videoCodec: 'mpeg2video',
        width: 1920,
        height: 1080,
        aspectRatio: '16:9',
        frameRate: 25,
        audioCodec: 'pcm_s24le',
        audioChannels: 2,
        durationSec: 12.5,
      }),
    ).toBe('mxf · mpeg2video 1920×1080 16:9 25 fps · pcm_s24le 2ch · 12.5 s');
    // Audio only: no picture segment at all, not a row of dashes.
    expect(
      component.formatTech({
        container: 'wav',
        audioCodec: 'pcm_s16le',
        audioChannels: 1,
        durationSec: 1,
      }),
    ).toBe('wav · pcm_s16le 1ch · 1 s');
    expect(component.formatTech({})).toBe('');
  });

  it('loads the queue on mount and renders what came back', () => {
    const { component, fake } = setup();
    expect(fake.listCalls).toEqual([{ limit: 100 }]);

    fake.lists[0]?.next({ items: [job(), unsizedJob] });
    expect(component.jobs()).toHaveLength(2);
    expect(component.loading()).toBe(false);
    expect(component.error()).toBeNull();
  });

  it('accepting splices the returned job in rather than refetching the whole queue', () => {
    const { component, fake } = setup();
    fake.lists[0]?.next({ items: [job(), job({ id: '01DEF' })] });

    component.accept(job());
    fake.accepts[0]?.next(job({ state: 'accepted' }));

    expect(component.jobs().map((j) => j.state)).toEqual(['accepted', 'quarantined']);
    expect(fake.listCalls).toHaveLength(1);
  });

  it('rejecting carries the operator reason through to the service', () => {
    const { component, fake } = setup();
    fake.lists[0]?.next({ items: [job()] });

    component.reject(job(), 'wrong aspect ratio');
    expect(fake.rejectCalls).toEqual([{ id: '01ABC', reason: 'wrong aspect ratio' }]);

    fake.rejects[0]?.next(job({ state: 'rejected', reason: 'wrong aspect ratio' }));
    expect(component.jobs()[0]?.state).toBe('rejected');
  });

  it('a failed load reports without leaving the panel stuck on "loading"', () => {
    const { component, fake } = setup();
    fake.lists[0]?.error(new Error('502 upstream "rim" unreachable'));

    expect(component.error()).toBe('ingest.loadError');
    expect(component.loading()).toBe(false);
  });

  it('picking files hands each to the uploader; a transfer that settles with a job leads the queue, once', async () => {
    const { component, fake, uploads } = setup();
    fake.lists[0]?.next({ items: [job()] });

    const a = new File([new Uint8Array(3)], 'a.mxf');
    const b = new File([new Uint8Array(3)], 'b.mxf');
    component.onFilesPicked(picked([a, b]));
    expect(uploads.started.map((s) => s.file.name)).toEqual(['a.mxf', 'b.mxf']);

    const settled = job({ id: '01NEW', state: 'accepted', filename: 'b.mxf' });
    uploads.started[1]?.settle({
      id: 't2',
      name: 'b.mxf',
      sizeBytes: 3,
      sentBytes: 3,
      state: 'done',
      job: settled,
      startedAt: 0,
    });
    await Promise.resolve();
    expect(component.jobs().map((j) => j.id)).toEqual(['01NEW', '01ABC']);

    // A cancelled or failed transfer has no job to add.
    uploads.started[0]?.settle({
      id: 't1',
      name: 'a.mxf',
      sizeBytes: 3,
      sentBytes: 0,
      state: 'cancelled',
      startedAt: 0,
    });
    await Promise.resolve();
    expect(component.jobs()).toHaveLength(2);
    expect(fake.listCalls).toHaveLength(1);
  });

  // EP-15.2: the Watchers view, and a watched job's source in words.
  it('an administrator gets Watchers and Rules tabs; an operator without ingest:admin gets the queue only', () => {
    const admin = setup();
    admin.fixture.detectChanges();
    const root = admin.fixture.nativeElement as HTMLElement;
    const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>('[role=tab]'));
    expect(tabs.map((t) => t.textContent?.trim())).toEqual([
      'ingest.view.queue',
      'ingest.view.watchers',
      'ingest.view.rules',
    ]);
    expect(admin.watchers.lists).toHaveLength(1);
    tabs[1]!.click();
    admin.fixture.detectChanges();
    expect(root.querySelector('atlas-watchers-view')).not.toBeNull();
    // The upload button belongs to the queue.
    expect(root.textContent).not.toContain('ingest.upload');

    TestBed.resetTestingModule();
    const operator = setup({ withoutAdmin: true });
    operator.fixture.detectChanges();
    const plain = operator.fixture.nativeElement as HTMLElement;
    expect(plain.querySelector('[role=tablist]')).toBeNull();
    expect(operator.watchers.lists).toHaveLength(0);
  });

  it("names a job's source: the web upload, a watcher by name — or by kind when it cannot be listed", () => {
    const { component, watchers } = setup();
    const w = watcher();
    watchers.lists[0]?.next([w]);
    expect(component.sourceLabel(job({ sourceKind: 'upload', source: 'upload' }))).toBe(
      'ingest.source.upload',
    );
    expect(component.sourceLabel(job({ sourceKind: 'watch', source: w.id }))).toBe('Playout drops');
    expect(component.sourceLabel(job({ sourceKind: 'watch', source: '01GONE' }))).toBe(
      'ingest.source.watch',
    );

    TestBed.resetTestingModule();
    const operator = setup({ withoutAdmin: true });
    expect(operator.component.sourceLabel(job({ sourceKind: 'watch', source: w.id }))).toBe(
      'ingest.source.watch',
    );
  });
});
