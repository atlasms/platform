// EP-27.7 — search performance check at a target catalogue size.
//
//   docker compose -f infra/docker-compose.dev.yml up -d
//   ATLAS_PG_URL=postgres://atlas:atlas@localhost:55432/atlas npm run perf:search
//
//   # a smaller ladder for a laptop, or a larger single point for a perf box:
//   ATLAS_SEARCH_SIZES=10000,100000 ATLAS_PG_URL=... npm run perf:search
//
// WHAT THIS ANSWERS. EP-27.2 decided (2026-10-12) that MAM's search STAYS in Postgres — a term
// table and a facet table in the same database as the row, written in the same transaction
// ([mam.md §13](../../../docs/architecture/services/mam.md), search.ts). It moves to an OpenSearch
// projection (shaped like the audit log's hot index, ADR-0005) ONLY if it cannot hold NFR-PERF-2
// (`p95 < 500 ms` for a simple search) as the catalogue grows. This harness is the measurement that
// decision hangs on: it seeds a channel to a ladder of sizes and times the ACTUAL production
// queries at each, so the threshold the product owner sets just picks a point on a measured curve
// rather than a number nobody has run.
//
// FAITHFUL BY CONSTRUCTION. The queries under test are not reimplemented here — the harness calls
// `pgAssetStore(pool).search(...)` and `.facetSearch(...)`, the same code a request reaches, against
// tables built by `mamMigrations` (the same DDL and the same indexes a deployed MAM runs). Only the
// SEEDING is bespoke, and seeding does not affect the thing measured: the query latency after the
// rows and indexes are in place. Terms are built with the production `indexTerms`, and queries are
// parsed with the production `parseQuery`, so a query is tokenized the same way the documents were —
// the property without which a search cannot match at all.
//
// NOT CERTIFICATION. Like perf-sanity (EP-21.4), a number here is the SHAPE on the machine it ran
// on; the absolute figure on a pilot's server differs. What travels is the trend across sizes and
// whether a scenario crosses the budget — a p95 that climbs linearly with the library is the signal
// that would send search to OpenSearch, and a flat one is the evidence it need not move yet.
//
// Standalone, run with tsx. It imports @atlas/mam and @atlas/data-pg and talks to Postgres directly
// (it is not an HTTP smoke test): the point is to isolate the query, not the whole request path,
// which perf-sanity already covers.

import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPool, migrate, withTransaction, type PgPool, type PgClient } from '@atlas/data-pg';
// Own package → relative, the convention the Postgres suites follow (store-pg.test.ts): a package
// cannot declare itself as a dependency, so `@atlas/mam` here would fail graph:check. Cross-package
// imports (`@atlas/data-pg` above) stay on the scope specifier.
import { mamMigrations, pgAssetStore, indexTerms, parseQuery } from '../src/index.ts';

const URL = process.env['ATLAS_PG_URL'];
const SIZES = (process.env['ATLAS_SEARCH_SIZES'] ?? '10000,100000,1000000')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
const ITERATIONS = Number(process.env['ATLAS_SEARCH_ITERATIONS'] ?? 150);
const WARMUP = Number(process.env['ATLAS_SEARCH_WARMUP'] ?? 15);
const PAGE = Number(process.env['ATLAS_SEARCH_PAGE'] ?? 50);
const CHANNEL = 'ch-perf';
// Default into the OS temp dir, not the CWD — a run must never litter (or risk committing to) the
// repository. Point `ATLAS_SEARCH_RESULTS` somewhere durable to keep a record.
const RESULTS =
  process.env['ATLAS_SEARCH_RESULTS'] ?? join(tmpdir(), 'search-scaling-results.jsonl');

/** NFR-PERF-2: a simple search answers at p95 < 500 ms over the baseline library. */
const BUDGET_P95_MS = Number(process.env['ATLAS_SEARCH_BUDGET_MS'] ?? 500);

