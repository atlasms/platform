// #260 — the category tree as Studio shows it: rows under expansion, the picker, move targets.

import { describe, expect, it } from 'vitest';
import type { Category } from './generated/mam.types.ts';
import { categoryLabel, moveTargets, pickerOptions, visibleRows } from './category-tree.ts';

const at = '2026-10-09T00:00:00.000Z';
const cat = (id: string, path: string, over: Partial<Category> = {}): Category => ({
  id,
  channelId: 'ch12',
  key: path.split('/').filter(Boolean).at(-1)!,
  path,
  depth: path.split('/').filter(Boolean).length,
  labels: { en: id },
  sortOrder: 0,
  mediaAddable: true,
  version: 1,
  createdBy: 'u1',
  createdAt: at,
  updatedAt: at,
  ...over,
});

const TREE = [
  cat('News', '/news/'),
  cat('Sports', '/sports/', { mediaAddable: false }),
  cat('Football', '/sports/football/', {
    parentId: 'Sports',
    labels: { en: 'Football', ar: 'كرة القدم' },
  }),
  cat('Highlights', '/sports/football/highlights/', { parentId: 'Football' }),
  cat('Tennis', '/sports/tennis/', { parentId: 'Sports', sortOrder: -1 }),
];

describe('the category tree', () => {
  it('shows the roots, and the children of what is expanded — sortOrder first, then path', () => {
    expect(visibleRows(TREE, new Set()).map((r) => r.category.id)).toEqual(['News', 'Sports']);
    const open = visibleRows(TREE, new Set(['Sports']));
    expect(open.map((r) => [r.category.id, r.level, r.hasChildren])).toEqual([
      ['News', 0, false],
      ['Sports', 0, true],
      ['Tennis', 1, false],
      ['Football', 1, true],
    ]);
    expect(visibleRows(TREE, new Set(['Sports', 'Football'])).at(-1)?.category.id).toBe(
      'Highlights',
    );
  });

  it('never loses a node whose parent was filtered out — it shows at the root', () => {
    const orphan = [cat('Highlights', '/sports/football/highlights/', { parentId: 'gone' })];
    expect(visibleRows(orphan, new Set()).map((r) => r.category.id)).toEqual(['Highlights']);
  });

  it('labels by locale, falling back to English, then the key', () => {
    expect(categoryLabel(TREE[2]!, 'ar')).toBe('كرة القدم');
    expect(categoryLabel(TREE[0]!, 'ar')).toBe('News');
    expect(categoryLabel({ key: 'bare', labels: {} }, 'en')).toBe('bare');
  });

  it('the picker indents by depth, and a node media cannot go in is shown but not choosable', () => {
    const options = pickerOptions(TREE, 'en');
    expect(options.map((o) => [o.path, o.choosable])).toEqual([
      ['/news/', true],
      ['/sports/', false],
      ['/sports/football/', true],
      ['/sports/football/highlights/', true],
      ['/sports/tennis/', true],
    ]);
    expect(options[3]!.label.startsWith('    ')).toBe(true);
  });

  it('a category may not move under itself, a descendant, or where it already is', () => {
    expect(moveTargets(TREE, TREE[2]!).map((c) => c.id)).toEqual(['News', 'Tennis']);
  });
});
