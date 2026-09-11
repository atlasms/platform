// Proves consumer-fanout CI can see every dependency it needs to (EP-01.3).
//
//   node scripts/check-project-graph.mjs
//
// WHY THIS EXISTS. CI runs `nx affected`, which walks the project graph: change a shared lib and
// every dependent's tests run. That property is the reason a change to `@atlas/messaging` in one
// PR ran eight projects rather than one. It holds ONLY while the graph is complete — and the ways
// it goes incomplete are silent. A relative import that reaches into another package
// (`../../libs/policy/src/index.ts`) compiles, typechecks and passes every test while producing NO
// graph edge, so from then on a change to that package never re-runs this one. An `@atlas/*`
// import that is not declared in package.json can do the same. AGENTS.md has warned about both in
// prose; this makes them a failing check.
//
// It compares three things, per workspace package:
//   1. every relative import resolves INSIDE the package — no `../` that escapes its root;
//   2. every `@atlas/*` specifier is declared in that package's dependencies or devDependencies;
//   3. every `@atlas/*` specifier is an edge in the graph Nx actually computes.
// (3) is the property. (1) and (2) are the two known ways to break it, each reported with the fix.
//
// Test files are scanned too, on purpose: a conformance suite imported from another package is a
// dependency in every sense that matters here — if that package changes, these tests must run.
//
// It runs on every PR unconditionally, ahead of `nx affected`, for the same reason `api:check`
// does: the one edit that breaks fanout is exactly the one an affected-only run would then skip.

import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCOPE = '@atlas/';

// --- workspace packages, from the same globs npm uses -------------------------------------------

const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const packages = [];
for (const glob of rootPkg.workspaces) {
  // Only `<dir>/*` globs are used here; anything fancier should fail loudly rather than be skipped.
  const m = /^([^*]+)\/\*$/.exec(glob);
  if (!m) throw new Error(`unsupported workspace glob "${glob}" — extend this script`);
  const base = join(ROOT, m[1]);
  if (!existsSync(base)) continue;
  for (const entry of readdirSync(base)) {
    const dir = join(base, entry);
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    packages.push({ name: pkg.name, dir, pkg });
  }
}

// --- the graph Nx actually computes ---------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), 'atlas-graph-'));
const graphFile = join(tmp, 'graph.json');
let graph;
try {
  // Nx's own entry point under the current node, resolved the way `import` would, rather than
  // `npx`: that needs a shell on Windows to find `npx.cmd`, and a shell means the arguments are
  // concatenated rather than passed.
  const nxBin = fileURLToPath(import.meta.resolve('nx/bin/nx.js'));
  execFileSync(process.execPath, [nxBin, 'graph', `--file=${graphFile}`], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  graph = JSON.parse(readFileSync(graphFile, 'utf8')).graph;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// --- scan ----------------------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', 'dist', '.angular', '.nx', 'coverage']);
function tsFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) tsFiles(p, out);
    } else if (/\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

// `from '...'` and `import('...')` — both static and dynamic specifiers create edges.
const SPECIFIER = /(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g;

const problems = [];
for (const { name, dir, pkg } of packages) {
  const declared = new Set(
    Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => d.startsWith(SCOPE)),
  );
  const edges = new Set((graph.dependencies[name] ?? []).map((d) => d.target));
  const imported = new Map(); // package name -> first file that imports it

  for (const file of tsFiles(dir)) {
    const src = readFileSync(file, 'utf8');
    for (const [, spec] of src.matchAll(SPECIFIER)) {
      const where = relative(ROOT, file).split(sep).join('/');

      if (spec.startsWith('.')) {
        // (1) A relative import must stay inside this package.
        const target = resolve(dirname(file), spec);
        if (!target.startsWith(dir + sep) && target !== dir) {
          const other = packages.find((p) => target.startsWith(p.dir + sep));
          problems.push(
            `${where}: relative import "${spec}" escapes ${name}` +
              (other ? ` into ${other.name} — import '${other.name}' instead` : ''),
          );
        }
        continue;
      }

      if (!spec.startsWith(SCOPE)) continue;
      // `@atlas/policy/client` -> `@atlas/policy`
      const target = spec.split('/').slice(0, 2).join('/');
      if (target === name) continue;
      if (!imported.has(target)) imported.set(target, where);
    }
  }

  for (const [target, where] of imported) {
    // (2) Declared, so npm links it and Nx's package graph sees it.
    if (!declared.has(target)) {
      problems.push(`${where}: imports ${target} but ${name}/package.json does not declare it`);
    }
    // (3) The property itself.
    if (!edges.has(target)) {
      problems.push(
        `${name} imports ${target} but the Nx graph has no edge — a change to ${target} will not re-run ${name}`,
      );
    }
  }
}

if (problems.length) {
  console.error('Project graph is incomplete — consumer-fanout CI would miss these:\n');
  for (const p of problems) console.error(`  ✖ ${p}`);
  console.error('\nSee AGENTS.md §6, "Cross-package imports must use @atlas/*".');
  process.exit(1);
}

const edgeCount = packages.reduce(
  (n, { name }) =>
    n + (graph.dependencies[name] ?? []).filter((d) => d.target.startsWith(SCOPE)).length,
  0,
);
console.log(
  `project graph OK: ${packages.length} packages, ${edgeCount} @atlas edges, every import accounted for`,
);
