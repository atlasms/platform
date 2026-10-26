import { HttpErrorResponse } from '@angular/common/http';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { AssetsService, type ApproveInput, type RejectInput } from '../core/assets.service.ts';
import type { Asset, VerdictPage } from '../core/generated/mam.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { AssetReview } from './asset-review.ts';

const asset = (overrides: Partial<Asset> = {}): Asset =>
  ({
    id: '01K00000000000000000000AST',
    channelId: 'ch12',
    title: 'Clip',
    mediaType: 'video',
    fileType: 'mxf',
    state: 'ready',
    version: 4,
    hasRenditions: true,
    createdBy: 'u1',
    createdAt: '2026-10-20T09:00:00.000Z',
    updatedAt: '2026-10-20T09:00:00.000Z',
    ...overrides,
  }) as Asset;

class FakeAssets {
  readonly reads: Subject<VerdictPage>[] = [];
  readonly approvals: Array<{ input: ApproveInput; result: Subject<Asset> }> = [];
  readonly rejections: Array<{ input: RejectInput; result: Subject<Asset> }> = [];
  verdicts(_id: string) {
    const s = new Subject<VerdictPage>();
    this.reads.push(s);
    return s;
  }
  approve(_id: string, input: ApproveInput) {
    const result = new Subject<Asset>();
    this.approvals.push({ input, result });
    return result;
  }
  reject(_id: string, input: RejectInput) {
    const result = new Subject<Asset>();
    this.rejections.push({ input, result });
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
  imports: [AssetReview],
  template: `<atlas-asset-review
    [asset]="asset()"
    [defaultExpiry]="defaultExpiry"
    [canApprove]="canApprove()"
    (changed)="changed.push($event)"
  />`,
})
class Host {
  readonly asset = signal(asset());
  readonly canApprove = signal(true);
  defaultExpiry = 'P1Y';
  readonly changed: Asset[] = [];
}

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
  const review = () =>
    fixture.debugElement.children[0]!.componentInstance as unknown as {
      approve(): void;
      reject(): void;
      choice: { set(v: string): void };
      date: { set(v: string): void };
      reason: { set(v: string): void };
      retainUntil: { set(v: string): void };
    };
  const history = (page: VerdictPage) => {
    fake.reads.at(-1)?.next(page);
    fixture.detectChanges();
  };
  return { fixture, root, host: fixture.componentInstance, fake, review, history };
}

describe('AssetReview — the verdict, and the history', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('shows the retained history, newest first as MAM keeps it — automatic ones marked', () => {
    const t = setup();
    t.history({
      items: [
        {
          id: 'v2',
          assetId: 'a',
          channelId: 'ch12',
          verdict: 'approved',
          decidedBy: 'mam',
          decidedAt: '2026-10-21T08:00:00.000Z',
          automatic: true,
          expiresAt: '2027-10-21T08:00:00.000Z',
          expirySource: 'category',
        },
        {
          id: 'v1',
          assetId: 'a',
          channelId: 'ch12',
          verdict: 'rejected',
          decidedBy: 'ben',
          decidedAt: '2026-10-20T10:00:00.000Z',
          reason: 'audio drops',
          reviewPointId: 'qc',
        },
      ],
    });
    const rows = [...t.root.querySelectorAll('.history li')].map((li) =>
      li.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(rows[0]).toContain('review.verdict.approved · review.automatic');
    expect(rows[0]).toContain('review.expiresAt 2027-10-21 (review.fromCategory)');
    expect(rows[1]).toContain('ben');
    expect(rows[1]).toContain('review.at qc');
    expect(rows[1]).toContain('audio drops');
  });

  it('approves with the expiry chosen — inherit sends none, a date its start, permanent null', () => {
    const t = setup();
    expect(t.root.textContent).toContain('(P1Y)'); // what inherit will snapshot
    t.review().approve();
    expect(t.fake.approvals[0]?.input).toEqual({});
    t.review().choice.set('permanent');
    t.review().approve();
    expect(t.fake.approvals[1]?.input).toEqual({ expiresAt: null });
    t.review().choice.set('date');
    t.review().date.set('2099-01-01');
    t.review().approve();
    expect(t.fake.approvals[2]?.input).toEqual({ expiresAt: '2099-01-01T00:00:00.000Z' });

    // MAM answers with the asset; the editor shows it, and the history is read again.
    t.fake.approvals[2]?.result.next(asset({ state: 'approved', version: 5 }));
    expect(t.host.changed.map((a) => a.state)).toEqual(['approved']);
    t.host.asset.set(asset({ state: 'approved', version: 5 }));
    t.fixture.detectChanges();
    expect(t.fake.reads.length).toBe(2);
  });

  it('a rejection must state a reason; retention is optional; MAM’s refusal is shown in its words', () => {
    const t = setup();
    const reject = t.root.querySelector('button.reject') as HTMLButtonElement;
    expect(reject.disabled).toBe(true);
    t.review().reason.set('  audio drops at 00:12  ');
    t.review().retainUntil.set('2026-12-01');
    t.fixture.detectChanges();
    expect(reject.disabled).toBe(false);
    t.review().reject();
    expect(t.fake.rejections[0]?.input).toEqual({
      reason: 'audio drops at 00:12',
      retainUntil: '2026-12-01T00:00:00.000Z',
    });
    t.fake.rejections[0]?.result.error(
      new HttpErrorResponse({ status: 409, error: { detail: 'cannot reject this asset' } }),
    );
    t.fixture.detectChanges();
    expect(t.root.querySelector('.error')?.textContent?.trim()).toBe('cannot reject this asset');
  });

  it('a past date is refused before anything is sent', () => {
    const t = setup();
    t.review().choice.set('date');
    t.review().date.set('2000-01-01');
    t.review().approve();
    t.fixture.detectChanges();
    expect(t.fake.approvals.length).toBe(0);
    expect(t.root.querySelector('.error')?.textContent?.trim()).toBe('review.badDate');
  });

  it('no verdict is offered without asset:approve, or once the asset has one', () => {
    const t = setup();
    t.host.canApprove.set(false);
    t.fixture.detectChanges();
    expect(t.root.querySelector('.verdict')).toBeNull();
    t.host.canApprove.set(true);
    t.host.asset.set(asset({ state: 'approved', expiresAt: '2099-01-01T00:00:00.000Z' }));
    t.fixture.detectChanges();
    expect(t.root.querySelector('.verdict')).toBeNull();
    expect(t.root.querySelector('.badge')?.getAttribute('data-tone')).toBe('ok');
    // Expired: due re-review — offered again.
    t.host.asset.set(asset({ state: 'expired', version: 6 }));
    t.fixture.detectChanges();
    expect(t.root.querySelector('.verdict')).not.toBeNull();
  });
});
