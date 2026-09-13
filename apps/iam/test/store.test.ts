// The sqlite double, held to the same suite as Postgres (store-pg.test.ts).

import { iamStoreConformance, sqliteIamStore } from '../src/index.ts';

iamStoreConformance('sqliteIamStore', {
  make: async () => ({ store: sqliteIamStore() }),
  tamper: async (store, eventId) => {
    (store as ReturnType<typeof sqliteIamStore>).db
      .prepare("UPDATE login_events SET result = 'success' WHERE id = ?")
      .run(eventId);
  },
});
