// Rights windows (EP-31; scheduling.md §3, NFR-CMP-3) — when a channel may air an asset, or any
// asset of a category. Pure: the shape, the parse, and the one question validation asks.
//
// A window is PERMISSIVE: "this channel may air X between A and B". The rule a reel is held to:
//   - an asset with windows of its own is governed by those;
//   - otherwise, one whose schedule item names a category with windows is governed by the
//     category's (the category is the item's `categoryId` — what the scheduler placed);
//   - otherwise its rights are not managed here, and nothing is reported. Own productions need no
//     window; acquired content has one. Refusing everything without a window would turn every
//     channel's first validation red for media nobody licensed from anyone.
// A governed item must lie WHOLLY inside one window — starting before a licence opens or ending
// after it closes is airing unlicensed seconds.
//
// `territory` is recorded and not evaluated: a channel does not carry a territory yet, so there is
// nothing to compare it with. Saying so here is the point — a field that looks enforced and is not
// is worse than no field.

import { isUlid } from '@atlas/contracts';
import { ValidationError } from '@atlas/service-kit';

export interface RightsWindow {
  id: string;
  channelId: string;
  /** Exactly one of `assetId` and `categoryId`: what the window licenses. */
  assetId?: string;
  categoryId?: string;
  validFrom: string;
  validTo: string;
  /** Recorded, not evaluated (see above). */
  territory?: string;
  notes?: string;
  /** Bumped on every write; the audit revision and the compare-and-set token. */
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface RightsWindowInput {
  assetId?: string;
  categoryId?: string;
  validFrom: string;
  validTo: string;
  territory?: string;
  notes?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const FIELDS = new Set(['assetId', 'categoryId', 'validFrom', 'validTo', 'territory', 'notes']);

/** The wire body to an input, or a 422 that names the field. */
export function parseRightsWindowInput(body: unknown): RightsWindowInput {
  if (!isRecord(body)) throw new ValidationError('body must be an object');
  for (const key of Object.keys(body)) {
    if (!FIELDS.has(key)) throw new ValidationError(`${key} is not a rights window field`);
  }
  const text = (key: string): string | undefined => {
    const v = body[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v.trim() === '') {
      throw new ValidationError(`${key} must be a non-empty string`);
    }
    return v.trim();
  };
  const assetId = text('assetId');
  const categoryId = text('categoryId');
  if ((assetId === undefined) === (categoryId === undefined)) {
    throw new ValidationError('a rights window licenses exactly one of assetId or categoryId');
  }
  if (assetId !== undefined && !isUlid(assetId)) {
    throw new ValidationError('assetId must be a ULID');
  }
  const instant = (key: 'validFrom' | 'validTo'): string => {
    const v = text(key);
    if (v === undefined || Number.isNaN(Date.parse(v))) {
      throw new ValidationError(`${key} is required, an ISO date-time`);
    }
    return new Date(v).toISOString();
  };
  const validFrom = instant('validFrom');
  const validTo = instant('validTo');
  if (Date.parse(validTo) <= Date.parse(validFrom)) {
    throw new ValidationError('validTo must be after validFrom');
  }
  const territory = text('territory');
  const notes = text('notes');
  return {
    ...(assetId !== undefined ? { assetId } : {}),
    ...(categoryId !== undefined ? { categoryId } : {}),
    validFrom,
    validTo,
    ...(territory !== undefined ? { territory } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

/**
 * The windows that govern one item: the asset's own if it has any, else its category's, else
 * none (not managed). `windows` may hold any of the channel's; this picks.
 */
export function governingWindows(
  item: { mediaId?: string; categoryId?: string },
  windows: readonly RightsWindow[],
): { by: 'asset' | 'category'; windows: RightsWindow[] } | undefined {
  if (item.mediaId !== undefined) {
    const own = windows.filter((w) => w.assetId === item.mediaId);
    if (own.length > 0) return { by: 'asset', windows: own };
  }
  if (item.categoryId !== undefined) {
    const category = windows.filter((w) => w.categoryId === item.categoryId);
    if (category.length > 0) return { by: 'category', windows: category };
  }
  return undefined;
}

/** Does one of the windows hold the whole of [start, end]? */
export function covered(start: string, end: string, windows: readonly RightsWindow[]): boolean {
  const s = Date.parse(start);
  const e = Date.parse(end);
  return windows.some((w) => Date.parse(w.validFrom) <= s && e <= Date.parse(w.validTo));
}