if (!URL) {
  console.log(
    'ATLAS_PG_URL is unset — skipping the search scaling check.\n' +
      'Bring a Postgres up and point this at it:\n' +
      '  docker compose -f infra/docker-compose.dev.yml up -d\n' +
      '  ATLAS_PG_URL=postgres://atlas:atlas@localhost:55432/atlas npm run perf:search',
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// A deterministic, Zipf-shaped corpus.
//
// Realism that matters for THIS measurement is the frequency distribution of terms, not their
// meaning: the worst case for the term query's `GROUP BY asset_id` is a COMMON word that matches a
// large fraction of the library, and the best case is a rare one that matches a handful. A uniform
// vocabulary would hide both ends. So the pool is drawn Zipf-like — word 0 is in most assets, the
// tail in almost none — which is how a real title/description vocabulary actually sits.
// ---------------------------------------------------------------------------------------------

/** A small, seeded PRNG so a run is reproducible and two sizes see the same shape. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCAB_SIZE = 3000;
/** Base words `w0000`..`w2999`; the index is what carries the frequency, the spelling is just a label. */
const VOCAB = Array.from({ length: VOCAB_SIZE }, (_, i) => `word${i.toString().padStart(4, '0')}`);

/** A precomputed Zipf CDF over the vocabulary, so a draw is one binary search. */
const ZIPF_CDF = (() => {
  const weights = VOCAB.map((_, i) => 1 / (i + 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const cdf: number[] = [];
  let acc = 0;
  for (const w of weights) {
    acc += w / total;
    cdf.push(acc);
  }
  return cdf;
})();

function zipfWord(rng: () => number): string {
  const r = rng();
  let lo = 0;
  let hi = ZIPF_CDF.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((ZIPF_CDF[mid] as number) < r) lo = mid + 1;
    else hi = mid;
  }
  return VOCAB[lo] as string;
}

const GENRES = [
  'drama',
  'news',
  'sport',
  'documentary',
  'comedy',
  'music',
  'kids',
  'current-affairs',
  'factual',
  'entertainment',
  'film',
  'religion',
];
const SUPPLY = ['in-house', 'commissioned', 'acquired', 'archive'];
const GROUPS = Array.from({ length: 25 }, (_, i) => `prod-group-${i.toString().padStart(2, '0')}`);
const CLASS = ['general', 'news', 'restricted', 'embargoed', 'premium', 'promo'];

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length) % arr.length] as T;
}

/** A single escaped SQL string literal — all values are generated, but quote defensively anyway. */
function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------------------------

/** The two search/facet indexes, dropped before a bulk load and rebuilt after — faster, identical end state. */
const SEARCH_INDEXES = [
  `CREATE INDEX IF NOT EXISTS asset_search_term_idx ON asset_search (channel_id, term, asset_id)`,
  `CREATE INDEX IF NOT EXISTS asset_search_prefix_idx ON asset_search (channel_id, term text_pattern_ops)`,
  `CREATE INDEX IF NOT EXISTS asset_facets_value_idx ON asset_facets (channel_id, facet, value, asset_id)`,
];

async function flush(client: PgClient, table: string, cols: string, rows: string[]): Promise<void> {
  if (rows.length === 0) return;
  await client.query(`INSERT INTO ${table} (${cols}) VALUES ${rows.join(',')}`);
  rows.length = 0;
}

