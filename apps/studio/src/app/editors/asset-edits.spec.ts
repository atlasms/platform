import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { EditProjectsService } from '../core/edit-projects.service.ts';
import type { Asset, EditProject } from '../core/generated/mam.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import { AssetEdits } from './asset-edits.ts';

const asset = (mediaType = 'video'): Asset =>
  ({ id: 'A1', title: 'Bulletin', mediaType, channelId: 'ch12' }) as Asset;
const project = (id: string, state: EditProject['state'] = 'draft'): EditProject =>
  ({
    id,
    sourceAssetId: 'A1',
    mediaKind: 'video',
    state,
    timeline: { clips: [] },
    version: 1,
    createdBy: 'u1',
    createdAt: '2026-11-23T09:15:00.000Z',
    updatedAt: '2026-11-23T09:15:00.000Z',
  }) as EditProject;

@Component({
  imports: [AssetEdits],
  template: `<atlas-asset-edits [asset]="asset()" [canEdit]="canEdit()" />`,
})
class Host {
  readonly asset = signal(asset());
  readonly canEdit = signal(true);
}

describe('AssetEdits', () => {
  let lists: Subject<EditProject[]>[];
  let creates: Subject<EditProject>[];
  let opened: Array<{ type: string; resourceId: string }>;

  beforeEach(() => {
    TestBed.resetTestingModule();
    lists = [];
    creates = [];
    opened = [];
    TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        {
          provide: EditProjectsService,
          useValue: {
            forAsset: () => {
              const s = new Subject<EditProject[]>();
              lists.push(s);
              return s;
            },
            create: () => {
              const s = new Subject<EditProject>();
              creates.push(s);
              return s;
            },
          },
        },
        {
          provide: EditorStore,
          useValue: { open: (d: { type: string; resourceId: string }) => opened.push(d) },
        },
        { provide: LocaleService, useValue: { t: (k: string) => k, locale: () => 'en' } },
      ],
    });
  });

  const render = (a = asset(), canEdit = true) => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.asset.set(a);
    fixture.componentInstance.canEdit.set(canEdit);
    fixture.detectChanges();
    return { fixture, root: fixture.nativeElement as HTMLElement };
  };

  it('lists the asset’s edits and opens one in its own tab', () => {
    const { fixture, root } = render();
    lists[0]!.next([project('P2', 'rendered'), project('P1')]);
    fixture.detectChanges();
    const items = [...root.querySelectorAll('li')].map((li) => li.textContent ?? '');
    expect(items).toHaveLength(2);
    expect(items[0]).toContain('editProject.state.rendered');
    (root.querySelector('li button') as HTMLButtonElement).click();
    expect(opened).toEqual([expect.objectContaining({ type: 'edit-project', resourceId: 'P2' })]);
  });

  it('starts a new edit and opens it', () => {
    const { fixture, root } = render();
    lists[0]!.next([]);
    fixture.detectChanges();
    (root.querySelector('button.new') as HTMLButtonElement).click();
    creates[0]!.next(project('P9'));
    fixture.detectChanges();
    expect(opened.map((o) => o.resourceId)).toEqual(['P9']);
    expect(root.querySelectorAll('li')).toHaveLength(1);
  });

  it('offers no new edit without core write, nor of a photo', () => {
    const reader = render(asset(), false);
    lists[0]!.next([]);
    reader.fixture.detectChanges();
    expect(reader.root.querySelector('button.new')).toBeNull();

    const photo = render(asset('image'), true);
    lists[1]!.next([]);
    photo.fixture.detectChanges();
    expect(photo.root.querySelector('button.new')).toBeNull();
    expect(photo.root.textContent).toContain('edits.notEditable');
  });
});
