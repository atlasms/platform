import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defineSettings,
  mergeRegistries,
  validateSetting,
  validateWrite,
  validateAll,
  levelPermitted,
  validateRegistryEntry,
  resolveSetting,
  resolveAll,
  SnapshotClient,
  type SettingRow,
} from '../src/index.ts';

// The example from the design doc (§2.4), used as the fixture throughout.
const hsm = defineSettings('hsm', {
  'sweep.cron': { type: 'cron', default: '0 3 * * *', scope: 'deployment' },
  'sweep.throughputMBps': { type: 'int', default: 200, min: 10, max: 5000, scope: 'deployment' },
  'restore.concurrency': { type: 'int', default: 4, min: 1, max: 64, scope: 'channel' },
  'checksum.algorithm': {
    type: 'oneOf',
    default: 'sha256',
    options: [{ value: 'sha256' }, { value: 'xxh3' }],
    scope: 'deployment',
    restart: true,
  },
  'retention.rejectedDays': { type: 'duration', default: 'P30D', scope: 'channel' },
});

// --- EP-06.1 defineSettings ------------------------------------------------
test('defineSettings stamps key + area and preserves the declaration', () => {
  const d = hsm.descriptors['restore.concurrency'];
  assert.equal(d?.key, 'restore.concurrency');
  assert.equal(d?.area, 'hsm');
  assert.equal(d?.scope, 'channel');
  assert.equal(d?.default, 4);
});

test('defineSettings rejects malformed declarations AT LOAD, not at first use', () => {
  assert.throws(() => defineSettings('HSM', {}), /invalid settings area/);
  assert.throws(
    () => defineSettings('hsm', { 'Bad Key': { type: 'int', scope: 'channel' } }),
    /invalid setting key/,
  );
  assert.throws(
    () => defineSettings('hsm', { a: { type: 'oneOf', scope: 'channel' } }),
    /requires non-empty options/,
  );
  assert.throws(
    () => defineSettings('hsm', { a: { type: 'reference', scope: 'channel' } }),
    /requires refTarget/,
  );
  assert.throws(
    () => defineSettings('hsm', { a: { type: 'int', scope: 'channel', min: 10, max: 1 } }),
    /min 10 exceeds max 1/,
  );
  // A required setting with a default is a contradiction — required could never fail.
  assert.throws(
    () => defineSettings('hsm', { a: { type: 'int', scope: 'channel', required: true, default: 1 } }),
    /must not also declare a default/,
  );
});

test('mergeRegistries rejects a duplicate area.key', () => {
  const a = defineSettings('mam', { x: { type: 'int', scope: 'channel' } });
  const b = defineSettings('mam', { x: { type: 'int', scope: 'channel' } });
  assert.throws(() => mergeRegistries(a, b), /duplicate setting descriptor "mam.x"/);
  assert.equal(mergeRegistries(hsm, a).size, Object.keys(hsm.descriptors).length + 1);
});

// --- EP-06.2 validation ----------------------------------------------------
test('validation enforces the descriptor bounds', () => {
  const conc = hsm.descriptors['restore.concurrency']!;
  assert.equal(validateSetting(conc, 8).valid, true);
  assert.equal(validateSetting(conc, 0).valid, false); // below min
  assert.equal(validateSetting(conc, 65).valid, false); // above max
  assert.equal(validateSetting(conc, 4.5).valid, false); // not an integer
  assert.equal(validateSetting(conc, 'four' as never).valid, false);

  const algo = hsm.descriptors['checksum.algorithm']!;
  assert.equal(validateSetting(algo, 'sha256').valid, true);
  assert.equal(validateSetting(algo, 'md5').valid, false);

  const dur = hsm.descriptors['retention.rejectedDays']!;
  assert.equal(validateSetting(dur, 'P30D').valid, true);
  assert.equal(validateSetting(dur, 'PT12H').valid, true);
  assert.equal(validateSetting(dur, '30 days').valid, false);

  const cron = hsm.descriptors['sweep.cron']!;
  assert.equal(validateSetting(cron, '0 3 * * *').valid, true);
  assert.equal(validateSetting(cron, 'nightly').valid, false);
});

test('a problem names the fully-qualified key so an admin UI can point at the field', () => {
  const r = validateSetting(hsm.descriptors['restore.concurrency']!, 999);
  assert.equal(r.valid, false);
  assert.equal(r.problems[0]?.key, 'hsm.restore.concurrency');
  assert.match(r.problems[0]?.message ?? '', /<= 64/);
});

