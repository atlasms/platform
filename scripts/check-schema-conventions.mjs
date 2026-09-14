// Every table is owned by ONE service and carries channel_id — or says, in writing, why not
// (EP-07.6).
//
//   node scripts/check-schema-conventions.mjs
//
// WHY THIS EXISTS. Two rules in AGENTS.md §5 are about tables: "channelId on every row" (rule 3)
// and, from 02-system-architecture.md, "no service reads another service's tables — the engines
// are shared infrastructure, the schemas are owned per service". Both were enforced by review,
// which is to say by whoever remembered. What review did not catch: four services each creating
// `outbox` in the one shared database's `public` schema — one table, four relays, no claim
// locking — until EP-07.6 gave every service its own Postgres schema. And the tables without a
// channel column each had a reason, but the reason lived in a code comment or nowhere.
//
// So the decisions are recorded: docs/architecture/schemas/tables.json lists every table that
// does not carry a NOT NULL channel_id, with the reason. This script reads every CREATE TABLE in
// the services' migrations (the sqlite double AND the Postgres adapter) and holds the code and
// the inventory to each other:
//   1. a table is created by ONE owner — the app that migrates it, or `core` for the tables
//      @atlas/data and @atlas/data-pg give every service (outbox, seen, _migrations);
//   2. the sqlite double and the Postgres adapter of one owner define the SAME tables — the
//      double is the fast path, not a lesser one (AGENTS.md §6), so a table on one side only is
//      a test that cannot see production;
//   3. every table has `channel_id … NOT NULL`, or is inventoried under `nullableChannelId` (the
//      column exists but NULL means platform-wide) or `withoutChannelId` (no column), with why;
//   4. every inventory entry still describes a real table in that state — a stale reason is a
//      decision nobody can find;
//   5. every migration id is prefixed with its owner (`mam_assets`, `core_outbox`): the ids share
//      one `_migrations` ledger per schema, and a bare `assets` from two services would be one
//      applied migration and one silently skipped.
//
// Runs in `verify` and in CI unconditionally, like tier0:check: a migration edit in one adapter
// is exactly the change an affected-only run reasons about least.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const INVENTORY = 'docs/architecture/schemas/tables.json';

/** Where migrations live. `walking-skeleton` is the one-process demo of the spine, not a service. */
const OWNERS = [
  ...readdirSync(join(ROOT, 'apps'))
    .filter((d) => d !== 'walking-skeleton' && d !== 'studio')
    .map((d) => ({ owner: d, dir: join(ROOT, 'apps', d, 'src') }))
    .filter(({ dir }) => exists(dir)),
  { owner: 'core', dir: join(ROOT, 'libs', 'data', 'src'), side: 'sqlite' },
  { owner: 'core', dir: join(ROOT, 'libs', 'data-pg', 'src'), side: 'pg' },
];

const inventory = JSON.parse(readFileSync(join(ROOT, INVENTORY), 'utf8'));
const errors = [];
const fail = (where, message) => errors.push(`${where}: ${message}`);

// --- 1. every CREATE TABLE, with its owner, its side, and its channel column -----------------------

/** table name -> { owner, sides: Set, channel: 'not-null' | 'nullable' | 'none', where } */
const tables = new Map();
/** migration id -> where */
const migrationIds = new Map();

