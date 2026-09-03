import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { AssetsService } from '../core/assets.service.ts';
import type { Asset, UpdateAssetInput } from '../core/generated/mam.types.ts';
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
  readonly gets: Array<{ id: string; result: Subject<Asset> }> = [];
  readonly updates: Array<{ id: string; patch: UpdateAssetInput; result: Subject<Asset> }> = [];

  get(id: string) {
    const result = new Subject<Asset>();
    this.gets.push({ id, result });
    return result;
  }

  update(id: string, patch: UpdateAssetInput) {
    const result = new Subject<Asset>();
    this.updates.push({ id, patch, result });
    return result;
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
        "Individual file rows, checksums, storage tier and technical metadata will appear here when MAM's FileRef projection is available. HSM remains the source of truth for files.",
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

function setup(fieldGroups: string[] = ['core', 'taxonomy', 'rights']) {
  localStorage.clear();
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
    editors,
  };
}

describe('AssetEditor', () => {
  beforeEach(() => TestBed.resetTestingModule());

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

  it('shows rendition readiness without inventing unavailable FileRef rows', () => {
    const { component, fake, fixture } = setup();
    fake.gets[0]?.result.next(record({ hasRenditions: true }));
    component.section.set('files');
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Renditions attached');
    expect(text).toContain('FileRef projection');
    expect(text).toContain('HSM remains the source of truth');
  });

  it('a live event for THIS asset refetches it — for another asset it does nothing', () => {
    const { component, fake } = setup();
    fake.gets[0]?.result.next(record());
    const ws = TestBed.inject(WebSocketService);

    emitAssetEvent(ws, '01K00000000000000000000000', 'updated');
    expect(fake.gets).toHaveLength(2); // the reload

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
});