async function seed(pool: PgPool, size: number): Promise<{ sampleIds: string[]; seedMs: number }> {
  const started = performance.now();
  // Drop the indexes we will measure against, load, then rebuild them once. Index maintenance per
  // row dominates a bulk load; the final structure is byte-identical to what `migrate` produced.
  for (const name of ['asset_search_term_idx', 'asset_search_prefix_idx', 'asset_facets_value_idx'])
    await pool.query(`DROP INDEX IF EXISTS ${name}`);

  const rng = mulberry32(0x5eed ^ size);
  const BATCH = 2000;
  const sampleIds: string[] = [];

  // One connection for the whole load — BEGIN/COMMIT across pooled `pool.query` calls can land on
  // DIFFERENT connections, so the transaction would not actually wrap the inserts. `withTransaction`
  // pins one client and COMMITs on return.
  await withTransaction(pool, async (client) => {
    const assetRows: string[] = [];
    const searchRows: string[] = [];
    const facetRows: string[] = [];
    for (let i = 0; i < size; i++) {
      const id = `a${i}`;
      if (i % Math.max(1, Math.floor(size / 200)) === 0) sampleIds.push(id);

      // A title of 5 Zipf words plus the asset's own unique token, deduped the production way.
      const titleWords = [
        zipfWord(rng),
        zipfWord(rng),
        zipfWord(rng),
        zipfWord(rng),
        zipfWord(rng),
      ];
      const title = titleWords.join(' ');
      const terms = indexTerms([title, `uid${i}`]);

      const data = JSON.stringify({ id, channelId: CHANNEL, state: 'ready', title, version: 1 });
      assetRows.push(`(${lit(id)},${lit(CHANNEL)},'ready',${lit(data)}::jsonb,now())`);
      for (const t of terms) searchRows.push(`(${lit(id)},${lit(CHANNEL)},${lit(t)})`);

      const facets: Array<[string, string]> = [
        ['genre', pick(rng, GENRES)],
        ['supplyType', pick(rng, SUPPLY)],
        ['productionGroup', pick(rng, GROUPS)],
        ['classification', pick(rng, CLASS)],
      ];
      for (const [f, v] of facets)
        facetRows.push(`(${lit(id)},${lit(CHANNEL)},${lit(f)},${lit(v)})`);

      if (assetRows.length >= BATCH)
        await flush(client, 'assets', 'id,channel_id,state,data,updated_at', assetRows);
      if (searchRows.length >= BATCH)
        await flush(client, 'asset_search', 'asset_id,channel_id,term', searchRows);
      if (facetRows.length >= BATCH)
        await flush(client, 'asset_facets', 'asset_id,channel_id,facet,value', facetRows);
    }
    await flush(client, 'assets', 'id,channel_id,state,data,updated_at', assetRows);
    await flush(client, 'asset_search', 'asset_id,channel_id,term', searchRows);
    await flush(client, 'asset_facets', 'asset_id,channel_id,facet,value', facetRows);
  });

  for (const stmt of SEARCH_INDEXES) await pool.query(stmt);
  // Give the planner accurate statistics — a deployed database gets these from autovacuum over time;
  // a just-loaded one has none, and would misplan the very queries we are timing.
  await pool.query('ANALYZE assets');
  await pool.query('ANALYZE asset_search');
  await pool.query('ANALYZE asset_facets');

  return { sampleIds, seedMs: performance.now() - started };
}

// ---------------------------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] as number;
}

interface Scenario {
  name: string;
  /** Returns the matched-count of the last run, so a scenario that matches nothing is visible. */
  run(rng: () => number): Promise<number>;
}

async function measure(sc: Scenario): Promise<{
  name: string;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  lastHits: number;
}> {
  const rng = mulberry32(0xbeef);
  for (let i = 0; i < WARMUP; i++) await sc.run(rng);
  const samples: number[] = [];
  let lastHits = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    const t = performance.now();
    lastHits = await sc.run(rng);
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  return {
    name: sc.name,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    max: samples[samples.length - 1] as number,
    lastHits,
  };
}

