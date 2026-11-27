import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  type ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { FileRef } from '../core/generated/mam.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { MediaService } from '../core/media.service.ts';
import {
  awaitFrame,
  cueAt,
  filmstripOf,
  frameAt,
  frameTimecode,
  lastFrame,
  markSec,
  parseFilmstrip,
  playableOf,
  refreshInMs,
  seekTargetSec,
  type FilmstripCue,
} from './edit-player.model.ts';
import { formatTimecode } from './shotlist.model.ts';

/** How much smaller than the sprite's own cells the filmstrip draws them. */
const STRIP_SCALE = 0.5;

/**
 * The media editor's player (EP-26.4; ADR-0011, ADR-0012): the source's editing proxy in a plain
 * `<video>`, read frame by frame, and scrubbed on its VTT filmstrip.
 *
 * - **What plays** is the editing proxy (`proxy`/`edit`, closed GOP 12) — the playback proxy when
 *   there is none — through a signed URL from MAM. A fresh URL is asked for a minute before the
 *   old one expires, and once on a media error (an expired URL stops mid-playback by design); the
 *   position and the paused state carry over.
 * - **The frame on screen** is `floor(mediaTime · fps)` from `requestVideoFrameCallback`, on the
 *   rate MTS measured on the proxy (`FileRef.frameRate`). A seek waits for its frame, but only for
 *   `SEEK_WAIT_MS`, then reads `currentTime`. A proxy with no recorded rate plays and marks to the
 *   millisecond, without frame stepping.
 * - **Marks** go to the editor (`mark`): `in` at the start of the frame shown, `out` at the start
 *   of the next, so both include what the person sees.
 * - **The filmstrip** (EP-29.4: a sprite and its WebVTT index, each signed on its own) is a strip
 *   of thumbnails; a click or a drag along it seeks to that point.
 */