test('validateAll collects every problem instead of failing on the first', () => {
  const all = mergeRegistries(hsm);
  const r = validateAll(all, {
    'hsm.restore.concurrency': 999,
    'hsm.checksum.algorithm': 'md5',
    'hsm.nope': 1,
  });
  assert.equal(r.valid, false);
  assert.equal(r.problems.length, 3);
  assert.match(r.problems.find((p) => p.key === 'hsm.nope')?.message ?? '', /unknown setting/);
});

// --- scope depth -----------------------------------------------------------
test('a deployment-scoped knob cannot be set at a deeper level', () => {
  const algo = hsm.descriptors['checksum.algorithm']!; // scope: deployment
  assert.equal(levelPermitted(algo, 'deployment'), true);
  assert.equal(levelPermitted(algo, 'channel'), false);

  const r = validateWrite(algo, 'sha256', 'channel');
  assert.equal(r.valid, false);
  assert.match(r.problems[0]?.message ?? '', /deepest allowed level is "deployment"/);

  // A channel-scoped knob may be set at deployment OR channel.
  const conc = hsm.descriptors['restore.concurrency']!;
  assert.equal(validateWrite(conc, 8, 'deployment').valid, true);
  assert.equal(validateWrite(conc, 8, 'channel').valid, true);
  assert.equal(validateWrite(conc, 8, 'user').valid, false);
});

test('writing a deprecated setting is refused and points at its replacement', () => {
  const reg = defineSettings('mam', {
    old: { type: 'int', scope: 'channel', deprecated: true, replacedBy: 'mam.new' },
  });
  const r = validateWrite(reg.descriptors['old']!, 1, 'channel');
  assert.equal(r.valid, false);
  assert.match(r.problems[0]?.message ?? '', /deprecated — use "mam.new"/);
});

// --- EP-06.3 resolution ----------------------------------------------------
test('nearest wins, and the origin comes back with the value', () => {
  const conc = hsm.descriptors['restore.concurrency']!; // scope: channel
  const rows: SettingRow[] = [
    { key: 'restore.concurrency', level: 'deployment', value: 8 },
    { key: 'restore.concurrency', level: 'channel', scopeId: 'ch12', value: 16 },
  ];

  // No context: only the deployment row applies.
  const dep = resolveSetting(conc, rows);
  assert.deepEqual([dep.value, dep.origin, dep.overridable], [8, 'deployment', true]);

  // In ch12 the channel row wins, and nothing nearer may override it.
  const ch = resolveSetting(conc, rows, { channel: 'ch12' });
  assert.deepEqual([ch.value, ch.origin, ch.scopeId, ch.overridable], [16, 'channel', 'ch12', false]);

  // A different channel falls back to deployment.
  assert.equal(resolveSetting(conc, rows, { channel: 'ch99' }).value, 8);

  // No rows at all: the code default, marked as such.
  const def = resolveSetting(conc, []);
  assert.deepEqual([def.value, def.origin], [4, 'default']);
});

test('SECURITY: a row deeper than the descriptor scope is IGNORED, not honoured', () => {
  const algo = hsm.descriptors['checksum.algorithm']!; // scope: deployment
  const rows: SettingRow[] = [
    { key: 'checksum.algorithm', level: 'deployment', value: 'sha256' },
    // A stale/hostile row at a deeper level must not take effect.
    { key: 'checksum.algorithm', level: 'user', scopeId: 'user-1', value: 'xxh3' },
  ];
  const r = resolveSetting(algo, rows, { user: 'user-1' });
  assert.equal(r.value, 'sha256');
  assert.equal(r.origin, 'deployment');
});

test('resolveAll keys by area.key so several areas can share one map', () => {
  const out = resolveAll(Object.values(hsm.descriptors), []);
  assert.equal(out['hsm.sweep.cron']?.value, '0 3 * * *');
  assert.equal(out['hsm.restore.concurrency']?.origin, 'default');
});

// --- EP-06.5 the Tier-1 guard ---------------------------------------------
test('SECURITY: a registry entry with a kind the code does not declare is refused', () => {
  const known = ['video', 'audio', 'photo', 'live-event'];

  assert.equal(
    validateRegistryEntry(
      { id: '1', registry: 'media-type', kind: 'video', key: 'promo' },
      known,
    ).valid,
    true,
  );

  const r = validateRegistryEntry(
    { id: '2', registry: 'media-type', kind: 'hologram', key: 'holo' },
    known,
  );
  assert.equal(r.valid, false, 'an admin must not be able to invent a kind nothing can handle');
  assert.match(r.problems[0]?.message ?? '', /unknown kind "hologram"/);
  assert.match(r.problems[0]?.message ?? '', /needs a release, not an admin edit/);
});

