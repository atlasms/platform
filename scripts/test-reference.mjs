// The frozen prototype still passes against the LIVE schemas (#382).
//
//   npm ci --prefix reference && npm run reference:test
//
// WHY THIS EXISTS. `reference/` is frozen — nobody develops there, packages are lifted out of it —
// but it is not isolated: its validators and its BPMN canvas read the schemas in
// docs/architecture/schemas at run time, the same files the platform does. EP-02.5 consolidated
// "task kind" into one `$def` in common.schema.json, the prototype's property form stopped finding
// the enum, and the README went on saying every test passed. Nothing ran `reference/`, so nothing
// noticed until someone verified an unrelated Dependabot bump by hand. A schema change that breaks
// the prototype is a schema change whose consumers we do not fully know; this makes it say so.
//
// Each package runs on its own, from its own directory, against `reference/node_modules` — the
// prototype predates the workspaces and has its own dependency root.

import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'reference');
if (!existsSync(join(root, 'node_modules'))) {
  console.error('reference/node_modules is missing — run `npm ci --prefix reference` first');
  process.exit(1);
}

const failed = [];
let packages = 0;
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === 'node_modules') continue;
  const dir = join(root, entry.name);
  const testDir = join(dir, 'test');
  if (!existsSync(testDir)) continue;
  const files = readdirSync(testDir)
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => join('test', f));
  if (files.length === 0) continue;
  packages++;
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], {
    cwd: dir,
    stdio: 'inherit',
  });
  if (run.status !== 0) failed.push(entry.name);
}

if (packages === 0) {
  console.error('no reference packages with tests were found — the layout moved?');
  process.exit(1);
}
if (failed.length > 0) {
  console.error(`reference packages failing against the live schemas: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`reference OK: ${packages} packages pass against the live schemas`);
