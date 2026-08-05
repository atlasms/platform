// The sqlite adapter against the shared AssetStore conformance suite.
//
// Its Postgres twin lives in store-pg.test.ts and skips without a database. Both run the SAME
// suite, so a behaviour asserted here is asserted of production too.

import { SqliteOutboxStore } from '@atlas/data';
import { assetStoreConformance } from '../src/store-conformance.ts';
import { sqliteAssetStore } from '../src/index.ts';

assetStoreConformance('sqliteAssetStore', {
  setup: async () => {
    const store = sqliteAssetStore();
    const outbox = new SqliteOutboxStore(store.db);
    return {
      store,
      unsentCount: async () => outbox.unsentCount(),
      cleanup: async () => store.close(),
    };
  },
});
