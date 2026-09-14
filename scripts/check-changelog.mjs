// A change to the contract surface names itself in the changelog (EP-02.6).
//
//   node scripts/check-changelog.mjs --base origin/main
//
// WHY THIS EXISTS. `@atlas/contracts` is the one package every service and Studio depend on, and
// its surface is wider than its exports: the JSON Schemas in docs/architecture/schemas are loaded
// at runtime by its validators, so a renamed payload field breaks a consumer exactly as a renamed
// export does. `permissionVersion` → `permVersion` was such a change, and nothing recorded it
// anywhere a consumer would look. Semantic versioning is only a discipline if the diff that moves
// the version is written down where the version is — so a pull request that touches the surface
// must touch libs/contracts/CHANGELOG.md too. What to write, and what bumps what, is at the top
// of that file.
//
// Runs in CI on pull requests only: it needs a base to diff against. Not in `verify`.

import { execFileSync } from 'node:child_process';

const base = process.argv[process.argv.indexOf('--base') + 1];
if (!base || base === '--base') {
  console.error('usage: node scripts/check-changelog.mjs --base <ref>');
  process.exit(2);
}

const CHANGELOG = 'libs/contracts/CHANGELOG.md';

/** What counts as the contract surface. Generated output is excluded: it changes with the schemas. */
const SURFACE = [
  /^libs\/contracts\/src\/(?!generated\/).+\.ts$/,
  /^docs\/architecture\/schemas\/.+\.schema\.json$/,
];

const changed = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f !== '');

const surface = changed.filter((f) => SURFACE.some((re) => re.test(f)));
if (surface.length === 0) {
  console.log('contract surface untouched; no changelog entry needed');
  process.exit(0);
}
if (changed.includes(CHANGELOG)) {
  console.log(`contract surface changed (${surface.length} file(s)) and ${CHANGELOG} with it`);
  process.exit(0);
}

console.error(
  `These files are the contract surface of @atlas/contracts and changed in this branch:`,
);
for (const f of surface) console.error(`  ${f}`);
console.error(
  `\nbut ${CHANGELOG} did not. Add the change under [Unreleased] — Breaking / Added / Changed / Fixed —\n` +
    'so the version that ships it can say what it carries. See the top of that file.',
);
process.exit(1);
