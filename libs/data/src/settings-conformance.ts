// The behaviour every settings table must have (EP-33.2) — `SqliteSettingsTable` and
// `PgSettingsTable` are both held to it. Exported from `@atlas/data/conformance`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { StaleSetting, type SettingFilter, type StoredSetting } from './settings.ts';

export interface SettingsHarness {
  setup: () => Promise<SettingsFixture>;
}

export interface SettingsFixture {
  /** Run a unit of work; COMMIT on success, ROLLBACK if `fn` throws. */
  transaction: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Write inside `transaction`, through the transaction's handle. */
  put: (row: StoredSetting, ifVersion?: number) => Promise<void>;
  list: (filter: SettingFilter) => Promise<StoredSetting[]>;
  get: (
    area: string,
    key: string,
    level: string,
    scopeId: string,
  ) => Promise<StoredSetting | undefined>;
  cleanup: () => Promise<void>;
}

const AT = '2026-11-27T10:00:00.000Z';

const row = (over: Partial<StoredSetting> = {}): StoredSetting => ({
  area: 'mam',
  key: 'review.rejectedRetention',
  level: 'channel',
  scopeId: 'ch12',
  channelId: 'ch12',
  value: 'P30D',
  set: true,
  version: 1,
  updatedBy: 'u1',
  updatedAt: AT,
  ...over,
});

export function settingsConformance(name: string, harness: SettingsHarness): void {
  async function withFixture(fn: (f: SettingsFixture) => Promise<void>): Promise<void> {
    const fixture = await harness.setup();
    try {
      await fn(fixture);
    } finally {
      await fixture.cleanup();
    }
  }

  test(`[${name}] a first value is inserted and read back whole`, async () => {
    await withFixture(async (f) => {
      assert.deepEqual(await f.list({ area: 'mam', channelId: 'ch12' }), []);
      await f.transaction(() => f.put(row()));
      const got = await f.get('mam', 'review.rejectedRetention', 'channel', 'ch12');
      assert.deepEqual(got, row());
    });
  });

  test(`[${name}] every JSON value type survives the round trip`, async () => {
    await withFixture(async (f) => {
      const values: unknown[] = [42, 1.5, true, false, ['a', 'b'], { nested: { ok: 1 } }, null, ''];
      await f.transaction(async () => {
        for (const [i, value] of values.entries()) await f.put(row({ key: `k${i}`, value }));
      });
      for (const [i, value] of values.entries()) {
        const got = await f.get('mam', `k${i}`, 'channel', 'ch12');
        assert.deepEqual(got?.value, value, `k${i}`);
        assert.equal(got?.set, true);
      }
    });
  });

  test(`[${name}] a first write over an existing row is stale, not an overwrite`, async () => {
    await withFixture(async (f) => {
      await f.transaction(() => f.put(row()));
      await assert.rejects(
        f.transaction(() => f.put(row({ value: 'P1D' }))),
        StaleSetting,
      );
      assert.equal(
        (await f.get('mam', 'review.rejectedRetention', 'channel', 'ch12'))?.value,
        'P30D',
      );
    });
  });

  test(`[${name}] an update is compare-and-set on the version it read`, async () => {
    await withFixture(async (f) => {
      await f.transaction(() => f.put(row()));
      await f.transaction(() => f.put(row({ value: 'P7D', version: 2 }), 1));
      await assert.rejects(
        f.transaction(() => f.put(row({ value: 'P1D', version: 2 }), 1)),
        StaleSetting,
      );
      const got = await f.get('mam', 'review.rejectedRetention', 'channel', 'ch12');
      assert.equal(got?.value, 'P7D');
      assert.equal(got?.version, 2);
    });
  });

  test(`[${name}] a reset keeps the row and its version, without a value`, async () => {
    await withFixture(async (f) => {
      await f.transaction(() => f.put(row()));
      await f.transaction(() => f.put(row({ set: false, value: undefined, version: 2 }), 1));
      const got = await f.get('mam', 'review.rejectedRetention', 'channel', 'ch12');
      assert.equal(got?.set, false);
      assert.equal(got?.value, undefined);
      assert.equal(got?.version, 2);
      // And it can be set again, at the next revision — never back at 1.
      await f.transaction(() => f.put(row({ value: 'P90D', version: 3 }), 2));
      assert.equal(
        (await f.get('mam', 'review.rejectedRetention', 'channel', 'ch12'))?.value,
        'P90D',
      );
    });
  });

  test(`[${name}] a rolled-back unit of work leaves no row`, async () => {
    await withFixture(async (f) => {
      await assert.rejects(
        f.transaction(async () => {
          await f.put(row());
          throw new Error('boom');
        }),
        /boom/,
      );
      assert.equal(await f.get('mam', 'review.rejectedRetention', 'channel', 'ch12'), undefined);
    });
  });

  test(`[${name}] a reader sees the platform's rows, its channel's and its own — nothing else`, async () => {
    await withFixture(async (f) => {
      await f.transaction(async () => {
        await f.put(row({ level: 'deployment', scopeId: '', channelId: null, value: 'P365D' }));
        await f.put(row()); // ch12
        await f.put(row({ scopeId: 'ch99', channelId: 'ch99', value: 'P1D' }));
        await f.put(row({ key: 'ui.density', level: 'user', scopeId: 'u1', value: 'compact' }));
        await f.put(row({ key: 'ui.density', level: 'user', scopeId: 'u2', value: 'roomy' }));
        await f.put(row({ area: 'hsm', key: 'restore.concurrency', value: 4 }));
      });

      const forCh12 = await f.list({ area: 'mam', channelId: 'ch12', userId: 'u1' });
      assert.deepEqual(
        forCh12.map((r) => `${r.key}@${r.level}:${r.scopeId}=${JSON.stringify(r.value)}`),
        [
          'review.rejectedRetention@channel:ch12="P30D"',
          'review.rejectedRetention@deployment:="P365D"',
          'ui.density@user:u1="compact"',
        ],
      );
      const anonymous = await f.list({ area: 'mam', channelId: 'ch12' });
      assert.equal(
        anonymous.some((r) => r.level === 'user'),
        false,
      );
      const forCh99 = await f.list({ area: 'mam', channelId: 'ch99' });
      assert.deepEqual(forCh99.map((r) => `${r.level}:${r.scopeId}`).sort(), [
        'channel:ch99',
        'deployment:',
      ]);
    });
  });

  test(`[${name}] two writers on one version: exactly one commits`, async () => {
    await withFixture(async (f) => {
      await f.transaction(() => f.put(row()));
      const results = await Promise.allSettled([
        f.transaction(() => f.put(row({ value: 'P2D', version: 2 }), 1)),
        f.transaction(() => f.put(row({ value: 'P3D', version: 2 }), 1)),
      ]);
      const won = results.filter((r) => r.status === 'fulfilled').length;
      assert.equal(won, 1, JSON.stringify(results.map((r) => r.status)));
      const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      assert.ok(lost.reason instanceof StaleSetting, String(lost.reason));
      assert.equal((await f.get('mam', 'review.rejectedRetention', 'channel', 'ch12'))?.version, 2);
    });
  });
}
