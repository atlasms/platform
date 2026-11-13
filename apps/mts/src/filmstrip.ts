// EP-29.4 — the VTT scrub filmstrip: a sprite sheet and the WebVTT that indexes it.
//
// A filmstrip is ONE rendition kind (`vtt-filmstrip`) made of TWO files: a single image holding a
// grid of thumbnails, and a WebVTT file whose cues say "the frame at this time is this rectangle of
// that image". A player (EP-26.4) loads the VTT as a metadata track and shows the matching cell as
// the pointer moves along the scrub bar. The two files are stored as VARIANTS of the one kind
// (`sprite`, `cues`), which the FileRef key `(assetId, kind, variant)` (data-model §1.5) already
// tells apart — the `variant` field on `Rendition` (EP-29.4) is what carries that over the wire.
//
// Geometry is COMPUTED, not guessed: FFmpeg's `tile` filter packs the thumbnails, and the same
// arithmetic that tells FFmpeg the grid tells the VTT where each cell landed. One computation
// produces both, so the cues cannot drift from the sprite.

/** The relative name the cues reference the sprite by — the serving layer puts the sprite here. */
export const FILMSTRIP_SPRITE_NAME = 'filmstrip.jpg';

export interface FilmstripSpec {
  /** Grid width in cells. The sprite is at most this many thumbnails across. */
  columns: number;
  /** One cell, in pixels. Fixed, so every cue's rectangle is the same size and the maths is trivial. */
  cellWidth: number;
  cellHeight: number;
  /** The most thumbnails to take, however long the video — a 3-hour film needs no 10,000 cells. */
  maxThumbs: number;
}

export interface FilmstripPlan extends FilmstripSpec {
  /** Seconds between thumbnails. Cue i covers roughly [i·interval, (i+1)·interval). */
  intervalSec: number;
  /** How many thumbnails the sprite holds and the VTT references. */
  thumbs: number;
  /** The grid actually used — `columns`, unless there are fewer thumbnails than that. */
  gridColumns: number;
  gridRows: number;
}

/**
 * Lay out a filmstrip for a clip of `durationSec` under `spec`.
 *
 * One thumbnail per `intervalSec`, the interval stretched so there are never more than `maxThumbs`
 * of them. The count is `ceil(duration/interval)`, which is what `fps=1/interval` emits over the
 * clip; the grid is sized to hold exactly that, so no referenced cell lies outside the sprite.
 */
export function planFilmstrip(durationSec: number, spec: FilmstripSpec): FilmstripPlan {
  const duration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  // Whole seconds: `fps=1/interval` wants a rate, and a sub-second interval on a long film is
  // thousands of near-identical cells nobody scrubs between.
  const intervalSec = Math.max(1, Math.ceil(duration / spec.maxThumbs));
  const thumbs = Math.min(spec.maxThumbs, Math.max(1, Math.ceil(duration / intervalSec)));
  const gridColumns = Math.min(spec.columns, thumbs);
  const gridRows = Math.ceil(thumbs / gridColumns);
  return { ...spec, intervalSec, thumbs, gridColumns, gridRows };
}

/** The `-vf` filter chain that packs the thumbnails into one sprite, per the plan. */
export function filmstripFilter(plan: FilmstripPlan): string {
  // fps picks one frame per interval; scale+pad forces every frame into an identical cell
  // (letterbox rather than stretch, so a 4:3 insert in a 16:9 strip is not squashed); tile lays
  // them out left-to-right, top-to-bottom — the same order the cue index walks.
  return (
    `fps=1/${plan.intervalSec},` +
    `scale=${plan.cellWidth}:${plan.cellHeight}:force_original_aspect_ratio=decrease,` +
    `pad=${plan.cellWidth}:${plan.cellHeight}:(ow-iw)/2:(oh-ih)/2:color=black,` +
    `tile=${plan.gridColumns}x${plan.gridRows}`
  );
}

/** A second count as a WebVTT timestamp, `HH:MM:SS.mmm`. */
export function vttTimestamp(totalSec: number): string {
  const ms = Math.max(0, Math.round(totalSec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(h)}:${p2(m)}:${p2(s)}.${String(millis).padStart(3, '0')}`;
}

/**
 * The WebVTT cues for a plan. Each cue names the sprite by a RELATIVE filename and a media fragment
 * (`#xywh=x,y,w,h`) — the convention every scrub player understands, and the reason the sprite is
 * served beside the cues under {@link FILMSTRIP_SPRITE_NAME} rather than by its HSM path (which the
 * player never sees).
 */
export function filmstripVtt(
  plan: FilmstripPlan,
  durationSec: number,
  spriteName: string = FILMSTRIP_SPRITE_NAME,
): string {
  const duration =
    Number.isFinite(durationSec) && durationSec > 0 ? durationSec : plan.thumbs * plan.intervalSec;
  const lines = ['WEBVTT', ''];
  for (let i = 0; i < plan.thumbs; i++) {
    const start = i * plan.intervalSec;
    // The last cue ends at the clip's end, not a whole interval past it.
    const end = Math.min((i + 1) * plan.intervalSec, Math.max(duration, start + 0.001));
    const col = i % plan.gridColumns;
    const row = Math.floor(i / plan.gridColumns);
    const x = col * plan.cellWidth;
    const y = row * plan.cellHeight;
    lines.push(`${vttTimestamp(start)} --> ${vttTimestamp(end)}`);
    lines.push(`${spriteName}#xywh=${x},${y},${plan.cellWidth},${plan.cellHeight}`);
    lines.push('');
  }
  return lines.join('\n');
}
