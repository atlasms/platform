import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetsService } from '../core/assets.service.ts';
import type {
  Asset,
  AssetInheritance,
  FileRef,
  UpdateAssetInput,
  VocabularyName,
  VocabularyTerm,
} from '../core/generated/mam.types.ts';
import { VocabulariesService } from '../core/vocabularies.service.ts';
import type { Job } from '../core/generated/mts.types.ts';
import { TranscodeJobsService } from '../core/transcode-jobs.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import { LocaleService } from '../core/locale.service.ts';
import { WebSocketService } from '../core/websocket.service.ts';
import { AssetEditor } from './asset-editor.ts';

const record = (overrides: Partial<Asset> = {}): Asset => ({
  id: '01K00000000000000000000000',
  channelId: 'ch12',
  title: 'Morning bulletin',
  description: 'Top stories',
  mediaType: 'video',
  fileType: 'mxf',
  categoryId: 'news',
  state: 'ready',
  version: 3,
  hasRenditions: true,
  createdBy: 'u1',
  createdAt: '2026-08-17T08:00:00.000Z',
  updatedAt: '2026-08-17T08:10:00.000Z',
  ...overrides,
});

class FakeAssets {
  readonly gets: Array<{ id: string; fresh: boolean; result: Subject<Asset> }> = [];
  readonly updates: Array<{ id: string; patch: UpdateAssetInput; result: Subject<Asset> }> = [];
  readonly fileLists: Array<{ id: string; result: Subject<FileRef[]> }> = [];

  get(id: string, options: { fresh?: boolean } = {}) {
    const result = new Subject<Asset>();
    this.gets.push({ id, fresh: options.fresh ?? false, result });
    return result;
  }

  files(id: string) {
    const result = new Subject<FileRef[]>();
    this.fileLists.push({ id, result });
    return result;
  }

  update(id: string, patch: UpdateAssetInput) {
    const result = new Subject<Asset>();
    this.updates.push({ id, patch, result });
    return result;
  }

  readonly inheritances: Array<{ id: string; result: Subject<AssetInheritance> }> = [];
  inherited(id: string) {
    const result = new Subject<AssetInheritance>();
    this.inheritances.push({ id, result });
    return result;
  }
}

const term = (
  id: string,
  vocabulary: VocabularyName,
  en: string,
  over: Partial<VocabularyTerm> = {},
) =>
  ({
    id,
    vocabulary,
    channelId: 'ch12',
    key: en.toLowerCase(),
    labels: { en },
    sortOrder: 0,
    version: 1,
    createdBy: 'u1',
    createdAt: '2026-10-09T00:00:00.000Z',
    updatedAt: '2026-10-09T00:00:00.000Z',
    ...over,
  }) satisfies VocabularyTerm;

/** The vocabularies the editor's term pickers read (EP-28.3). */
class FakeVocabularies {
  readonly lists: Array<{ vocabulary: VocabularyName; includeDeprecated: boolean }> = [];
  readonly terms: Partial<Record<VocabularyName, VocabularyTerm[]>> = {
    genre: [
      term('G-DRAMA', 'genre', 'Drama'),
      term('G-COMEDY', 'genre', 'Comedy'),
      term('G-OLD', 'genre', 'Melodrama', { deprecatedAt: '2026-10-01T00:00:00.000Z' }),
    ],
  };
  list(vocabulary: VocabularyName, includeDeprecated = false) {
    this.lists.push({ vocabulary, includeDeprecated });
    return of(this.terms[vocabulary] ?? []);
  }
}