for (const { owner, dir, side } of OWNERS) {
  for (const file of walk(dir)) {
    const source = readFileSync(file, 'utf8');
    const where = relative(ROOT, file).split(sep).join('/');
    // The sqlite double lives in store-sqlite.ts (or in @atlas/data); the Postgres adapter in
    // store-pg.ts (or @atlas/data-pg). Anything else that creates a table is one of the two too —
    // it just has to say which by its name.
    const fileSide = side ?? (/-pg\.ts$|\/pg\//.test(where) ? 'pg' : 'sqlite');

    for (const m of source.matchAll(
      /CREATE TABLE(?: IF NOT EXISTS)?\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(/g,
    )) {
      const name = m[1];
      const body = balanced(source, m.index + m[0].length);
      const column = /\bchannel_id\s+\w+([^,]*)/i.exec(body);
      const channel =
        column === null ? 'none' : /NOT NULL/i.test(column[1]) ? 'not-null' : 'nullable';
      const entry = tables.get(name) ?? { owner, sides: new Set(), channel, where };
      if (entry.owner !== owner) {
        fail(
          where,
          `table "${name}" is created by ${owner} but ${entry.owner} owns it (${entry.where})`,
        );
        continue;
      }
      if (entry.channel !== channel) {
        fail(
          where,
          `table "${name}" declares channel_id as ${channel} here and ${entry.channel} in ${entry.where}`,
        );
      }
      entry.sides.add(fileSide);
      tables.set(name, entry);
    }

    for (const m of source.matchAll(/\bid:\s*'([^']+)',\s*(?:\/\/[^\n]*\n\s*)*up:\s*`/g)) {
      const id = m[1];
      if (!id.startsWith(`${owner}_`)) {
        fail(where, `migration id "${id}" must be prefixed with its owner: "${owner}_…"`);
      }
      const seen = migrationIds.get(id);
      // The two adapters of one owner legitimately carry the same id — same migration, two dialects.
      if (seen !== undefined && seen.owner !== owner) {
        fail(where, `migration id "${id}" is also used by ${seen.owner} (${seen.where})`);
      }
      migrationIds.set(id, { owner, where });
    }
  }
}

// --- 2. both sides, 3. the channel column or a reason, 4. no stale reasons --------------------------

const withoutChannelId = inventory.withoutChannelId ?? {};
const nullableChannelId = inventory.nullableChannelId ?? {};

for (const [name, t] of [...tables].sort(([a], [b]) => a.localeCompare(b))) {
  for (const side of ['sqlite', 'pg']) {
    if (!t.sides.has(side)) fail(t.where, `table "${name}" (${t.owner}) has no ${side} definition`);
  }
  if (t.channel === 'not-null') {
    if (name in withoutChannelId || name in nullableChannelId) {
      fail(INVENTORY, `"${name}" now carries channel_id NOT NULL — remove its exception`);
    }
  } else if (t.channel === 'nullable') {
    if (!(name in nullableChannelId)) {
      fail(
        t.where,
        `table "${name}" (${t.owner}) has a NULLABLE channel_id — say why in ${INVENTORY} under nullableChannelId, or make it NOT NULL`,
      );
    }
    if (name in withoutChannelId)
      fail(
        INVENTORY,
        `"${name}" has a channel_id column; it belongs under nullableChannelId, not withoutChannelId`,
      );
  } else {
    if (!(name in withoutChannelId)) {
      fail(
        t.where,
        `table "${name}" (${t.owner}) has no channel_id — AGENTS.md §5 rule 3; say why in ${INVENTORY} under withoutChannelId, or add the column`,
      );
    }
    if (name in nullableChannelId)
      fail(
        INVENTORY,
        `"${name}" has no channel_id column; it belongs under withoutChannelId, not nullableChannelId`,
      );
  }
}

for (const [section, entries] of [
  ['withoutChannelId', withoutChannelId],
  ['nullableChannelId', nullableChannelId],
]) {
  for (const [name, reason] of Object.entries(entries)) {
    if (!tables.has(name)) fail(INVENTORY, `${section}.${name}: no such table is created anywhere`);
    if (typeof reason !== 'string' || reason.trim().length < 20) {
      fail(INVENTORY, `${section}.${name}: the reason must be a sentence, not "${String(reason)}"`);
    }
  }
}

// --- the verdict -----------------------------------------------------------------------------------

if (errors.length > 0) {
  for (const e of errors) console.error(`  ${e}`);
  console.error(
    `\n${errors.length} schema convention problem(s). See scripts/check-schema-conventions.mjs.`,
  );
  process.exit(1);
}
const owners = new Set([...tables.values()].map((t) => t.owner));
console.log(
  `schema conventions OK: ${tables.size} tables across ${owners.size} owners, ${Object.keys(withoutChannelId).length + Object.keys(nullableChannelId).length} channel_id exceptions each with a reason, ${migrationIds.size} migration ids owner-prefixed`,
);

// --- helpers ---------------------------------------------------------------------------------------

function exists(dir) {
  return existsSync(dir) && statSync(dir).isDirectory();
}

function* walk(dir) {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(ts|mjs|js)$/.test(entry) && !/\.test\./.test(entry)) yield path;
  }
}

/** The text inside the parenthesis that opens at `from` — nested parens (CHECK, DEFAULT) included. */
function balanced(source, from) {
  let depth = 1;
  let i = from;
  while (depth > 0 && i < source.length) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') depth -= 1;
    i += 1;
  }
  return source.slice(from, i - 1);
}
