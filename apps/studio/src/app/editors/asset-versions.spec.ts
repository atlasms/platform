import { HttpErrorResponse } from '@angular/common/http';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError, type Observable } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { AssetsService, type ListOptions, type Page } from '../core/assets.service.ts';
import type { Asset } from '../core/generated/mam.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import { AssetVersions, canBecomeVersionOf } from './asset-versions.ts';

const AT = '2026-11-06T12:00:00.000Z';
const asset = (id: string, extra: Partial<Asset> = {}): Asset =>
  ({
    id,
    channelId: 'ch12',
    title: `Asset ${id.slice(-3)}`,
    mediaType: 'video',
    fileType: 'mxf',
    state: 'ready',
    version: 1,
    hasRenditions: true,
    createdBy: 'u1',
    createdAt: AT,
    updatedAt: AT,
    ...extra,
  }) as Asset;

const OLD = asset('01K00000000000000000000OLD', { state: 'approved' });
const NEW = asset('01K00000000000000000000NEW', { state: 'processing' });

class FakeAssets {
  chain: Asset[] = [OLD];
  page: Asset[] = [];
  listed: ListOptions[] = [];
  made: [string, string][] = [];
  refuse: string | null = null;
  versions(): Observable<{ items: Asset[] }> {
    return of({ items: this.chain });
  }
  list(options: ListOptions): Observable<Page<Asset>> {
    this.listed.push(options);
    return of({ items: this.page });
  }
  createVersion(id: string, assetId: string): Observable<Asset> {
    this.made.push([id, assetId]);
    if (this.refuse) {
      return throwError(
        () => new HttpErrorResponse({ status: 409, error: { detail: this.refuse } }),
      );
    }
    return of({ ...NEW, replacesId: id, title: OLD.title });
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
  imports: [AssetVersions],
  template: `<atlas-asset-versions
    [asset]="asset()"
    [canEdit]="canEdit()"
    (changed)="changed = changed + 1"
  />`,
})
class Host {
  readonly asset = signal<Asset>(OLD);
  readonly canEdit = signal(true);
  changed = 0;
}

describe('AssetVersions (EP-27.6)', () => {
  let assets: FakeAssets;
  let opened: string[];

  beforeEach(() => {
    assets = new FakeAssets();
    opened = [];
    TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        { provide: AssetsService, useValue: assets },
        { provide: LocaleService, useClass: FakeLocale },
        {
          provide: EditorStore,
          useValue: { open: (d: { resourceId: string }) => opened.push(d.resourceId) },
        },
      ],
    });
  });

  const render = (a: Asset = OLD, canEdit = true) => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.asset.set(a);
    fixture.componentInstance.canEdit.set(canEdit);
    fixture.detectChanges();
    return fixture;
  };
  const el = (f: ReturnType<typeof render>) => f.nativeElement as HTMLElement;
  const button = (f: ReturnType<typeof render>, cls: string) =>
    el(f).querySelector<HTMLButtonElement>(`button.${cls}`);

  it('the picker offers only what MAM would accept', () => {
    expect(canBecomeVersionOf(OLD, NEW)).toBe(true);
    expect(canBecomeVersionOf(OLD, OLD)).toBe(false);
    expect(canBecomeVersionOf(OLD, { ...NEW, mediaType: 'audio' })).toBe(false);
    expect(canBecomeVersionOf(OLD, { ...NEW, replacesId: 'x' })).toBe(false);
    expect(canBecomeVersionOf(OLD, { ...NEW, state: 'approved' })).toBe(false);
  });

  it('lists the chain oldest first, this version marked and the others opened in their tab', () => {
    assets.chain = [OLD, { ...NEW, replacesId: OLD.id }];
    const fixture = render({ ...NEW, replacesId: OLD.id });
    const rows = Array.from(el(fixture).querySelectorAll('.chain li'));
    expect(rows.map((r) => r.querySelector('.n')?.textContent)).toEqual(['v1', 'v2']);
    expect(rows[1]!.classList.contains('current')).toBe(true);
    rows[0]!.querySelector<HTMLButtonElement>('button.link')!.click();
    expect(opened).toEqual([OLD.id]);
  });

  it('makes a chosen upload the new version, opens it, and has the editor reload', () => {
    assets.page = [NEW, { ...NEW, id: '01K0000000000000000000AUDIO', mediaType: 'audio' }];
    const fixture = render();
    button(fixture, 'find')!.click();
    fixture.detectChanges();
    expect(assets.listed[0]?.state).toBe('created,processing,ready');
    const options = Array.from(el(fixture).querySelectorAll('select option')).map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(options, 'the audio asset is not offered').toEqual(['', NEW.id]);
    const select = el(fixture).querySelector('select')!;
    select.value = NEW.id;
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    button(fixture, 'create')!.click();
    expect(assets.made).toEqual([[OLD.id, NEW.id]]);
    expect(opened).toEqual([NEW.id]);
    expect(fixture.componentInstance.changed).toBe(1);
  });

  it('shows MAM’s refusal; a superseded asset points at its successor and offers nothing', () => {
    assets.page = [NEW];
    assets.refuse = 'asset 01K… already has a verdict (approved)';
    const fixture = render();
    button(fixture, 'find')!.click();
    fixture.detectChanges();
    const select = el(fixture).querySelector('select')!;
    select.value = NEW.id;
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    button(fixture, 'create')!.click();
    fixture.detectChanges();
    expect(el(fixture).querySelector('.error')?.textContent).toContain('already has a verdict');

    const superseded = render({ ...OLD, replacedById: NEW.id });
    expect(el(superseded).querySelector('.superseded')).not.toBeNull();
    expect(button(superseded, 'find')).toBeNull();
    el(superseded).querySelector<HTMLButtonElement>('.superseded button')!.click();
    expect(opened).toContain(NEW.id);

    expect(button(render(OLD, false), 'find'), 'no grant, no offer').toBeNull();
  });
});