class FakeLocale {
  locale = () => 'en';
  loading = () => false;
  t(key: string): string {
    const translations: Record<string, string> = {
      'assetEditor.basicInfo': 'Basic info',
      'assetEditor.files': 'Files',
      'assetEditor.identity': 'Identity',
      'assetEditor.classification': 'Classification',
      'assetEditor.rights': 'Rights',
      'assetEditor.title': 'Title',
      'assetEditor.description': 'Description',
      'assetEditor.mediaType': 'Media type',
      'assetEditor.state': 'State',
      'assetEditor.episodeNumber': 'Episode number',
      'assetEditor.duration': 'Duration (seconds)',
      'assetEditor.categoryId': 'Category ID',
      'assetEditor.structureId': 'Structure ID',
      'assetEditor.allowedBroadcasts': 'Allowed broadcasts',
      'assetEditor.expiresAt': 'Expires at (ISO-8601)',
      'assetEditor.recommendedWindow': 'Recommended window',
      'assetEditor.notSet': 'Not set',
      'assetEditor.editable': 'Editable',
      'assetEditor.readOnly': 'Read only',
      'assetEditor.saveChanges': 'Save changes',
      'assetEditor.saving': 'Saving…',
      'assetEditor.saveError': 'Could not save these changes. Your edits are still here.',
      'assetEditor.saved': 'Changes saved.',
      'assetEditor.changedFields': 'changed field(s)',
      'assetEditor.createdBy': 'Created by',
      'assetEditor.createdAt': 'Created',
      'assetEditor.updatedAt': 'Updated',
      'assetEditor.sourceContainer': 'Source container',
      'assetEditor.renditionSet': 'Rendition set',
      'assetEditor.renditionsAttached': 'Renditions attached',
      'assetEditor.awaitingRenditions': 'Awaiting renditions',
      'assetEditor.filesNote':
        "Rows are MAM's mirror of the HSM ledger (FileRef); HSM remains the source of truth for files.",
      'assetEditor.loading': 'Loading asset…',
      'common.retry': 'Retry',
    };
    return translations[key] ?? key;
  }
  setLocale(_locale: 'en' | 'ar'): Promise<void> {
    return Promise.resolve();
  }
}

interface InternalEditor {
  asset: () => Asset | null;
  section: { set(value: 'basic' | 'files'): void };
  dirtyCount: () => number;
  loadError: () => string | null;
  saveError: () => string | null;
  saved: () => boolean;
  canEdit(group: 'core' | 'taxonomy' | 'rights'): boolean;
  change(field: keyof UpdateAssetInput, value: string): void;
  save(event: Event): void;
  resetToInherited(field: string): void;
}

/** The live-update surface, driven through the shared WebSocketService's event stream. */
function emitAssetEvent(
  ws: WebSocketService,
  assetId: string,
  action: string,
  channelId = 'ch12',
): void {
  ws.events$.next({
    subject: `atlas.${channelId}.asset.${action}`,
    payload: { type: `asset.${action}`, channelId, payload: { assetId } },
  });
}

/**
 * The Files tab now renders the transcode jobs (EP-16). Without this double the child reaches the
 * real HttpClient — resolvable at the root in this Angular — and fires a request from jsdom that
 * fails quietly, which is how this spec ran for its first cut.
 */
class FakeTranscodeJobs {
  readonly reads: Array<{ assetId: string; result: Subject<Job[]> }> = [];
  forAsset(assetId: string) {
    const result = new Subject<Job[]>();
    this.reads.push({ assetId, result });
    return result;
  }
}

function setup(fieldGroups: string[] = ['core', 'taxonomy', 'rights']) {
  localStorage.clear();
  const fake = new FakeAssets();
  const jobs = new FakeTranscodeJobs();
  TestBed.configureTestingModule({
    providers: [
      EditorStore,
      { provide: AssetsService, useValue: fake },
      { provide: TranscodeJobsService, useValue: jobs },
      { provide: VocabulariesService, useValue: new FakeVocabularies() },
      { provide: LocaleService, useClass: FakeLocale },
    ],
  });
  TestBed.inject(SessionStore).signIn({
    userId: 'u1',
    channelId: 'ch12',
    policy: {
      subjectId: 'u1',
      permVersion: 1,
      rules: [{ id: 'write', permissions: ['asset:write'], fieldGroups }],
    },
  });
  const editors = TestBed.inject(EditorStore);
  editors.open({ type: 'asset', resourceId: '01K00000000000000000000000', title: 'Bulletin' });

  const fixture = TestBed.createComponent(AssetEditor);
  fixture.componentRef.setInput('assetId', '01K00000000000000000000000');
  fixture.componentRef.setInput('tabId', 'asset:01K00000000000000000000000');
  fixture.detectChanges();
  return {
    fixture,
    component: fixture.componentInstance as unknown as InternalEditor,
    fake,
    jobs,
    editors,
  };
}

