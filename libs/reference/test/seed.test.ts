// EP-06.6 — the seed loader.
//
// The design constraint is one sentence in §6 — "additive and idempotent … never a destructive
// replace" — and almost every test here is about the half that is easy to get wrong. Applying
// defaults to an empty install is the trivial case; NOT applying them over an operator's edit is
// what stops the loader being a factory reset that runs on every boot.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineSettings, mergeRegistries, type SettingRow } from '../src/index.ts';
import { applySeed, planSeed, readSeedDirectory, type SeedEntry } from '../src/seed.ts';

const hsm = defineSettings('hsm', {
  'sweep.cron': { type: 'cron', default: '0 3 * * *', scope: 'deployment' },
  'restore.concurrency': { type: 'int', default: 4, min: 1, max: 64, scope: 'channel' },
  'checksum.algorithm': {
    type: 'oneOf',
    default: 'sha256',
    options: [{ value: 'sha256' }, { value: 'xxh3' }],
    scope: 'deployment',
  },
  'sweep.exclude': { type: 'json', scope: 'deployment' },
});

const registry = mergeRegistries(hsm);

const seed = (over: Partial<SeedEntry> = {}): SeedEntry => ({
  key: 'hsm.sweep.cron',
  value: '0 3 * * *',
  ...over,
});

// --- the happy path, and then the point ------------------------------------

test('a fresh install applies every default', async () => {
  const written: SettingRow[][] = [];
  const result = await applySeed(registry, [seed()], [], (rows) => {
    written.push([...rows]);
  });

  assert.equal(result.applied, 1);
  assert.deepEqual(written, [[{ key: 'sweep.cron', level: 'deployment', value: '0 3 * * *' }]]);
});

test('IDEMPOTENT: the second run writes nothing', async () => {
  const existing: SettingRow[] = [{ key: 'sweep.cron', level: 'deployment', value: '0 3 * * *' }];
  let called = false;
  const result = await applySeed(registry, [seed()], existing, () => {
    called = true;
  });

  assert.equal(result.applied, 0);
  assert.equal(called, false, 'a no-op run must not call the writer at all');
  assert.equal(result.unchanged.length, 1);
});

test('ADDITIVE: an operator’s edit is preserved, not reset', async () => {
  // The single most damaging thing this file could do. The operator changed the sweep window
  // through the admin UI this whole subsystem exists to provide; a loader that "restores defaults"
  // on every boot would undo that at each restart, and the restart is where nobody is looking.
  const existing: SettingRow[] = [{ key: 'sweep.cron', level: 'deployment', value: '0 5 * * *' }];
  let called = false;
  const result = await applySeed(registry, [seed()], existing, () => {
    called = true;
  });

  assert.equal(result.applied, 0);
  assert.equal(called, false);
  assert.deepEqual(result.preserved, [
    { key: 'hsm.sweep.cron', level: 'deployment', seeded: '0 3 * * *', current: '0 5 * * *' },
  ]);
});

test('the same key at a different level is a different row', async () => {
  // A deployment default and a channel override coexist; seeding one must not read as the other
  // already being present, or a fresh channel would never get its value.
  const existing: SettingRow[] = [{ key: 'restore.concurrency', level: 'deployment', value: 8 }];
  const entry = seed({ key: 'hsm.restore.concurrency', level: 'channel', scopeId: 'ch12', value: 16 });

  const plan = planSeed(registry, [entry], existing);
  assert.deepEqual(plan.apply, [
    { key: 'restore.concurrency', level: 'channel', scopeId: 'ch12', value: 16 },
  ]);
});

// --- validation: a seed is a write, and gets the same checks ---------------

test('an unknown key is a problem, and the message says keys are qualified', () => {
  // The likeliest mistake, because a stored row carries the BARE key — so the obvious thing to
  // write in a file is the bare key, and it would silently match nothing.
  const plan = planSeed(registry, [seed({ key: 'sweep.cron' })], []);
  assert.equal(plan.apply.length, 0);
  assert.match(plan.problems[0]?.message ?? '', /unknown setting.*fully qualified/s);
});

test('a value the descriptor refuses is refused here too', () => {
  const plan = planSeed(registry, [seed({ key: 'hsm.restore.concurrency', value: 999 })], []);
  assert.equal(plan.apply.length, 0);
  assert.equal(plan.problems.length, 1);
});

test('a level deeper than the descriptor allows is refused', () => {
  const entry = seed({ key: 'hsm.sweep.cron', level: 'user', scopeId: 'u1' });
  const plan = planSeed(registry, [entry], []);
  assert.match(plan.problems[0]?.message ?? '', /deepest allowed level/);
});

test('a scoped level without a scopeId applies to nothing, so it is refused', () => {
  const plan = planSeed(registry, [seed({ key: 'hsm.restore.concurrency', level: 'channel', value: 8 })], []);
  assert.match(plan.problems[0]?.message ?? '', /needs a scopeId/);
});