async function runSize(pool: PgPool, size: number): Promise<boolean> {
  const store = pgAssetStore(pool);
  let anyOver = false;
  process.stdout.write(`\nseeding ${size.toLocaleString()} assets…`);
  const { sampleIds, seedMs } = await seed(pool, size);
  process.stdout.write(` ${(seedMs / 1000).toFixed(1)}s\n`);

  // Scenarios chosen to span the query's cost curve: a COMMON word (the GROUP BY's worst case), a
  // RARE word (its best), a two-word AND, a prefix (search-as-you-type on the text_pattern_ops
  // index), and three facet shapes including a `within` that models "narrow a text hit by a facet".
  const scenarios: Scenario[] = [
    {
      name: 'text: common word',
      // VOCAB[0..3] are the most frequent — present in a large fraction of titles.
      run: (rng) =>
        store
          .search(CHANNEL, parseQuery(`${VOCAB[Math.floor(rng() * 4)]} `), PAGE)
          .then((r) => r.length),
    },
    {
      name: 'text: rare word',
      // Deep in the tail — present in very few.
      run: (rng) =>
        store
          .search(CHANNEL, parseQuery(`${VOCAB[2000 + Math.floor(rng() * 999)]} `), PAGE)
          .then((r) => r.length),
    },
    {
      name: 'text: two-word AND',
      run: (rng) =>
        store
          .search(
            CHANNEL,
            parseQuery(`${VOCAB[Math.floor(rng() * 20)]} ${VOCAB[Math.floor(rng() * 200)]} `),
            PAGE,
          )
          .then((r) => r.length),
    },
    {
      name: 'text: prefix (as-you-type)',
      // The first three characters of a frequent word → `wor%`-shaped prefix on the btree.
      run: (rng) =>
        store
          .search(
            CHANNEL,
            parseQuery(`${(VOCAB[Math.floor(rng() * 50)] as string).slice(0, 4)}`),
            PAGE,
          )
          .then((r) => r.length),
    },
    {
      name: 'facet: one',
      run: (rng) =>
        store
          .facetSearch(CHANNEL, [{ facet: 'genre', values: [pick(rng, GENRES)] }], PAGE)
          .then((r) => r.length),
    },
    {
      name: 'facet: two (AND)',
      run: (rng) =>
        store
          .facetSearch(
            CHANNEL,
            [
              { facet: 'genre', values: [pick(rng, GENRES)] },
              { facet: 'supplyType', values: [pick(rng, SUPPLY)] },
            ],
            PAGE,
          )
          .then((r) => r.length),
    },
    {
      name: 'facet: one + within',
      run: (rng) =>
        store
          .facetSearch(
            CHANNEL,
            [{ facet: 'classification', values: [pick(rng, CLASS)] }],
            PAGE,
            sampleIds,
          )
          .then((r) => r.length),
    },
  ];

  const header = `  ${'scenario'.padEnd(28)}${'p50'.padStart(8)}${'p95'.padStart(9)}${'p99'.padStart(9)}${'max'.padStart(9)}  budget  hits`;
  console.log(header);
  console.log('  ' + '─'.repeat(header.length - 2));
  for (const sc of scenarios) {
    const m = await measure(sc);
    const ok = m.p95 < BUDGET_P95_MS;
    if (!ok) anyOver = true;
    const budget = ok ? ' PASS ' : ' OVER ';
    console.log(
      `  ${m.name.padEnd(28)}${m.p50.toFixed(1).padStart(8)}${m.p95.toFixed(1).padStart(9)}${m.p99
        .toFixed(1)
        .padStart(9)}${m.max.toFixed(1).padStart(9)}  ${budget}  ${m.lastHits}`,
    );
    try {
      appendFileSync(
        RESULTS,
        JSON.stringify({
          at: new Date().toISOString(),
          size,
          scenario: m.name,
          p50: Number(m.p50.toFixed(2)),
          p95: Number(m.p95.toFixed(2)),
          p99: Number(m.p99.toFixed(2)),
          max: Number(m.max.toFixed(2)),
          budgetMs: BUDGET_P95_MS,
          pass: ok,
          iterations: ITERATIONS,
        }) + '\n',
      );
    } catch {
      /* results file is a convenience, not the measurement */
    }
  }
  return anyOver;
}

async function main(): Promise<void> {
  const connectionString = URL as string;
  // A dedicated schema named for the run, dropped at the end — never touch an operator's data.
  // `openPool({ schema })` pins search_path on every connection and `migrate` creates the schema.
  const schema = `mam_perf_${createHash('sha1').update(String(Date.now())).digest('hex').slice(0, 8)}`;
  const pool = openPool({ connectionString, schema });

  console.log(`EP-27.7 search scaling — schema ${schema}`);
  console.log(
    `sizes: ${SIZES.map((s) => s.toLocaleString()).join(', ')}  ·  ${ITERATIONS} iters/scenario  ·  budget p95 < ${BUDGET_P95_MS} ms (NFR-PERF-2)`,
  );

  let anyOver = false;
  try {
    await migrate(pool, mamMigrations);
    for (const size of SIZES) {
      // Each size is a fresh corpus in the same tables — truncate between, so a run is independent.
      await pool.query('TRUNCATE assets, asset_search, asset_facets');
      if (await runSize(pool, size)) anyOver = true;
    }
  } finally {
    await pool.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await pool.end();
  }

  console.log(`\nresults appended to ${RESULTS}`);
  if (anyOver) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