describe('AssetEditor', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('a term field is a picker of LIVE terms by label; an old value stays visible, marked; empty names what it inherits (EP-28.3)', () => {
    const { fixture, fake } = setup();
    fake.gets[0]?.result.next(record({ genre: 'G-OLD' }));
    fake.inheritances[0]?.result.next({
      assetId: record().id,
      defaults: { supplyType: { value: 'S-X', from: { categoryId: 'drama', path: '/drama/' } } },
      policies: {},
    });
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const genre = root.querySelector<HTMLSelectElement>('select[name="genre"]')!;
    const options = [...genre.options].map((o) => [o.value, o.textContent?.trim()]);
    expect(options).toEqual([
      ['', '— Not set'],
      ['G-OLD', 'Melodrama (categories.deprecated)'],
      ['G-DRAMA', 'Drama'],
      ['G-COMEDY', 'Comedy'],
    ]);
    expect(genre.value).toBe('G-OLD');
    // A term the editor cannot name is shown by its id rather than hidden.
    const supply = root.querySelector<HTMLSelectElement>('select[name="supplyType"]')!;
    expect(supply.options[0]?.textContent?.trim()).toBe('— assetEditor.inherits S-X');
  });

  describe('inheritance (EP-28.2)', () => {
    const DRAMA = { categoryId: 'drama', path: '/drama/' };
    const inherits = (defaults: AssetInheritance['defaults']): AssetInheritance => ({
      assetId: record().id,
      defaults,
      policies: { reviewNeeded: { value: true, from: DRAMA } },
    });

    it('a field the asset does not set shows the category’s value and where it comes from', () => {
      const { fixture, fake } = setup();
      fake.gets[0]?.result.next(record());
      fixture.detectChanges();
      expect(fake.inheritances[0]?.id).toBe(record().id);
      fake.inheritances[0]?.result.next(inherits({ genre: { value: 'drama', from: DRAMA } }));
      fixture.detectChanges();
      const root = fixture.nativeElement as HTMLElement;
      const genre = root.querySelector<HTMLSelectElement>('select[name="genre"]');
      expect(genre?.value).toBe('');
      expect(genre?.options[0]?.textContent?.trim()).toBe('— assetEditor.inherits drama');
      expect(genre?.closest('label')?.textContent).toContain('/drama/');
      expect(root.textContent).toContain('assetEditor.reviewNeeded');
    });

    it('clearing a value the asset set asks to INHERIT it; the reset button does it on its own', () => {
      const { fixture, fake, component } = setup();
      fake.gets[0]?.result.next(record({ genre: 'comedy' }));
      fake.inheritances[0]?.result.next(inherits({}));
      fixture.detectChanges();

      component.change('genre', '');
      component.save(new Event('submit'));
      expect(fake.updates[0]?.patch).toEqual({ inherit: ['genre'] });
      fake.updates[0]?.result.next(record({ version: 4 }));
      expect(fake.inheritances).toHaveLength(2); // re-read after the save

      TestBed.resetTestingModule();
      const t = setup();
      t.fake.gets[0]?.result.next(record({ supplyType: 'acquired' }));
      t.fake.inheritances[0]?.result.next(inherits({}));
      t.fixture.detectChanges();
      const reset = [
        ...(t.fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
          'button.inherit',
        ),
      ];
      expect(reset).toHaveLength(1);
      reset[0]?.click();
      expect(t.fake.updates[0]?.patch).toEqual({ inherit: ['supplyType'] });
    });

    it('a taxonomy change re-reads what the asset inherits — the asset itself is not refetched', () => {
      const { fixture, fake } = setup();
      fake.gets[0]?.result.next(record());
      fake.inheritances[0]?.result.next(inherits({}));
      fixture.detectChanges();
      const ws = TestBed.inject(WebSocketService);
      ws.events$.next({
        subject: 'atlas.ch12.taxonomy.updated',
        payload: { type: 'taxonomy.updated', channelId: 'ch12', payload: { kind: 'category' } },
      });
      expect(fake.inheritances).toHaveLength(2);
      expect(fake.gets).toHaveLength(1);
    });
  });

  it('loads the complete core record for its tab', () => {
    const { component, fake } = setup();
    expect(fake.gets[0]?.id).toBe('01K00000000000000000000000');

    fake.gets[0]?.result.next(record());
    expect(component.asset()?.title).toBe('Morning bulletin');
    expect(component.loadError()).toBeNull();
  });

  it('gates each field group independently using the shared policy', () => {
    const { component, fake, fixture } = setup(['core']);
    fake.gets[0]?.result.next(record());
    fixture.detectChanges();

    expect(component.canEdit('core')).toBe(true);
    expect(component.canEdit('taxonomy')).toBe(false);
    expect(component.canEdit('rights')).toBe(false);

    const root = fixture.nativeElement as HTMLElement;
    expect((root.querySelector('[name="title"]') as HTMLInputElement).disabled).toBe(false);
    expect((root.querySelector('[name="categoryId"]') as HTMLInputElement).disabled).toBe(true);
    expect((root.querySelector('[name="expiresAt"]') as HTMLInputElement).disabled).toBe(true);
  });

  it('sends only changed fields and clears the workbench dirty marker after success', () => {
    const { component, fake, editors } = setup();
    fake.gets[0]?.result.next(record());

    component.change('title', 'Evening bulletin');
    expect(component.dirtyCount()).toBe(1);
    expect(editors.activeTab()?.dirty).toBe(true);

    component.save(new Event('submit'));
    expect(fake.updates).toHaveLength(1);
    expect(fake.updates[0]?.patch).toEqual({ title: 'Evening bulletin' });

    fake.updates[0]?.result.next(record({ title: 'Evening bulletin', version: 4 }));
    expect(component.dirtyCount()).toBe(0);
    expect(editors.activeTab()?.dirty).toBe(false);
    expect(component.saved()).toBe(true);
  });

  it('keeps edits dirty when MAM refuses or cannot save them', () => {
    const { component, fake, editors } = setup();
    fake.gets[0]?.result.next(record());
    component.change('description', 'Rewritten');
    component.save(new Event('submit'));

    fake.updates[0]?.result.error(new Error('network'));
    expect(component.dirtyCount()).toBe(1);
    expect(editors.activeTab()?.dirty).toBe(true);
    expect(component.saveError()).toContain('edits are still here');
  });

  it('refuses invalid numeric and expiry values before making a request', () => {
    const { component, fake } = setup();
    fake.gets[0]?.result.next(record());

    component.change('allowedBroadcastCount', '-1');
    component.save(new Event('submit'));
    expect(fake.updates).toHaveLength(0);
    expect(component.saveError()).toContain('non-negative integer');

    component.change('allowedBroadcastCount', '2');
    component.change('expiresAt', 'not a date');
    component.save(new Event('submit'));
    expect(fake.updates).toHaveLength(0);
    expect(component.saveError()).toContain('ISO-8601');
  });

  it('the Files tab reads the FileRef mirror on entry — one row per file, a reload refreshes them', () => {
    const { component, fake, fixture } = setup();
    fake.gets[0]?.result.next(record({ hasRenditions: true }));
    fixture.detectChanges();
    expect(fake.fileLists).toHaveLength(0);

    component.section.set('files');
    fixture.detectChanges();
    expect(fake.fileLists).toHaveLength(1);
    expect(fake.fileLists[0]?.id).toBe('01K00000000000000000000000');
    fake.fileLists[0]?.result.next([
      {
        id: '01F00000000000000000000001',
        channelId: 'ch12',
        assetId: '01K00000000000000000000000',
        kind: 'proxy',
        storage: { path: '/online/proxy.mp4', tier: 'online', status: 'available' },
        checksum: { algorithm: 'sha256', value: 'abcdef0123456789' },
        sizeBytes: 5 * 1024 * 1024,
        sourceMessageId: '01M00000000000000000000001',
        version: 1,
        updatedAt: '2026-09-21T00:00:00.000Z',
      },
      {
        id: '01F00000000000000000000002',
        channelId: 'ch12',
        assetId: '01K00000000000000000000000',
        kind: 'original',
        storage: { path: '/nearline/bulletin.mxf', tier: 'near-line', status: 'quarantined' },
        checksum: { algorithm: 'sha256', value: 'ffff' },
        sourceMessageId: '01M00000000000000000000002',
        version: 3,
        updatedAt: '2026-09-21T00:00:00.000Z',
      },
    ]);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const rows = Array.from(root.querySelectorAll('.file-rows tbody tr'));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('proxy');
    expect(rows[0]?.textContent).toContain('5.0 MB');
    expect(rows[0]?.textContent).toContain('sha256 abcdef012345');
    expect(rows[1]?.getAttribute('data-status')).toBe('quarantined');
    expect(root.textContent).toContain('HSM remains the source of truth');

    // A live event refetches the asset; the rows follow, because a placement changes rows.
    fake.gets[0]?.result.next(record({ hasRenditions: true, version: 2 }));
    fixture.detectChanges();
    expect(fake.fileLists).toHaveLength(2);
  });

  describe('a transcode that completes while the Files tab is open', () => {
    afterEach(() => vi.useRealTimers());

    const job = (state: Job['state'], checksums: string[] = []): Job => ({
      id: '01J00000000000000000000001',
      channelId: 'ch12',
      assetId: '01K00000000000000000000000',
      presetIds: ['proxy'],
      inputPath: '/work/in.mp4',
      state,
      attempts: 1,
      priority: 0,
      createdBy: 'u1',
      createdAt: '2026-09-24T10:00:00.000Z',
      updatedAt: '2026-09-24T10:00:00.000Z',
      version: 1,
      ...(checksums.length > 0
        ? {
            renditions: checksums.map((value) => ({
              presetId: 'proxy',
              kind: 'proxy',
              path: '/work/renditions/proxy.mp4',
              checksum: { algorithm: 'sha256', value },
              sizeBytes: 10,
            })),
          }
        : {}),
    });
    const row = (checksum: string): FileRef => ({
      id: `01F0000000000000000000000${checksum.length}`,
      channelId: 'ch12',
      assetId: '01K00000000000000000000000',
      kind: 'proxy',
      storage: { path: '/work/renditions/proxy.mp4', tier: 'online', status: 'available' },
      checksum: { algorithm: 'sha256', value: checksum },
      sourceMessageId: '01M00000000000000000000001',
      version: 1,
      updatedAt: '2026-09-24T10:00:00.000Z',
    });

    it('re-reads the rows until they carry what it produced — by checksum, not by kind', () => {
      vi.useFakeTimers();
      const { component, fake, jobs, fixture } = setup();
      fake.gets[0]?.result.next(record());
      component.section.set('files');
      fixture.detectChanges();
      // An OLD proxy row is already there: same kind, a previous transcode's bytes.
      fake.fileLists[0]?.result.next([row('old')]);
      jobs.reads[0]?.result.next([job('running')]);
      fixture.detectChanges();

      // The child polls; the job completes; the editor re-reads the rows.
      vi.advanceTimersByTime(2_000);
      jobs.reads[1]?.result.next([job('completed', ['fresh'])]);
      expect(fake.fileLists).toHaveLength(2);
      // MAM has not caught up: the old row alone, so it looks again a second later…
      fake.fileLists[1]?.result.next([row('old')]);
      vi.advanceTimersByTime(1_000);
      expect(fake.fileLists).toHaveLength(3);
      // …and stops once the fresh checksum is there.
      fake.fileLists[2]?.result.next([row('old'), row('fresh')]);
      vi.advanceTimersByTime(5_000);
      expect(fake.fileLists).toHaveLength(3);
      fixture.detectChanges();
      expect(
        (fixture.nativeElement as HTMLElement).querySelectorAll('.file-rows tbody tr'),
      ).toHaveLength(2);
    });

    it('gives up after a bounded wait when the mirror never catches up', () => {
      vi.useFakeTimers();
      const { component, fake, jobs, fixture } = setup();
      fake.gets[0]?.result.next(record());
      component.section.set('files');
      fixture.detectChanges();
      fake.fileLists[0]?.result.next([]);
      jobs.reads[0]?.result.next([job('running')]);
      vi.advanceTimersByTime(2_000);
      jobs.reads[1]?.result.next([job('completed', ['never'])]);
      for (let i = 0; i < 40; i++) {
        fake.fileLists.at(-1)?.result.next([]);
        vi.advanceTimersByTime(1_000);
      }
      // One read on entering, one on completion, then fifteen more — and no sixteenth.
      expect(fake.fileLists).toHaveLength(17);
    });
  });

  it('a live event for THIS asset refetches it — for another asset it does nothing', () => {
    const { component, fake } = setup();
    fake.gets[0]?.result.next(record());
    const ws = TestBed.inject(WebSocketService);

    emitAssetEvent(ws, '01K00000000000000000000000', 'updated');
    expect(fake.gets).toHaveLength(2); // the reload
    expect(fake.gets[0]?.fresh).toBe(false); // the first read may be served from MAM's cache
    expect(fake.gets[1]?.fresh).toBe(true); // the one answering an event must not be

    fake.gets[1]?.result.next(record({ title: 'Renamed elsewhere', version: 4 }));
    expect(component.asset()?.title).toBe('Renamed elsewhere');

    emitAssetEvent(ws, '01SOMEONEELSE0000000000000', 'updated');
    expect(fake.gets).toHaveLength(2); // untouched
  });

  it('a live event while DIRTY does not discard the unsaved form', () => {
    // Regression: the first live-update version reloaded on every event, and a reload replaces
    // the draft — another user saving the same asset would silently erase this user's edits.
    const { component, fake } = setup();
    fake.gets[0]?.result.next(record());
    component.change('title', 'My unsaved edit');
    expect(component.dirtyCount()).toBe(1);

    emitAssetEvent(TestBed.inject(WebSocketService), '01K00000000000000000000000', 'updated');
    expect(fake.gets).toHaveLength(1); // no reload
    expect(component.dirtyCount()).toBe(1); // the edit survives
  });

  it('a re-sync reloads the record when clean, and never over unsaved edits (EP-09.4)', () => {
    const { component, fake } = setup();
    fake.gets[0]?.result.next(record());
    const ws = TestBed.inject(WebSocketService);

    ws.resync$.next('reconnected');
    expect(fake.gets).toHaveLength(2); // a gap may have hidden a change: reload
    expect(fake.gets[1]?.fresh).toBe(true);
    fake.gets[1]?.result.next(record({ title: 'Changed during the gap', version: 5 }));
    expect(component.asset()?.title).toBe('Changed during the gap');

    component.change('title', 'My unsaved edit');
    ws.resync$.next('poll');
    expect(fake.gets).toHaveLength(2); // the polling cadence does not clobber the draft either
    expect(component.dirtyCount()).toBe(1);
  });
});
