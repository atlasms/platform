// The behaviour suite every AssetStore must pass.
//
// MAM's whole safety argument rests on two things being true of the store: a channel cannot read
// another channel's catalogue, and an asset never persists without the event announcing it. Both
// are properties of the ADAPTER, so asserting them once against sqlite proves nothing about the
// Postgres deployment — this suite is run against both.
//
// Test-support entry point: `@atlas/mam/store-conformance`.

import test from 'node:test';
import assert from 'node:assert/strict';
import type { Asset } from './asset.ts';
import type { AssetStore } from './store.ts';

export interface StoreHarness {
  /** A clean, empty store. */
  setup: () => Promise<StoreFixture>;
}

export interface StoreFixture {
  store: AssetStore;
  /** Rows sitting in the outbox, unsent. Proves the event committed — or didn't. */
  unsentCount: () => Promise<number>;
  cleanup: () => Promise<void>;
}

let seq = 0;

function asset(overrides: Partial<Asset> = {}): Asset {
  const id = `A${(seq++).toString().padStart(24, '0')}`;
  return {
    id,
    channelId: 'ch12',
    title: 'Clip',
    mediaType: 'video',
    fileType: 'mxf',
    state: 'created',
    version: 1,
    hasRenditions: false,
    createdBy: 'user-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const event = (id: string, channelId = 'ch12') => ({
  id,
  message: {
    id,
    subject: `atlas.${channelId}.asset.created`,
    body: { assetId: id, nested: { ok: true } },
  },
});

export function assetStoreConformance(name: string, harness: StoreHarness): void {
  async function withFixture(fn: (f: StoreFixture) => Promise<void>): Promise<void> {
    const fixture = await harness.setup();
    try {
      await fn(fixture);
    } finally {
      await fixture.cleanup();
    }
  }

  test(`${name}: an asset round-trips unchanged`, async () => {
    await withFixture(async ({ store }) => {
      const a = asset({
        description: 'notes',
        episodeNo: 3,
        expiresAt: '2027-01-01T00:00:00.000Z',
      });
      await store.transaction(async (tx) => tx.put(a));

      assert.deepEqual(await store.get(a.id), a);
    });
  });

  test(`${name}: absent optional fields stay absent, never null`, async () => {
    // `exactOptionalPropertyTypes` is on: `{ description: null }` is not the same value as `{}`,
    // and a store that resurrects dropped keys as null makes every optional field a lie.
    await withFixture(async ({ store }) => {
      const a = asset();
      await store.transaction(async (tx) => tx.put(a));

      const read = (await store.get(a.id)) as Asset;
      assert.equal('description' in read, false);
      assert.equal('expiresAt' in read, false);
    });
  });

  test(`${name}: put is an upsert, not an insert`, async () => {
    await withFixture(async ({ store }) => {
      const a = asset();
      await store.transaction(async (tx) => tx.put(a));
      await store.transaction(async (tx) => tx.put({ ...a, title: 'Renamed', version: 2 }));

      assert.equal((await store.get(a.id))?.title, 'Renamed');
      assert.equal(
        (await store.listByChannel('ch12')).length,
        1,
        'must not have duplicated the row',
      );
    });
  });

  test(`${name}: an unknown id reads as undefined`, async () => {
    await withFixture(async ({ store }) => {
      assert.equal(await store.get('nope'), undefined);
    });
  });

  test(`${name}: listByChannel is a tenant boundary`, async () => {
    await withFixture(async ({ store }) => {
      const mine = asset({ channelId: 'ch12' });
      const theirs = asset({ channelId: 'ch99' });
      await store.transaction(async (tx) => {
        await tx.put(mine);
        await tx.put(theirs);
      });

      const listed = await store.listByChannel('ch12');
      assert.deepEqual(
        listed.map((a) => a.id),
        [mine.id],
      );
      assert.equal((await store.listByChannel('ch404')).length, 0);
    });
  });

  test(`${name}: a commit persists the asset AND its event`, async () => {
    await withFixture(async ({ store, unsentCount }) => {
      const a = asset();
      await store.transaction(async (tx) => {
        await tx.put(a);
        await tx.enqueue(event(a.id));
      });

      assert.ok(await store.get(a.id));
      assert.equal(await unsentCount(), 1);
    });
  });

  test(`${name}: DANGER — a rollback drops BOTH, never one`, async () => {
    // This is the outbox's entire reason for existing. An adapter that commits the row and loses
    // the event leaves the rest of the platform permanently unaware the asset exists; one that
    // commits the event and loses the row has every consumer react to something that never
    // happened. Either way the failure is silent, and shows up as drift days later.
    await withFixture(async ({ store, unsentCount }) => {
      const a = asset();

      await assert.rejects(
        store.transaction(async (tx) => {
          await tx.put(a);
          await tx.enqueue(event(a.id));
          throw new Error('boom');
        }),
        /boom/,
      );

      assert.equal(await store.get(a.id), undefined, 'the asset must not have committed');
      assert.equal(await unsentCount(), 0, 'the event must not have committed');
    });
  });

  test(`${name}: a failed transaction leaves the store usable`, async () => {
    // A driver that forgets to ROLLBACK leaves the connection in a failed transaction, and every
    // later query dies with "current transaction is aborted". The first symptom is the SECOND
    // request, which makes it easy to blame the wrong code.
    await withFixture(async ({ store }) => {
      await assert.rejects(
        store.transaction(async () => {
          throw new Error('boom');
        }),
      );

      const a = asset();
      await store.transaction(async (tx) => tx.put(a));
      assert.ok(await store.get(a.id));
    });
  });
}
