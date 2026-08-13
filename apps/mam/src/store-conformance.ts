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

  // --- the extensible document (EP-17.2) -------------------------------------

  test(`${name}: the config version is MONOTONIC and moves when the vocabulary does`, async () => {
    // EP-04.8. Both stores keep this counter themselves, so both have to be held to it: a store
    // that never bumps serves a snapshot every holder revalidates to 304 forever, and validation
    // then rejects a tag somebody just created. A content hash would pass a "does it change?" test
    // and fail this one, which is the point of asserting the ORDER.
    await withFixture(async ({ store }) => {
      const start = await store.configVersion();
      assert.ok(Number.isInteger(start) && start >= 1, `expected an integer version, got ${start}`);

      const versions: number[] = [];
      for (const label of ['alpha', 'beta', 'alpha']) {
        await store.transaction(async (tx) => {
          await tx.setTags('asset-cv', 'ch12', [{ id: `tag-${label}`, label, normalized: label }]);
        });
        versions.push(await store.configVersion());
      }

      assert.ok(versions[0]! > start, 'the first tag write did not move the version');
      for (let i = 1; i < versions.length; i += 1) {
        assert.ok(
          versions[i]! > versions[i - 1]!,
          `not monotonic: ${start}, ${versions.join(', ')} — re-adding an earlier tag must not reuse a version`,
        );
      }
    });
  });

  test(`${name}: an extended document round-trips, and upserts`, async () => {
    await withFixture(async ({ store }) => {
      const a = asset();
      await store.transaction(async (tx) => {
        await tx.put(a);
        await tx.putExtended(a.id, a.channelId, { genre: 'drama', rating: 4.5, live: false });
      });

      assert.deepEqual(await store.extended(a.id), { genre: 'drama', rating: 4.5, live: false });

      await store.transaction(async (tx) => tx.putExtended(a.id, a.channelId, { genre: 'news' }));
      assert.deepEqual(
        await store.extended(a.id),
        { genre: 'news' },
        'putExtended replaces the document; it must not merge',
      );
    });
  });

  test(`${name}: an asset with no extended document reads as undefined`, async () => {
    // Distinct from an empty one. "Never filled in" and "filled in then cleared" are different
    // facts, and only one of them means the operator has looked at it.
    await withFixture(async ({ store }) => {
      const a = asset();
      await store.transaction(async (tx) => tx.put(a));
      assert.equal(await store.extended(a.id), undefined);
    });
  });

  test(`${name}: extended values keep their JSON types`, async () => {
    // A number that comes back as a string passes every `if (value)` check and fails every
    // comparison. Both stores serialize to a document column, so this is worth pinning.
    await withFixture(async ({ store }) => {
      const a = asset();
      const values = { n: 42, f: 1.5, b: true, s: 'x', nested: { deep: [1, 'two'] } };
      await store.transaction(async (tx) => {
        await tx.put(a);
        await tx.putExtended(a.id, a.channelId, values);
      });
      assert.deepEqual(await store.extended(a.id), values);
    });
  });

  test(`${name}: field schemas are per channel, and categoryPath stays ABSENT when unset`, async () => {
    // `categoryPath: null` is not the same value as absent, and absent is what "applies
    // channel-wide" means — a null would make the schema match nothing at all.
    await withFixture(async ({ store }) => {
      await store.transaction(async (tx) => {
        await tx.putSchema({
          id: 'wide',
          channelId: 'ch12',
          mediaType: 'video',
          fields: [{ name: 'genre', label: 'Genre', type: 'string' }],
        });
        await tx.putSchema({
          id: 'narrow',
          channelId: 'ch12',
          mediaType: 'video',
          categoryPath: '/sports/',
          fields: [{ name: 'competition', label: 'Competition', type: 'string' }],
        });
        await tx.putSchema({
          id: 'other-tenant',
          channelId: 'ch99',
          mediaType: 'video',
          fields: [{ name: 'secret', label: 'Secret', type: 'string' }],
        });
      });

      const mine = await store.schemas('ch12');
      assert.deepEqual(
        mine.map((s) => s.id),
        ['narrow', 'wide'],
      );
      const wide = mine.find((s) => s.id === 'wide');
      assert.equal('categoryPath' in (wide ?? {}), false, 'must be absent, not null');
      assert.equal(mine.find((s) => s.id === 'narrow')?.categoryPath, '/sports/');
      assert.deepEqual(wide?.fields, [{ name: 'genre', label: 'Genre', type: 'string' }]);
    });
  });

  test(`${name}: DANGER — a rollback drops the extended document too`, async () => {
    await withFixture(async ({ store, unsentCount }) => {
      const a = asset();
      await store.transaction(async (tx) => tx.put(a));

      await assert.rejects(
        store.transaction(async (tx) => {
          await tx.putExtended(a.id, a.channelId, { genre: 'drama' });
          await tx.enqueue(event(a.id));
          throw new Error('boom');
        }),
        /boom/,
      );

      assert.equal(await store.extended(a.id), undefined, 'the document must not have committed');
      assert.equal(await unsentCount(), 0, 'the event must not have committed');
    });
  });

  // --- free-form tags (EP-17.3) ----------------------------------------------

  test(`${name}: tags round-trip, ordered by normalized label`, async () => {
    await withFixture(async ({ store }) => {
      const a = asset();
      await store.transaction(async (tx) => {
        await tx.put(a);
        await tx.setTags(a.id, a.channelId, [
          { id: 'T1', label: 'Zebra', normalized: 'zebra' },
          { id: 'T2', label: 'Apple', normalized: 'apple' },
        ]);
      });

      const tags = await store.tagsOf(a.id);
      assert.deepEqual(
        tags.map((t) => t.label),
        ['Apple', 'Zebra'],
        'a store that returns insertion order makes the set order-dependent',
      );
      assert.deepEqual(
        tags.map((t) => t.channelId),
        ['ch12', 'ch12'],
      );
    });
  });

  test(`${name}: a candidate whose label exists REUSES the existing id`, async () => {
    // The point of the whole mint-or-reuse dance. If a second asset minted its own row for
    // `football`, one keyword would be two tags, the unique index would eventually reject one of
    // them, and a facet count would be wrong long before anybody noticed.
    await withFixture(async ({ store }) => {
      const first = asset();
      const second = asset();
      await store.transaction(async (tx) => {
        await tx.put(first);
        await tx.put(second);
        await tx.setTags(first.id, 'ch12', [
          { id: 'T1', label: 'Football', normalized: 'football' },
        ]);
      });

      const resolved = await store.transaction(async (tx) =>
        // A DIFFERENT candidate id for the same normalized label.
        tx.setTags(second.id, 'ch12', [
          { id: 'T-OTHER', label: 'football', normalized: 'football' },
        ]),
      );

      assert.equal(resolved[0]?.id, 'T1', 'must return the id the tag already had');
      assert.equal(
        resolved[0]?.label,
        'Football',
        'the FIRST spelling wins — a later one must not rewrite the display label',
      );
      assert.equal((await store.listTags('ch12')).length, 1, 'must not have minted a second row');
    });
  });

  test(`${name}: setTags REPLACES the set, it does not merge`, async () => {
    await withFixture(async ({ store }) => {
      const a = asset();
      await store.transaction(async (tx) => {
        await tx.put(a);
        await tx.setTags(a.id, a.channelId, [
          { id: 'T1', label: 'one', normalized: 'one' },
          { id: 'T2', label: 'two', normalized: 'two' },
        ]);
      });

      await store.transaction(async (tx) =>
        tx.setTags(a.id, a.channelId, [{ id: 'T3', label: 'three', normalized: 'three' }]),
      );
      assert.deepEqual(
        (await store.tagsOf(a.id)).map((t) => t.label),
        ['three'],
      );

      // Clearing is expressible, and is not the same as never having tagged.
      await store.transaction(async (tx) => tx.setTags(a.id, a.channelId, []));
      assert.deepEqual(await store.tagsOf(a.id), []);
    });
  });

  test(`${name}: untagging leaves the tag in the channel's vocabulary`, async () => {
    // Deliberate. The tag cloud is the channel's keyword list, not a reference count — deleting a
    // term the moment its last asset drops it would erase an operator's vocabulary as a side effect
    // of an edit, and would race with anyone typing it at that instant.
    await withFixture(async ({ store }) => {
      const a = asset();
      await store.transaction(async (tx) => {
        await tx.put(a);
        await tx.setTags(a.id, a.channelId, [{ id: 'T1', label: 'rare', normalized: 'rare' }]);
      });
      await store.transaction(async (tx) => tx.setTags(a.id, a.channelId, []));

      assert.deepEqual(
        (await store.listTags('ch12')).map((t) => t.label),
        ['rare'],
      );
    });
  });

  test(`${name}: listTags is a tenant boundary`, async () => {
    // One channel's keywords must not surface in another's autocomplete, and the same label in two
    // channels is two independent tags.
    await withFixture(async ({ store }) => {
      const mine = asset({ channelId: 'ch12' });
      const theirs = asset({ channelId: 'ch99' });
      await store.transaction(async (tx) => {
        await tx.put(mine);
        await tx.put(theirs);
        await tx.setTags(mine.id, 'ch12', [{ id: 'T1', label: 'shared', normalized: 'shared' }]);
        await tx.setTags(theirs.id, 'ch99', [{ id: 'T2', label: 'shared', normalized: 'shared' }]);
      });

      assert.deepEqual(
        (await store.listTags('ch12')).map((t) => t.id),
        ['T1'],
      );
      assert.deepEqual(
        (await store.listTags('ch99')).map((t) => t.id),
        ['T2'],
      );
      assert.equal((await store.listTags('ch404')).length, 0);
    });
  });

  test(`${name}: DANGER — a rollback drops the tags too`, async () => {
    await withFixture(async ({ store, unsentCount }) => {
      const a = asset();
      await store.transaction(async (tx) => tx.put(a));

      await assert.rejects(
        store.transaction(async (tx) => {
          await tx.setTags(a.id, a.channelId, [{ id: 'T1', label: 'x', normalized: 'x' }]);
          await tx.enqueue(event(a.id));
          throw new Error('boom');
        }),
        /boom/,
      );

      assert.deepEqual(await store.tagsOf(a.id), [], 'the join must not have committed');
      assert.deepEqual(await store.listTags('ch12'), [], 'the minted tag must not have committed');
      assert.equal(await unsentCount(), 0, 'the event must not have committed');
    });
  });

  test(`${name}: an untagged asset reads as an empty list`, async () => {
    await withFixture(async ({ store }) => {
      const a = asset();
      await store.transaction(async (tx) => tx.put(a));
      assert.deepEqual(await store.tagsOf(a.id), []);
    });
  });

  // --- the search index (EP-17.4) --------------------------------------------

  test(`${name}: search matches every term, not any of them`, async () => {
    // OR semantics would return the whole library for any two-word query, which is not what typing
    // two words means. This is the single behaviour most likely to differ between two hand-written
    // SQL statements — the sqlite adapter counts a range, Postgres counts a FILTER — so it is
    // asserted rather than assumed.
    await withFixture(async ({ store }) => {
      const both = asset();
      const one = asset();
      await store.transaction(async (tx) => {
        await tx.put(both);
        await tx.put(one);
        await tx.indexTerms(both.id, 'ch12', ['match', 'highlights']);
        await tx.indexTerms(one.id, 'ch12', ['match']);
      });

      const hits = await store.search('ch12', { exact: ['match', 'highlights'] }, 10);
      assert.deepEqual(
        hits.map((h) => h.assetId),
        [both.id],
        'an asset carrying only one of the two terms must not match',
      );
      assert.equal((await store.search('ch12', { exact: ['match'] }, 10)).length, 2);
    });
  });

  test(`${name}: the last term matches as a PREFIX`, async () => {
    await withFixture(async ({ store }) => {
      const a = asset();
      await store.transaction(async (tx) => {
        await tx.put(a);
        await tx.indexTerms(a.id, 'ch12', ['football']);
      });

      assert.equal((await store.search('ch12', { exact: [], prefix: 'foot' }, 10)).length, 1);
      assert.equal((await store.search('ch12', { exact: [], prefix: 'football' }, 10)).length, 1);
      assert.equal((await store.search('ch12', { exact: [], prefix: 'foots' }, 10)).length, 0);
      // A completed word is NOT a prefix: `foot` as an exact term must not find `football`.
      assert.equal((await store.search('ch12', { exact: ['foot'] }, 10)).length, 0);
    });
  });

  test(`${name}: a prefix range does not run off the end of the alphabet`, async () => {
    // The bound is the last code point incremented. A term that sorts immediately after the prefix
    // range is the case a naive `prefix + high-sentinel` gets wrong.
    await withFixture(async ({ store }) => {
      const inside = asset();
      const outside = asset();
      await store.transaction(async (tx) => {
        await tx.put(inside);
        await tx.put(outside);
        await tx.indexTerms(inside.id, 'ch12', ['abz']);
        await tx.indexTerms(outside.id, 'ch12', ['ac']);
      });

      const hits = await store.search('ch12', { exact: [], prefix: 'ab' }, 10);
      assert.deepEqual(
        hits.map((h) => h.assetId),
        [inside.id],
      );
    });
  });

  test(`${name}: score counts matched terms, and ordering is deterministic`, async () => {
    await withFixture(async ({ store }) => {
      const strong = asset();
      const weak = asset();
      await store.transaction(async (tx) => {
        await tx.put(strong);
        await tx.put(weak);
        await tx.indexTerms(strong.id, 'ch12', ['cup', 'final', 'goal']);
        await tx.indexTerms(weak.id, 'ch12', ['cup']);
      });

      const hits = await store.search('ch12', { exact: ['cup'] }, 10);
      // Both match one term, so the tiebreak is what is being pinned: newest id first, and the
      // same order every time. An unordered result makes a paginated UI duplicate and drop rows.
      assert.equal(hits.length, 2);
      assert.deepEqual(
        hits.map((h) => h.score),
        [1, 1],
      );
      assert.deepEqual(
        hits.map((h) => h.assetId),
        [strong.id, weak.id].sort().reverse(),
      );
    });
  });

  test(`${name}: search is a tenant boundary`, async () => {
    await withFixture(async ({ store }) => {
      const mine = asset({ channelId: 'ch12' });
      const theirs = asset({ channelId: 'ch99' });
      await store.transaction(async (tx) => {
        await tx.put(mine);
        await tx.put(theirs);
        await tx.indexTerms(mine.id, 'ch12', ['secret']);
        await tx.indexTerms(theirs.id, 'ch99', ['secret']);
      });

      assert.deepEqual(
        (await store.search('ch12', { exact: ['secret'] }, 10)).map((h) => h.assetId),
        [mine.id],
      );
      assert.equal((await store.search('ch404', { exact: ['secret'] }, 10)).length, 0);
    });
  });

  test(`${name}: indexTerms REPLACES, so a renamed asset stops matching its old title`, async () => {
    // The failure this guards against is the quiet one: an asset that keeps answering to a word
    // nobody can see on it any more.
    await withFixture(async ({ store }) => {
      const a = asset();
      await store.transaction(async (tx) => {
        await tx.put(a);
        await tx.indexTerms(a.id, 'ch12', ['original']);
      });
      await store.transaction(async (tx) => tx.indexTerms(a.id, 'ch12', ['renamed']));

      assert.equal((await store.search('ch12', { exact: ['original'] }, 10)).length, 0);
      assert.equal((await store.search('ch12', { exact: ['renamed'] }, 10)).length, 1);

      await store.transaction(async (tx) => tx.indexTerms(a.id, 'ch12', []));
      assert.equal((await store.search('ch12', { exact: ['renamed'] }, 10)).length, 0);
    });
  });

  test(`${name}: an empty query matches nothing rather than everything`, async () => {
    await withFixture(async ({ store }) => {
      const a = asset();
      await store.transaction(async (tx) => {
        await tx.put(a);
        await tx.indexTerms(a.id, 'ch12', ['anything']);
      });
      assert.deepEqual(await store.search('ch12', { exact: [] }, 10), []);
    });
  });

  test(`${name}: search honours its limit`, async () => {
    await withFixture(async ({ store }) => {
      await store.transaction(async (tx) => {
        for (let i = 0; i < 5; i++) {
          const a = asset();
          await tx.put(a);
          await tx.indexTerms(a.id, 'ch12', ['common']);
        }
      });
      assert.equal((await store.search('ch12', { exact: ['common'] }, 3)).length, 3);
    });
  });

  test(`${name}: DANGER — a rollback drops the index entries too`, async () => {
    await withFixture(async ({ store }) => {
      const a = asset();
      await store.transaction(async (tx) => tx.put(a));

      await assert.rejects(
        store.transaction(async (tx) => {
          await tx.indexTerms(a.id, 'ch12', ['ghost']);
          throw new Error('boom');
        }),
        /boom/,
      );

      assert.equal((await store.search('ch12', { exact: ['ghost'] }, 10)).length, 0);
    });
  });

  // --- keyset pagination (#233) ----------------------------------------------

  test(`${name}: listByChannel pages by KEYSET, and the pages tile exactly`, async () => {
    // Every asset exactly once, in order, across page boundaries. An off-by-one in the cursor
    // comparison (`>=` instead of `>`) duplicates a row per page, which a reader sees as the
    // catalogue repeating itself rather than as an error.
    await withFixture(async ({ store }) => {
      const ids: string[] = [];
      await store.transaction(async (tx) => {
        for (let i = 0; i < 7; i++) {
          const a = asset();
          ids.push(a.id);
          await tx.put(a);
        }
      });
      ids.sort();

      const seen: string[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await store.listByChannel('ch12', {
          limit: 3,
          ...(cursor === undefined ? {} : { after: cursor }),
        });
        if (page.length === 0) break;
        seen.push(...page.map((a) => a.id));
        cursor = page[page.length - 1]?.id;
        if (page.length < 3) break;
      }

      assert.deepEqual(seen, ids, 'must tile the channel exactly: no gaps, no repeats');
    });
  });

  test(`${name}: a cursor is EXCLUSIVE`, async () => {
    await withFixture(async ({ store }) => {
      const first = asset();
      const second = asset();
      const [lo, hi] = [first.id, second.id].sort() as [string, string];
      await store.transaction(async (tx) => {
        await tx.put(first);
        await tx.put(second);
      });

      const after = await store.listByChannel('ch12', { after: lo });
      assert.deepEqual(
        after.map((a) => a.id),
        [hi],
        'the cursor row itself must not come back — that is how a page repeats its last item',
      );
      assert.deepEqual(await store.listByChannel('ch12', { after: hi }), []);
    });
  });

  test(`${name}: pagination stays inside the tenant boundary`, async () => {
    // A cursor from another channel must not become a way to walk into it.
    await withFixture(async ({ store }) => {
      const mine = asset({ channelId: 'ch12' });
      const theirs = asset({ channelId: 'ch99' });
      await store.transaction(async (tx) => {
        await tx.put(mine);
        await tx.put(theirs);
      });

      const page = await store.listByChannel('ch12', { limit: 10 });
      assert.deepEqual(
        page.map((a) => a.id),
        [mine.id],
      );
    });
  });

  test(`${name}: an omitted limit returns the whole channel`, async () => {
    // The unbounded form is what internal walks use. It has to keep working, and it has to be the
    // caller's explicit choice rather than a default a request path can fall into.
    await withFixture(async ({ store }) => {
      await store.transaction(async (tx) => {
        for (let i = 0; i < 4; i++) await tx.put(asset());
      });
      assert.equal((await store.listByChannel('ch12')).length, 4);
      assert.equal((await store.listByChannel('ch12', { limit: 2 })).length, 2);
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
