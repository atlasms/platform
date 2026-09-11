// Every enum in the contracts is a Tier-0 decision, and this proves each one was made (EP-02.5).
//
//   node scripts/check-tier0-enums.mjs
//
// WHY THIS EXISTS. configuration-and-reference-data.md §2 sorts every list in the platform into
// four tiers, and the sorting rule is one question: does CODE BRANCH ON THE VALUE? Yes → a contract
// enum, frozen in the schema (Tier 0). No → it is data an operator manages: a registry entry (Tier
// 1) or a vocabulary term (Tier 2), and it must NOT be a schema enum, because an enum there takes
// the list away from the operator and hands it to a release. The failure mode runs both ways — an
// admin adding `mediaType = "hologram"` that no code handles, or a cast role that cannot be added
// without a deploy — and neither one is visible in a schema review, because an `enum` keyword
// looks the same whichever tier it should be.
//
// So the decision is recorded: docs/architecture/schemas/tier0-enums.json lists every enum by
// JSON pointer with the reason code branches on it. This script holds the schemas and that
// inventory to each other:
//   1. every `enum` in every schema is in the inventory — a new one is either behaviour (add it,
//      with the reason) or a list an operator should own (remove the enum; see §2);
//   2. every inventory entry still exists — a stale reason is a decision nobody can find;
//   3. no value set is defined twice — a Tier-0 enum has ONE definition, a $def in
//      common.schema.json. Three copies of "task kind" had two value sets before this check.
//
// Runs in `verify` and in CI unconditionally, like graph:check: a schema edit is exactly the
// change an affected-only run reasons about least.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = join(ROOT, 'docs/architecture/schemas');
const INVENTORY = 'tier0-enums.json';
const GUIDE = 'docs/architecture/configuration-and-reference-data.md §2';

const read = (rel) => JSON.parse(readFileSync(join(DIR, rel), 'utf8'));

const files = [
  ...readdirSync(DIR).filter((f) => f.endsWith('.schema.json')),
  ...readdirSync(join(DIR, 'events'))
    .filter((f) => f.endsWith('.payload.schema.json'))
    .map((f) => `events/${f}`),
].sort();

// --- every enum, by "file#pointer" -----------------------------------------------------------------

const found = new Map(); // key -> values
function walk(node, pointer, file) {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, `${pointer}/${i}`, file));
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.enum)) found.set(`${file}#${pointer}`, node.enum);
  for (const [key, value] of Object.entries(node)) {
    // `examples` are sample values, not schema; an enum inside one is not a contract.
    if (key === 'enum' || key === 'examples') continue;
    walk(value, `${pointer}/${key}`, file);
  }
}
for (const file of files) walk(read(file), '', file);

// --- the inventory ---------------------------------------------------------------------------------

const inventory = read(INVENTORY);
delete inventory.$comment;

const problems = [];

// (1) present in the schemas, absent from the inventory
for (const [key, values] of found) {
  if (typeof inventory[key] === 'string' && inventory[key].trim()) continue;
  problems.push(
    `${key}\n      enum: ${values.join(' | ')}\n` +
      `      Not in ${INVENTORY}. If code branches on it, add it there with the reason. If it is a list an\n` +
      `      operator should manage, it is Tier 1 or 2: remove the enum and see ${GUIDE}.`,
  );
}

// (2) present in the inventory, absent from the schemas
for (const key of Object.keys(inventory)) {
  if (found.has(key)) continue;
  problems.push(
    `${key}\n      In ${INVENTORY} but there is no enum there any more — remove the stale entry.`,
  );
}

// (3) the same value set defined twice
const bySet = new Map();
for (const [key, values] of found) {
  const set = JSON.stringify([...values].map(String).sort());
  if (!bySet.has(set)) bySet.set(set, []);
  bySet.get(set).push(key);
}
for (const [set, keys] of bySet) {
  if (keys.length < 2) continue;
  problems.push(
    `the same enum is defined ${keys.length} times: ${JSON.parse(set).join(' | ')}\n` +
      keys.map((k) => `      ${k}`).join('\n') +
      `\n      A Tier-0 enum has ONE definition. Move it to common.schema.json#/$defs and $ref it from each site.`,
  );
}

if (problems.length) {
  console.error(`Tier-0 enum inventory disagrees with the schemas:\n`);
  for (const p of problems) console.error(`  ✖ ${p}\n`);
  process.exit(1);
}

console.log(
  `tier-0 enums OK: ${found.size} enums across ${files.length} schemas, every one inventoried with a reason, none defined twice`,
);
