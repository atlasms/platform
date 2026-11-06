import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Asset } from '../core/generated/mam.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { FieldOrigin } from './field-origin.ts';

const AT = '2026-11-06T12:00:00.000Z';
const base = {
  id: '01K00000000000000000000AST',
  channelId: 'ch12',
  title: 'Clip',
  mediaType: 'video',
  fileType: 'mxf',
  state: 'ready',
  version: 4,
  hasRenditions: true,
  createdBy: 'u1',
  createdAt: AT,
  updatedAt: AT,
} as Asset;

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
  imports: [FieldOrigin],
  template: `<atlas-field-origin
    [asset]="asset()"
    field="durationSec"
    [canEdit]="canEdit()"
    (use)="used.push($event)"
    (dismiss)="dismissed = dismissed + 1"
  />`,
})
class Host {
  readonly asset = signal<Asset>(base);
  readonly canEdit = signal(true);
  used: unknown[] = [];
  dismissed = 0;
}

describe('FieldOrigin (EP-27.5)', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      imports: [Host],
      providers: [{ provide: LocaleService, useClass: FakeLocale }],
    }),
  );

  const render = (asset: Asset, canEdit = true) => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.asset.set(asset);
    fixture.componentInstance.canEdit.set(canEdit);
    fixture.detectChanges();
    return fixture;
  };
  const text = (f: ReturnType<typeof render>) =>
    (f.nativeElement as HTMLElement).textContent?.replace(/\s+/g, ' ').trim();

  it('says nothing for a value a person set, and names a measured one', () => {
    const own = render({
      ...base,
      provenance: { durationSec: { source: 'user', by: 'u1', at: AT } },
    });
    expect(text(own)).toBe('');
    const measured = render({
      ...base,
      provenance: { durationSec: { source: 'technical', by: 'mts', at: AT } },
    });
    expect(text(measured)).toBe('provenance.technical');
  });

  it('offers a held value — Use puts it in the form, Dismiss asks for it to be dropped', () => {
    const fixture = render({
      ...base,
      durationSec: 90,
      provenance: { durationSec: { source: 'user', by: 'u1', at: AT } },
      derived: { durationSec: { value: 92.04, source: 'technical', by: 'mts', at: AT } },
    });
    expect(text(fixture)).toContain('provenance.technical: 92.04');
    const [use, dismiss] = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    );
    use!.click();
    dismiss!.click();
    expect(fixture.componentInstance.used).toEqual([92.04]);
    expect(fixture.componentInstance.dismissed).toBe(1);
  });

  it('shows an AI value’s confidence, and offers nothing to someone who cannot edit the field', () => {
    const fixture = render(
      {
        ...base,
        derived: {
          durationSec: { value: 91, source: 'ai', by: 'ai', at: AT, confidence: 0.82 },
        },
      },
      false,
    );
    expect(text(fixture)).toBe('provenance.ai · 82%: 91');
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('button')).toHaveLength(0);
  });
});