// --- EP-06.4 snapshot client ----------------------------------------------
function fakeFetch(responses: Array<{ status: number; body?: unknown; etag?: string }>) {
  let i = 0;
  const calls: Array<Record<string, string>> = [];
  const impl = (async (_url: string, init?: { headers?: Record<string, string> }) => {
    calls.push(init?.headers ?? {});
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      statusText: String(r.status),
      headers: { get: (h: string) => (h === 'ETag' ? (r.etag ?? null) : null) },
      json: async () => r.body,
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('snapshot client caches, then revalidates with If-None-Match', async () => {
  const { impl, calls } = fakeFetch([
    { status: 200, body: { configVersion: 1, vocabularies: { classification: [{ id: 'a', key: 'news' }] } }, etag: 'W/"v1"' },
    { status: 304 },
  ]);
  const c = new SnapshotClient({ url: '/reference', fetchImpl: impl });

  assert.equal(await c.refresh(), true); // first load changed
  assert.equal(c.configVersion, 1);
  assert.equal(calls[0]?.['If-None-Match'], undefined);

  assert.equal(await c.refresh(), false); // 304
  assert.equal(calls[1]?.['If-None-Match'], 'W/"v1"');
  assert.equal(c.configVersion, 1, 'a 304 must not clear the cache');
});

test('validation against the snapshot is an in-memory lookup', async () => {
  const { impl } = fakeFetch([
    {
      status: 200,
      body: {
        configVersion: 2,
        vocabularies: {
          classification: [
            { id: 'a', key: 'news' },
            { id: 'b', key: 'retired', deprecatedAt: '2026-01-01T00:00:00Z' },
          ],
        },
      },
    },
  ]);
  const c = new SnapshotClient({ url: '/reference', fetchImpl: impl });
  await c.refresh();

  assert.equal(c.hasVocabularyTerm('classification', 'news'), true);
  assert.equal(c.hasVocabularyTerm('classification', 'retired'), false, 'deprecated terms fail');
  assert.equal(c.hasVocabularyTerm('classification', 'nope'), false);
  assert.equal(c.hasVocabularyTerm('missing-vocab', 'news'), false);
});

test('config.changed only refetches for a NEWER version — no thundering herd', async () => {
  let fetches = 0;
  const impl = (async () => {
    fetches++;
    return {
      status: 200,
      ok: true,
      statusText: 'OK',
      headers: { get: () => null },
      json: async () => ({ configVersion: 5 }),
    };
  }) as unknown as typeof fetch;

  const c = new SnapshotClient({ url: '/reference', fetchImpl: impl });
  await c.refresh();
  assert.equal(fetches, 1);

  assert.equal(await c.onConfigChanged({ configVersion: 5 }), false, 'same version: no refetch');
  assert.equal(await c.onConfigChanged({ configVersion: 3 }), false, 'older version: no refetch');
  assert.equal(fetches, 1);

  await c.onConfigChanged({ configVersion: 6 });
  assert.equal(fetches, 2, 'newer version does refetch');
});

test('a failed refresh keeps the previous snapshot — stale config still runs (FR-PLat-7)', async () => {
  const { impl } = fakeFetch([
    { status: 200, body: { configVersion: 1 } },
    { status: 503 },
  ]);
  const c = new SnapshotClient({ url: '/reference', fetchImpl: impl });
  await c.refresh();

  await assert.rejects(c.refresh(), /503/);
  assert.equal(c.configVersion, 1, 'the cached snapshot must survive a failed refresh');
});

// --- browser safety --------------------------------------------------------
test('the library has ZERO runtime dependencies and imports no Node built-ins', () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(pkg.dependencies, undefined, 'reference must stay dependency-free (Studio imports it)');

  for (const file of readdirSync(join(here, '..', 'src'))) {
    const body = readFileSync(join(here, '..', 'src', file), 'utf8');
    for (const m of body.matchAll(/from\s+'([^']+)'/g)) {
      const spec = m[1] ?? '';
      assert.ok(
        spec.startsWith('./') || spec.startsWith('../'),
        `${file} imports "${spec}" — reference must remain browser-safe`,
      );
    }
  }
});
