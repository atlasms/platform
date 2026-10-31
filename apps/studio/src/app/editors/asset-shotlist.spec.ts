import { HttpErrorResponse } from '@angular/common/http';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { AssetsService } from '../core/assets.service.ts';
import type { Asset, ShotList, ShotListItemInput } from '../core/generated/mam.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { AssetShotList } from './asset-shotlist.ts';

const ASSET_ID = '01K00000000000000000000AST';
const asset = (version = 4): Asset =>
  ({
    id: ASSET_ID,
    channelId: 'ch12',
    title: 'Clip',
    mediaType: 'video',
    fileType: 'mxf',
    state: 'ready',
    version,
    hasRenditions: true,
    createdBy: 'u1',
    createdAt: '2026-10-20T09:00:00.000Z',
    updatedAt: '2026-10-20T09:00:00.000Z',
  }) as Asset;

class FakeAssets {
  readonly reads: Subject<ShotList>[] = [];
  readonly saves: Array<{ items: ShotListItemInput[]; result: Subject<ShotList> }> = [];
  shotlist(_id: string) {
    const s = new Subject<ShotList>();
    this.reads.push(s);
    return s;
  }
  setShotlist(_id: string, items: ShotListItemInput[]) {
    const result = new Subject<ShotList>();
    this.saves.push({ items, result });
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

@Component({
  imports: [AssetShotList],
  template: `<atlas-asset-shotlist [asset]="asset()" [canEdit]="canEdit()" />`,
})
class Host {
  readonly asset = signal(asset());
  readonly canEdit = signal(true);
}

const LIST: ShotList = {
  assetId: ASSET_ID,
  items: [{ id: 'S1', startMs: 0, endMs: 4_000, description: 'Opening' }],
};

function setup() {
  const fake = new FakeAssets();
  TestBed.configureTestingModule({
    providers: [
      { provide: AssetsService, useValue: fake },
      { provide: LocaleService, useClass: FakeLocale },
    ],
  });
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  const inputs = () => [...root.querySelectorAll('input')] as HTMLInputElement[];
  const type = (el: HTMLInputElement, value: string) => {
    el.value = value;
    el.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };
  const click = (selector: string) => {
    (root.querySelector(selector) as HTMLButtonElement).click();
    fixture.detectChanges();
  };
  const answer = (list: ShotList) => {
    fake.reads.at(-1)!.next(list);
    fixture.detectChanges();
  };
  return { fixture, root, host: fixture.componentInstance, fake, inputs, type, click, answer };
}

describe('AssetShotList — the asset’s notable segments', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('reads the list on entry and shows each shot’s timecodes and description', () => {
    const t = setup();
    expect(t.fake.reads.length).toBe(1);
    t.answer(LIST);
    expect(t.inputs().map((i) => i.value)).toEqual(['00:00:00.000', '00:00:04.000', 'Opening']);
    expect((t.root.querySelector('.save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('adds a shot after the last, saves the whole list with ids kept, and shows what MAM stored', () => {
    const t = setup();
    t.answer(LIST);
    t.click('.add');
    const [, , , start, end, description] = t.inputs();
    expect(start!.value).toBe('00:00:04.000');
    t.type(end!, '0:12');
    t.type(description!, 'Interview');
    t.click('.save');
    expect(t.fake.saves[0]!.items).toEqual([
      { id: 'S1', startMs: 0, endMs: 4_000, description: 'Opening' },
      { startMs: 4_000, endMs: 12_000, description: 'Interview' },
    ]);
    t.fake.saves[0]!.result.next({
      assetId: ASSET_ID,
      items: [...LIST.items, { id: 'S2', startMs: 4_000, endMs: 12_000, description: 'Interview' }],
    });
    t.fixture.detectChanges();
    expect((t.root.querySelector('.save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a timecode that is not one is refused in the form — nothing is sent', () => {
    const t = setup();
    t.answer(LIST);
    t.type(t.inputs()[1]!, 'later');
    t.click('.save');
    expect(t.fake.saves.length).toBe(0);
    expect(t.root.querySelector('.field-error')?.textContent).toContain('shotlist.badTimecode');
  });

  it("MAM's 422 is shown under the field it names", () => {
    const t = setup();
    t.answer(LIST);
    t.type(t.inputs()[1]!, '00:10:00');
    t.click('.save');
    t.fake.saves[0]!.result.error(
      new HttpErrorResponse({
        status: 422,
        error: {
          details: {
            problems: [{ path: 'items/0/endMs', message: 'is past the end of the media' }],
          },
        },
      }),
    );
    t.fixture.detectChanges();
    expect(t.root.querySelector('.field-error')?.textContent).toContain('past the end');
    expect(t.root.querySelector('[role=alert]')?.textContent).toContain('shotlist.refused');
  });

  it('read-only without the shotlist grant — and re-read when the asset moves on, unless edited', () => {
    const t = setup();
    t.host.canEdit.set(false);
    t.fixture.detectChanges();
    t.answer(LIST);
    expect(t.inputs().every((i) => i.readOnly)).toBe(true);
    expect(t.root.querySelector('.add')).toBeNull();
    t.host.asset.set(asset(5));
    t.fixture.detectChanges();
    expect(t.fake.reads.length, 'a new version is read again').toBe(2);
  });
});
