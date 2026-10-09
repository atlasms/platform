import { describe, expect, it } from 'vitest';
import type { Category } from '../core/generated/mam.types.ts';
import { draftOf, patchOf } from './category-editor.ts';

const at = '2026-10-09T00:00:00.000Z';
const category = (over: Partial<Category> = {}): Category => ({
  id: 'c1',
  channelId: 'ch12',
  key: 'season-1',
  path: '/drama/the-series/season-1/',
  depth: 3,
  labels: { en: 'Season 1' },
  sortOrder: 0,
  mediaAddable: true,
  version: 4,
  createdBy: 'u1',
  createdAt: at,
  updatedAt: at,
  ...over,
});

describe('the category editor’s PATCH (EP-28.2)', () => {
  it('sends only what changed: a default set is merged, a default emptied is inherited again', () => {
    const before = category({ defaults: { genre: 'drama', supplyType: 'acquired' } });
    const d = draftOf(before);
    d.defaults.genre = 'thriller';
    d.defaults.supplyType = '';
    d.defaults.productionGroup = '  Studio B ';
    expect(patchOf(before, d)).toEqual({
      defaults: { genre: 'thriller', productionGroup: 'Studio B' },
      inherit: ['supplyType'],
    });
  });

  it('a policy is set, or inherited by choosing Inherit — false is a value, not "unset"', () => {
    const before = category({ reviewNeeded: true, keepDuration: 'P30D' });
    const d = draftOf(before);
    expect(d.reviewNeeded).toBe('true');
    d.reviewNeeded = 'false';
    d.keepDuration = '';
    d.defaultExpiry = 'P1Y';
    expect(patchOf(before, d)).toEqual({
      reviewNeeded: false,
      defaultExpiry: 'P1Y',
      inherit: ['keepDuration'],
    });

    const off = draftOf(before);
    off.reviewNeeded = '';
    expect(patchOf(before, off)).toEqual({ inherit: ['reviewNeeded'] });
  });

  it('an untouched draft is no patch at all', () => {
    const before = category({ defaults: { genre: 'drama' }, defaultExpiry: 'P1Y' });
    expect(patchOf(before, draftOf(before))).toEqual({});
  });
});