@Component({
  selector: 'atlas-edit-player',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!playable()) {
      <p class="muted no-proxy">{{ locale.t('editPlayer.noProxy') }}</p>
    } @else if (error()) {
      <p class="error" role="alert">
        {{ error() }}
        <button type="button" class="link retry" (click)="retry()">
          {{ locale.t('editPlayer.retry') }}
        </button>
      </p>
    } @else {
      <div class="player">
        <video
          #video
          preload="auto"
          playsinline
          [src]="src() ?? ''"
          (loadedmetadata)="onLoaded()"
          (play)="onPlay()"
          (pause)="onPause()"
          (seeked)="onSeeked()"
          (error)="onMediaError()"
        ></video>
        <div class="controls">
          <button
            type="button"
            class="play"
            [attr.aria-label]="locale.t(paused() ? 'editPlayer.play' : 'editPlayer.pause')"
            (click)="toggle()"
          >
            {{ paused() ? '▶' : '❚❚' }}
          </button>
          <button
            type="button"
            class="prev"
            [attr.aria-label]="locale.t('editPlayer.prevFrame')"
            [disabled]="!fps()"
            (click)="step(-1)"
          >
            ⏴
          </button>
          <button
            type="button"
            class="next"
            [attr.aria-label]="locale.t('editPlayer.nextFrame')"
            [disabled]="!fps()"
            (click)="step(1)"
          >
            ⏵
          </button>
          <span class="readout" aria-live="polite">{{ readout() }}</span>
          @if (!fps()) {
            <span class="muted no-rate">{{ locale.t('editPlayer.noRate') }}</span>
          }
          @if (markable()) {
            <button type="button" class="mark-in" (click)="markAt('in')">
              {{ locale.t('editPlayer.setIn') }}
            </button>
            <button type="button" class="mark-out" (click)="markAt('out')">
              {{ locale.t('editPlayer.setOut') }}
            </button>
          }
        </div>
        @if (fps(); as rate) {
          <input
            type="range"
            class="scrub"
            min="0"
            step="1"
            [max]="last()"
            [value]="frame()"
            [attr.aria-label]="locale.t('editPlayer.scrub')"
            (input)="seekFrame(+$any($event.target).value)"
          />
        }
        @if (cues().length > 0 && spriteUrl()) {
          <div
            class="filmstrip"
            role="slider"
            tabindex="-1"
            [attr.aria-label]="locale.t('editPlayer.filmstrip')"
            [attr.aria-valuemin]="0"
            [attr.aria-valuemax]="duration()"
            [attr.aria-valuenow]="seconds()"
            (pointerdown)="stripDown($event)"
            (pointermove)="stripMove($event)"
            (pointerup)="dragging = false"
            (pointerleave)="dragging = false"
          >
            @for (c of cues(); track c.startSec) {
              <span
                class="cell"
                [attr.data-start]="c.startSec"
                [attr.aria-current]="c === current() ? 'true' : null"
                [style.width.px]="c.w * scale"
                [style.height.px]="c.h * scale"
                [style.background-image]="'url(' + spriteUrl() + ')'"
                [style.background-size]="spriteSize()"
                [style.background-position]="-c.x * scale + 'px ' + -c.y * scale + 'px'"
              ></span>
            }
          </div>
        }
      </div>
    }
  `,
  styles: `
    .player {
      display: grid;
      gap: var(--space-1);
      margin-block: var(--space-2);
    }
    video {
      width: 100%;
      max-height: 45vh;
      background: #000;
    }
    .controls {
      display: flex;
      align-items: center;
      gap: var(--space-1);
      flex-wrap: wrap;
    }
    .readout {
      font-family: ui-monospace, monospace;
      margin-inline: var(--space-2);
    }
    .scrub {
      width: 100%;
    }
    .filmstrip {
      display: flex;
      overflow-x: auto;
      cursor: ew-resize;
      touch-action: none;
      user-select: none;
    }
    .cell {
      flex: none;
      background-repeat: no-repeat;
      opacity: 0.75;
    }
    .cell[aria-current='true'] {
      opacity: 1;
      outline: 2px solid var(--color-accent);
      outline-offset: -2px;
    }
    .muted {
      color: var(--color-fg-muted);
    }
    .error {
      color: var(--color-danger);
    }
  `,
})
export class EditPlayer {
  /** The source asset whose files these are. */
  readonly assetId = input.required<string>();
  readonly files = input.required<readonly FileRef[]>();
  /** Offer Set in / Set out — the editor decides (a clip selected, `asset:write`). */
  readonly markable = input(false);
  /** A mark, in timeline seconds: the frame shown, as `in` or `out` (inclusive of it). */
  readonly mark = output<{ which: 'in' | 'out'; sec: number }>();

  private readonly media = inject(MediaService);
  protected readonly locale = inject(LocaleService);
  private readonly videoRef = viewChild<ElementRef<HTMLVideoElement>>('video');

  protected readonly playable = computed(() => playableOf(this.files()));
  protected readonly fps = computed(() => this.playable()?.frameRate);
  private readonly strip = computed(() => filmstripOf(this.files()));

  protected readonly src = signal<string | undefined>(undefined);
  protected readonly spriteUrl = signal<string | undefined>(undefined);
  protected readonly cues = signal<FilmstripCue[]>([]);
  protected readonly error = signal('');
  protected readonly paused = signal(true);
  /** The playhead in seconds, as last read from the video. */
  protected readonly seconds = signal(0);
  protected readonly duration = signal(0);

  /** The frame on screen — `floor(mediaTime·fps)` (ADR-0011); 0 without a rate. */
  protected readonly frame = computed(() => {
    const rate = this.fps();
    return rate ? frameAt(this.seconds(), rate) : 0;
  });
  protected readonly last = computed(() => {
    const rate = this.fps();
    return rate ? lastFrame(this.duration() || this.playable()?.durationSec || 0, rate) : 0;
  });
  protected readonly readout = computed(() => {
    const rate = this.fps();
    const tc = formatTimecode(Math.floor(this.seconds() * 1000));
    return rate ? `${frameTimecode(this.frame(), rate)} · ${tc}` : tc;
  });
  protected readonly current = computed(() => cueAt(this.cues(), this.seconds()));
  protected readonly scale = STRIP_SCALE;
  protected readonly spriteSize = computed(() => {
    const cues = this.cues();
    const w = Math.max(0, ...cues.map((c) => c.x + c.w)) * STRIP_SCALE;
    const h = Math.max(0, ...cues.map((c) => c.y + c.h)) * STRIP_SCALE;
    return `${w}px ${h}px`;
  });

  protected dragging = false;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private destroyed = false;
  /** A media error is answered with ONE fresh URL; a second one in a row is shown. */
  private retried = false;
  /** Where to put the playhead back when a fresh URL has loaded. */
  private restore: { sec: number; play: boolean } | undefined;
  /** Each seek's number: a frame callback for an older seek is ignored. */
  private seekSeq = 0;
  private playLoop: number | undefined;
  /** A URL came due while playing: re-signed at the next pause, not mid-playback. */
  private stale = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      clearTimeout(this.refreshTimer);
      this.stopLoop();
    });
    effect(() => {
      const assetId = this.assetId();
      const file = this.playable();
      const strip = this.strip();
      untracked(() => this.sign(assetId, file, strip));
    });
  }

  /** Put the playhead on `sec` — the frame it falls in, aimed at that frame's middle. */
  seek(sec: number): void {
    const rate = this.fps();
    if (rate) this.seekFrame(frameAt(sec, rate));
    else this.seekTo(sec);
  }

  protected seekFrame(frame: number): void {
    const rate = this.fps();
    if (!rate) return;
    const clamped = Math.min(Math.max(0, frame), this.last() || frame);
    this.seekTo(seekTargetSec(clamped, rate));
  }

  protected step(by: -1 | 1): void {
    const video = this.videoRef()?.nativeElement;
    if (video && !video.paused) video.pause();
    this.seekFrame(this.frame() + by);
  }

  protected toggle(): void {
    const video = this.videoRef()?.nativeElement;
    if (!video) return;
    if (video.paused) void video.play()?.catch?.(() => undefined);
    else video.pause();
  }

  protected markAt(which: 'in' | 'out'): void {
    const rate = this.fps();
    const sec = rate
      ? markSec(this.frame(), rate, which)
      : Math.floor(this.seconds() * 1000) / 1000;
    this.mark.emit({ which, sec });
  }

  protected retry(): void {
    this.retried = false;
    this.error.set('');
    this.sign(this.assetId(), this.playable(), this.strip());
  }

  // --- the filmstrip ----------------------------------------------------------------------------

  protected stripDown(event: PointerEvent): void {
    this.dragging = true;
    (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
    this.stripSeek(event);
  }

  protected stripMove(event: PointerEvent): void {
    if (this.dragging) this.stripSeek(event);
  }

  /** The cell under the pointer, and how far across it: a time inside that cell's span. */
  private stripSeek(event: PointerEvent): void {
    const target = document.elementFromPoint?.(event.clientX, event.clientY) ?? event.target;
    const cell = (target as HTMLElement | null)?.closest?.('.cell') as HTMLElement | null;
    if (!cell) return;
    const cue = this.cues().find((c) => String(c.startSec) === cell.dataset['start']);
    if (!cue) return;
    const box = cell.getBoundingClientRect();
    const across = box.width > 0 ? (event.clientX - box.left) / box.width : 0;
    const rtl = getComputedStyle?.(cell)?.direction === 'rtl';
    const fraction = Math.min(1, Math.max(0, rtl ? 1 - across : across));
    this.seek(cue.startSec + fraction * (cue.endSec - cue.startSec));
  }

  // --- the video's events -----------------------------------------------------------------------

  protected onLoaded(): void {
    const video = this.videoRef()?.nativeElement;
    if (!video) return;
    this.retried = false;
    if (Number.isFinite(video.duration)) this.duration.set(video.duration);
    const restore = this.restore;
    this.restore = undefined;
    if (restore) {
      this.seekTo(restore.sec);
      if (restore.play) void video.play()?.catch?.(() => undefined);
    }
  }

  protected onPlay(): void {
    this.paused.set(false);
    this.startLoop();
  }

  protected onPause(): void {
    this.paused.set(true);
    this.stopLoop();
    if (this.stale) {
      this.stale = false;
      this.refresh();
      return;
    }
    // Where it stopped, frame-exact: the next presented frame says.
    const video = this.videoRef()?.nativeElement;
    if (video) void this.readFrame(video, ++this.seekSeq);
  }

  protected onSeeked(): void {
    // A seek nobody here started (the native controls, a restore): read where it landed.
    const video = this.videoRef()?.nativeElement;
    if (video && video.paused) this.seconds.set(video.currentTime);
  }

  /** An expired URL, a file moved since it was signed: ask for ONE fresh URL, then say so. */
  protected onMediaError(): void {
    if (!this.src()) return;
    if (this.retried) {
      this.error.set(this.locale.t('editPlayer.loadError'));
      return;
    }
    this.retried = true;
    this.refresh();
  }

  // --- internals --------------------------------------------------------------------------------

  private seekTo(sec: number): void {
    const video = this.videoRef()?.nativeElement;
    if (!video) return;
    video.currentTime = sec;
    this.seconds.set(sec);
    void this.readFrame(video, ++this.seekSeq);
  }

  /** The frame actually presented — bounded, so a missing callback never hangs a scrub. */
  private async readFrame(video: HTMLVideoElement, seq: number): Promise<void> {
    const { mediaTime } = await awaitFrame(video);
    if (this.destroyed || seq !== this.seekSeq) return;
    this.seconds.set(mediaTime);
  }

  /** While playing, every presented frame moves the readout. */
  private startLoop(): void {
    const video = this.videoRef()?.nativeElement;
    if (!video || typeof video.requestVideoFrameCallback !== 'function') return;
    this.stopLoop();
    const tick = (_now: number, meta: { mediaTime: number }) => {
      if (this.destroyed || video.paused) return;
      this.seconds.set(meta.mediaTime);
      this.playLoop = video.requestVideoFrameCallback(tick);
    };
    this.playLoop = video.requestVideoFrameCallback(tick);
  }

  private stopLoop(): void {
    const video = this.videoRef()?.nativeElement;
    if (this.playLoop !== undefined) video?.cancelVideoFrameCallback?.(this.playLoop);
    this.playLoop = undefined;
  }

  /** Sign what this player shows: the proxy, and the filmstrip's two files when there are both. */
  private sign(
    assetId: string,
    file: FileRef | undefined,
    strip: { cues: FileRef; sprite: FileRef } | undefined,
  ): void {
    clearTimeout(this.refreshTimer);
    if (!file) {
      this.src.set(undefined);
      return;
    }
    this.media.url(assetId, file.kind, file.variant).subscribe({
      next: ({ url, expiresAt }) => {
        if (this.destroyed || assetId !== this.assetId()) return;
        this.src.set(url);
        this.refreshTimer = setTimeout(() => this.due(), refreshInMs(expiresAt, Date.now()));
      },
      error: () => this.error.set(this.locale.t('editPlayer.loadError')),
    });
    if (strip) this.signStrip(assetId, strip);
  }

  private signStrip(assetId: string, strip: { cues: FileRef; sprite: FileRef }): void {
    // The filmstrip is a help, not the player: if it cannot be had, the strip is simply absent.
    this.media.url(assetId, strip.sprite.kind, strip.sprite.variant).subscribe({
      next: ({ url }) => {
        if (!this.destroyed) this.spriteUrl.set(url);
      },
      error: () => this.spriteUrl.set(undefined),
    });
    if (this.cues().length > 0) return; // the cues are text, read once; only the sprite is re-signed
    this.media.url(assetId, strip.cues.kind, strip.cues.variant).subscribe({
      next: ({ url }) =>
        this.media.text(url).subscribe({
          next: (vtt) => {
            if (!this.destroyed) this.cues.set(parseFilmstrip(vtt));
          },
          error: () => this.cues.set([]),
        }),
      error: () => this.cues.set([]),
    });
  }

  /**
   * The URL is about to expire. Paused, swap it now; playing, at the next pause — a swap restarts
   * the load, and what is buffered plays on. If it runs out first, the refusal is a media error,
   * which re-signs at once.
   */
  private due(): void {
    const video = this.videoRef()?.nativeElement;
    if (video && !video.paused) this.stale = true;
    else this.refresh();
  }

  /** A fresh URL in place of one about to expire (or already refused), keeping the position. */
  private refresh(): void {
    this.stale = false;
    const video = this.videoRef()?.nativeElement;
    if (video && this.src()) {
      this.restore = { sec: video.currentTime || this.seconds(), play: !video.paused };
    }
    this.sign(this.assetId(), this.playable(), this.strip());
  }
}