test('SECURITY-ADJACENT: an ambiguous bare key is refused rather than written to one of them', () => {
  // A live property of the model, not a hypothetical: `resolveSetting` matches rows on the BARE
  // key, so if two areas declare the same one, a single row satisfies both descriptors. Seeding
  // either would silently set the other. The loader is the first thing to write a row from a
  // qualified name, so it is where this becomes visible — and refusing beats picking.
  const mts = defineSettings('mts', {
    'restore.concurrency': { type: 'int', default: 2, scope: 'channel' },
  });
  const both = mergeRegistries(hsm, mts);

  const entry = seed({ key: 'hsm.restore.concurrency', level: 'channel', scopeId: 'ch12', value: 8 });
  const plan = planSeed(both, [entry], []);

  assert.equal(plan.apply.length, 0);
  assert.match(plan.problems[0]?.message ?? '', /ambiguous.*hsm\.restore\.concurrency and mts\.restore\.concurrency/s);
});

test('NOTHING is written when anything is invalid', async () => {
  // A seed file is reviewed and applied as a unit. A partial apply is the worst outcome available:
  // half the defaults present, no error state to notice, and a rerun reporting "unchanged" for
  // exactly the half that landed.
  let called = false;
  const result = await applySeed(
    registry,
    [seed(), seed({ key: 'hsm.nope', value: 1 })],
    [],
    () => {
      called = true;
    },
  );

  assert.equal(result.applied, 0);
  assert.equal(called, false, 'the valid half must not be written either');
  assert.equal(result.problems.length, 1);
});

// --- structured values ------------------------------------------------------

test('a json value that is deeply equal is unchanged, whatever its key order', () => {
  // Without this every boot would report a conflict for every structured setting, and the loader
  // would spend its life declining to apply values that are already there.
  const existing: SettingRow[] = [
    { key: 'sweep.exclude', level: 'deployment', value: { a: 1, nested: { x: true, y: 2 } } },
  ];
  const entry = seed({ key: 'hsm.sweep.exclude', value: { nested: { y: 2, x: true }, a: 1 } });

  const plan = planSeed(registry, [entry], existing);
  assert.equal(plan.unchanged.length, 1);
  assert.equal(plan.preserved.length, 0);
});

test('a json value that really differs is preserved, not overwritten', () => {
  const existing: SettingRow[] = [
    { key: 'sweep.exclude', level: 'deployment', value: { a: 1 } },
  ];
  const plan = planSeed(registry, [seed({ key: 'hsm.sweep.exclude', value: { a: 2 } })], existing);
  assert.equal(plan.preserved.length, 1);
});

// --- reading files ----------------------------------------------------------

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-seed-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('reads *.json in sorted order and records the source file', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'b.json'), JSON.stringify([{ key: 'hsm.sweep.cron', value: '0 4 * * *' }]));
    await writeFile(
      join(dir, 'a.json'),
      JSON.stringify({ settings: [{ key: 'hsm.checksum.algorithm', value: 'xxh3' }] }),
    );
    await writeFile(join(dir, 'notes.txt'), 'ignored');

    const { entries, problems } = await readSeedDirectory(dir);
    assert.deepEqual(problems, []);
    assert.deepEqual(
      entries.map((e) => [e.source, e.key]),
      [
        ['a.json', 'hsm.checksum.algorithm'],
        ['b.json', 'hsm.sweep.cron'],
      ],
    );
  });
});

test('a missing directory is EMPTY, not an error — seeding is optional', async () => {
  const { entries, problems } = await readSeedDirectory(join(tmpdir(), 'atlas-seed-does-not-exist'));
  assert.deepEqual(entries, []);
  assert.deepEqual(problems, []);
});

test('a malformed file is REPORTED — the opposite of a missing one', async () => {
  // Skipping it silently means an operator's reviewed defaults never arrive and nothing says why.
  await withDir(async (dir) => {
    await writeFile(join(dir, 'broken.json'), '{ not json');
    await writeFile(join(dir, 'wrong-shape.json'), JSON.stringify({ nope: true }));

    const { entries, problems } = await readSeedDirectory(dir);
    assert.equal(entries.length, 0);
    assert.equal(problems.length, 2);
    assert.match(problems[0]?.message ?? '', /not valid JSON/);
    assert.match(problems[1]?.message ?? '', /expected an array/);
  });
});

test('end to end: files on disk, applied once and then not again', async () => {
  await withDir(async (dir) => {
    await writeFile(
      join(dir, 'hsm.json'),
      JSON.stringify([
        { key: 'hsm.sweep.cron', value: '0 3 * * *' },
        { key: 'hsm.restore.concurrency', level: 'channel', scopeId: 'ch12', value: 16 },
      ]),
    );

    const { entries, problems } = await readSeedDirectory(dir);
    assert.deepEqual(problems, []);

    const stored: SettingRow[] = [];
    const first = await applySeed(registry, entries, stored, (rows) => {
      stored.push(...rows);
    });
    assert.equal(first.applied, 2);

    const second = await applySeed(registry, entries, stored, () => {
      assert.fail('the second run must not write');
    });
    assert.equal(second.applied, 0);
    assert.equal(second.unchanged.length, 2);
  });
});
