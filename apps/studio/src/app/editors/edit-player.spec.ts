import { TestBed } from '@angular/core/testing';
import { Subject, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileRef, MediaUrl } from '../core/generated/mam.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { MediaService } from '../core/media.service.ts';
import { EditPlayer } from './edit-player.ts';

const ASSET = '01K00000000000000000000SRC';

const file = (kind: string, variant?: string, frameRate?: number) =>
  ({
    kind,
    ...(variant !== undefined ? { variant } : {}),
    storage: { path: `/${kind}/${variant ?? ''}`, tier: 'online', status: 'available' },
    durationSec: 4,
    ...(frameRate !== undefined ? { frameRate } : {}),
  }) as FileRef;

const VTT = [
  'WEBVTT',
  '',
  '00:00:00.000 --> 00:00:02.000',
  'filmstrip.jpg#xywh=0,0,160,90',
  '',
  '00:00:02.000 --> 00:00:04.000',
  'filmstrip.jpg#xywh=160,0,160,90',
].join('\n');

class FakeMedia {
  readonly asked: Array<{ kind: string; variant: string | undefined; result: Subject<MediaUrl> }> =
    [];
  readonly texts: string[] = [];
  fail = false;
  url(_assetId: string, kind: string, variant?: string) {
    if (this.fail) return throwError(() => new Error('503'));
    const result = new Subject<MediaUrl>();
    this.asked.push({ kind, variant, result });
    return result;
  }
  text(url: string) {
    this.texts.push(url);
    return of(VTT);
  }
  /** Answer every outstanding request for `kind/variant`. */
  answer(kind: string, variant: string | undefined, url: string, expiresAt: string) {
    for (const a of this.asked.filter((x) => x.kind === kind && x.variant === variant)) {
      a.result.next({ url, expiresAt });
    }
  }
}

function setup(files: FileRef[], markable = true) {
  const media = new FakeMedia();
  TestBed.configureTestingModule({
    providers: [
      { provide: MediaService, useValue: media },
      { provide: LocaleService, useValue: { t: (k: string) => k, locale: () => 'en' } },
    ],
  });
  const fixture = TestBed.createComponent(EditPlayer);
  fixture.componentRef.setInput('assetId', ASSET);
  fixture.componentRef.setInput('files', files);
  fixture.componentRef.setInput('markable', markable);
  const marks: Array<{ which: string; sec: number }> = [];
  fixture.componentInstance.mark.subscribe((m) => marks.push(m));
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  const video = () => root.querySelector('video') as HTMLVideoElement;
  /** A browser that presents `mediaTime` for the next frame — or nothing, when `null`. */
  const presents = (mediaTime: number | null) => {
    (video() as unknown as Record<string, unknown>)['requestVideoFrameCallback'] = (
      cb: (n: number, m: { mediaTime: number }) => void,
    ) => {
      if (mediaTime !== null) queueMicrotask(() => cb(0, { mediaTime }));
      return 1;
    };
    (video() as unknown as Record<string, unknown>)['cancelVideoFrameCallback'] = () => undefined;
  };
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
  };
  const click = (selector: string) => {
    (root.querySelector(selector) as HTMLElement).click();
    fixture.detectChanges();
  };
  return { fixture, root, media, marks, video, presents, settle, click };
}

const later = (ms: number) => new Date(Date.now() + ms).toISOString();

afterEach(() => vi.useRealTimers());

