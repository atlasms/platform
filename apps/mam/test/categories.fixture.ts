// A store with the categories the suites file assets under (#260).
//
// Before categories existed, an asset's `categoryId` was an opaque string and MAM passed it to the
// authorizer AS the path — so the suites wrote path-shaped ids ('/news/', '/sports/') to exercise
// category-scoped grants. An asset's category is now validated on write and resolved to its path
// for every check; seeding a category whose id IS its path keeps every one of those tests meaning
// what it meant, against the real resolution.
//
// Written straight into the sqlite double, synchronously, because the harnesses are synchronous —
// the categories' own behaviour (create, move, deprecate) is tested through the service.

import { sqliteAssetStore } from '../src/index.ts';

const SEEDED = [
  '/news/',
  '/sport/',
  '/sports/',
  '/sports/football/',
  '/sports/football/highlights/',
  'cat-1',
  'taxonomy',
];

export function seededStore(): ReturnType<typeof sqliteAssetStore> {
  const store = sqliteAssetStore();
  const insert = store.db.prepare(
    'INSERT INTO categories (id, channel_id, parent_id, path, data) VALUES (?, ?, ?, ?, ?)',
  );
  for (const channelId of ['ch12', 'ch99']) {
    for (const id of SEEDED) {
      const path = id.startsWith('/') ? id : `/${id}/`;
      const key = path.split('/').filter(Boolean).at(-1)!;
      const at = '2026-01-01T00:00:00.000Z';
      // Ids are unique across channels, so the other channel's copy carries a suffix.
      const rowId = channelId === 'ch12' ? id : `${id}@${channelId}`;
      insert.run(
        rowId,
        channelId,
        null,
        path,
        JSON.stringify({
          id: rowId,
          channelId,
          key,
          path,
          depth: path.split('/').filter(Boolean).length,
          labels: { en: key },
          sortOrder: 0,
          mediaAddable: true,
          version: 1,
          createdBy: 'fixture',
          createdAt: at,
          updatedAt: at,
        }),
      );
    }
  }
  return store;
}