describe('EditPlayer (EP-26.4)', () => {
  it('plays the editing proxy through a signed URL', () => {
    const { media, root, video, fixture } = setup([
      file('original'),
      file('proxy'),
      file('proxy', 'edit', 25),
    ]);
    expect(media.asked.map((a) => [a.kind, a.variant])).toEqual([['proxy', 'edit']]);
    media.answer('proxy', 'edit', '/media/v1/x/proxy?sig=1', later(30 * 60_000));
    fixture.detectChanges();
    expect(video().getAttribute('src')).toBe('/media/v1/x/proxy?sig=1');
    expect(root.querySelector('.filmstrip')).toBeNull();
  });

  it('says so when the source has no proxy to play', () => {
    const { root, media } = setup([file('original')]);
    expect(media.asked).toEqual([]);
    expect(root.querySelector('.no-proxy')).not.toBeNull();
  });

  it('steps frame by frame on floor(mediaTime·fps), and marks the frame shown — out inclusive', async () => {
    const t = setup([file('proxy', 'edit', 25)]);
    t.media.answer('proxy', 'edit', '/media/a', later(30 * 60_000));
    t.fixture.detectChanges();
    t.presents(1.02); // frame 25, as a browser would report it mid-frame
    t.fixture.componentInstance.seek(1.01);
    await t.settle();
    expect(t.video().currentTime).toBeCloseTo(1.02, 6); // aimed at the middle of frame 25
    expect(t.root.querySelector('.readout')!.textContent).toContain('00:00:01:00');

    t.presents(1.06);
    t.click('button.next');
    await t.settle();
    expect(t.video().currentTime).toBeCloseTo(1.06, 6);
    expect(t.root.querySelector('.readout')!.textContent).toContain('00:00:01:01');

    t.click('button.mark-in');
    t.click('button.mark-out');
    expect(t.marks).toEqual([
      { which: 'in', sec: 1.04 },
      { which: 'out', sec: 1.08 },
    ]);
  });

  it('a seek whose frame callback never comes still lands — the wait is bounded', async () => {
    const t = setup([file('proxy', 'edit', 25)]);
    t.media.answer('proxy', 'edit', '/media/a', later(30 * 60_000));
    t.fixture.detectChanges();
    t.presents(null);
    vi.useFakeTimers();
    t.fixture.componentInstance.seek(2);
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();
    t.fixture.detectChanges();
    expect(t.root.querySelector('.readout')!.textContent).toContain('00:00:02:00');
    t.click('button.mark-in');
    expect(t.marks).toEqual([{ which: 'in', sec: 2 }]);
  });

  it('without a recorded rate: no frame stepping, marks to the millisecond', () => {
    const t = setup([file('proxy', 'edit')]);
    t.media.answer('proxy', 'edit', '/media/a', later(30 * 60_000));
    t.fixture.detectChanges();
    expect((t.root.querySelector('button.next') as HTMLButtonElement).disabled).toBe(true);
    expect(t.root.querySelector('.no-rate')).not.toBeNull();
    expect(t.root.querySelector('input.scrub')).toBeNull();
  });

  it('offers no marks when the editor says not', () => {
    const t = setup([file('proxy', 'edit', 25)], false);
    t.media.answer('proxy', 'edit', '/media/a', later(30 * 60_000));
    t.fixture.detectChanges();
    expect(t.root.querySelector('button.mark-in')).toBeNull();
  });

  it('asks for a fresh URL a minute before expiry, keeping the position', async () => {
    vi.useFakeTimers();
    const t = setup([file('proxy', 'edit', 25)]);
    t.media.answer('proxy', 'edit', '/media/a', later(61_000));
    t.fixture.detectChanges();
    t.video().currentTime = 3.02;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.media.asked.filter((a) => a.kind === 'proxy')).toHaveLength(2);
    t.media.answer('proxy', 'edit', '/media/b', later(30 * 60_000));
    t.fixture.detectChanges();
    expect(t.video().getAttribute('src')).toBe('/media/b');
    // The new source loads: the playhead goes back where it was.
    t.video().currentTime = 0;
    t.video().dispatchEvent(new Event('loadedmetadata'));
    expect(t.video().currentTime).toBeCloseTo(3.02, 6);
  });

  it('a URL due while PLAYING is re-signed at the next pause, not mid-playback', async () => {
    vi.useFakeTimers();
    const t = setup([file('proxy', 'edit', 25)]);
    t.media.answer('proxy', 'edit', '/media/a', later(61_000));
    t.fixture.detectChanges();
    Object.defineProperty(t.video(), 'paused', { value: false, configurable: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.media.asked).toHaveLength(1);
    Object.defineProperty(t.video(), 'paused', { value: true, configurable: true });
    t.video().dispatchEvent(new Event('pause'));
    expect(t.media.asked).toHaveLength(2);
  });

  it('a media error re-signs ONCE; a second in a row is shown, with a retry', () => {
    const t = setup([file('proxy', 'edit', 25)]);
    t.media.answer('proxy', 'edit', '/media/a', later(30 * 60_000));
    t.fixture.detectChanges();
    t.video().dispatchEvent(new Event('error'));
    expect(t.media.asked).toHaveLength(2);
    t.media.answer('proxy', 'edit', '/media/b', later(30 * 60_000));
    t.fixture.detectChanges();
    t.video().dispatchEvent(new Event('error'));
    t.fixture.detectChanges();
    expect(t.root.querySelector('[role="alert"]')!.textContent).toContain('editPlayer.loadError');
    t.click('button.retry');
    expect(t.media.asked).toHaveLength(3);
  });

  it('shows an error when no URL can be had (503: no media key on the platform)', () => {
    const media = new FakeMedia();
    media.fail = true;
    TestBed.configureTestingModule({
      providers: [
        { provide: MediaService, useValue: media },
        { provide: LocaleService, useValue: { t: (k: string) => k, locale: () => 'en' } },
      ],
    });
    const fixture = TestBed.createComponent(EditPlayer);
    fixture.componentRef.setInput('assetId', ASSET);
    fixture.componentRef.setInput('files', [file('proxy', 'edit', 25)]);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('editPlayer.loadError');
  });

  it('draws the filmstrip from its two signed files, and a press on a thumbnail seeks there', async () => {
    const t = setup([
      file('proxy', 'edit', 25),
      file('vtt-filmstrip', 'sprite'),
      file('vtt-filmstrip', 'cues'),
    ]);
    t.media.answer('proxy', 'edit', '/media/p', later(30 * 60_000));
    t.media.answer('vtt-filmstrip', 'sprite', '/media/sprite?sig=s', later(30 * 60_000));
    t.media.answer('vtt-filmstrip', 'cues', '/media/cues?sig=c', later(30 * 60_000));
    t.fixture.detectChanges();
    expect(t.media.texts).toEqual(['/media/cues?sig=c']);
    const cells = [...t.root.querySelectorAll('.filmstrip .cell')] as HTMLElement[];
    expect(cells).toHaveLength(2);
    // The sprite is the SIGNED one, never the VTT's relative `filmstrip.jpg`.
    expect(cells[1]!.style.backgroundImage).toContain('/media/sprite?sig=s');
    expect(cells[1]!.style.backgroundPosition).toBe('-80px 0px');
    expect(cells[0]!.getAttribute('aria-current')).toBe('true');

    t.presents(2.02);
    const down = new Event('pointerdown', { bubbles: true }) as Event & Record<string, unknown>;
    Object.assign(down, { clientX: 0, clientY: 0, pointerId: 1 });
    cells[1]!.dispatchEvent(down);
    await t.settle();
    expect(t.video().currentTime).toBeCloseTo(2.02, 6);
    expect(cells[1]!.getAttribute('aria-current')).toBe('true');
  });
});
