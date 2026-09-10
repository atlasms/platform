// EP-05.5 + EP-05.6 — the same decision in both targets, and a size budget for the one that ships.
//
// `@atlas/policy` exists so there is ONE authorization evaluator: services enforce with it, Studio
// renders with it, and "a second implementation would be the bug" is the package description. That
// claim is only worth what it can be checked against — and until now nothing checked it, because
// every test imported the TypeScript source under Node. The browser half was asserted by a
// directory scan for `node:` imports, which is a proxy for the property rather than the property.
//
// So: bundle the evaluator the way a browser would receive it, run it in a context with NO Node
// globals at all, and put the same table of decisions through both. If the two ever disagree, the
// second implementation the description warns about has appeared — inside the bundler.

import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSync } from 'esbuild';
import { can, canEnforce } from '../src/index.ts';
import type { Decision } from '../src/index.ts';
import { cases, policy } from './decision-table.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/**
 * The evaluator as a browser receives it: bundled, minified, no externals.
 *
 * IIFE rather than ESM so it can be evaluated in a bare `vm` context — an ESM bundle needs a module
 * loader, and providing one would mean providing exactly the host machinery this test is trying to
 * prove is unnecessary.
 */
function browserBundle(): string {
  const result = buildSync({
    entryPoints: [`${here}../src/index.ts`],
    bundle: true,
    minify: true,
    format: 'iife',
    globalName: 'AtlasPolicy',
    platform: 'browser',
    target: 'es2022',
    write: false,
  });
  const out = result.outputFiles[0];
  assert.ok(out, 'esbuild produced no output');
  return out.text;
}

/**
 * The whole answer, normalised into THIS realm and compared field by field.
 *
 * The JSON round-trip is not decoration. A value returned by the bundle was constructed inside the
 * `vm` context, so its array carries THAT realm's `Array.prototype` — and `deepStrictEqual` compares
 * prototypes, so two objects that print identically fail the assertion. The first run of this test
 * did exactly that: `actual` and `expected` both read `{ allowed: true, fieldGroups: ['core',
 * 'taxonomy'] }` and it still failed. Round-tripping through JSON rebuilds both sides here, which
 * is lossless for a `Decision` (booleans, strings, arrays of strings) and compares the values
 * rather than the realm they were born in.
 *
 * `fieldGroups` is included deliberately rather than just `allowed`: it is a deduped, SORTED array
 * built at runtime, and array construction and sort order are exactly what a bundler transform or
 * a downlevelling target could disturb while leaving the boolean intact. `reason` names rule ids,
 * which is what would drift if `compile()` ever reordered rules.
 */
const shape = (d: Decision): unknown =>
  JSON.parse(
    JSON.stringify({
      allowed: d.allowed,
      ...(d.reason === undefined ? {} : { reason: d.reason }),
      ...(d.fieldGroups === undefined ? {} : { fieldGroups: d.fieldGroups }),
    }),
  );

test('EP-05.5: Node and the browser bundle reach IDENTICAL decisions', () => {
  const bundle = browserBundle();

  // A context with NOTHING in it. No `process`, no `require`, no `Buffer`, no `globalThis.fs` — so
  // anything the evaluator reached for would throw here rather than quietly working because Node
  // happened to provide it. That is the half a directory scan for `node:` imports cannot check:
  // a bare `process.env` reference has no import to find.
  const sandbox: Record<string, unknown> = {};
  createContext(sandbox);
  runInContext(bundle, sandbox);

  const api = sandbox['AtlasPolicy'] as { can: typeof can; canEnforce: typeof canEnforce };
  assert.equal(typeof api?.can, 'function', 'the bundle did not expose can()');
  assert.equal(typeof api?.canEnforce, 'function', 'the bundle did not expose canEnforce()');

  for (const c of cases) {
    // `canEnforce` REQUIRES a context — that is the point of it, and the type says so. An absent
    // one is `{}`, which `match.ts` already treats identically to `undefined`, so both targets and
    // both modes are handed exactly the same argument.
    const ctx = c.ctx ?? {};
    for (const strict of [false, true]) {
      const node = strict ? canEnforce(policy, c.permission, ctx) : can(policy, c.permission, ctx);
      const browser = strict
        ? api.canEnforce(policy, c.permission, ctx)
        : api.can(policy, c.permission, ctx);

      assert.deepEqual(
        shape(browser),
        shape(node),
        `"${c.name}" (${strict ? 'canEnforce' : 'can'}) differs between targets`,
      );
    }
  }
});

test('EP-05.5: the shared table has teeth in both directions', () => {
  // A cross-target test that only ever compares `allowed: false` would pass against an evaluator
  // that always refuses, in both targets, identically. This pins that the fixture proves something.
  const decisions = cases.map((c) => can(policy, c.permission, c.ctx ?? {}).allowed);
  assert.ok(decisions.includes(true), 'no case is allowed — the table proves nothing');
  assert.ok(decisions.includes(false), 'no case is refused — the table proves nothing');

  // And that lenient and strict genuinely disagree somewhere, which is the most important
  // behaviour in this library and the one AGENTS.md warns about by name.
  const diverges = cases.some((c) => {
    const ctx = c.ctx ?? {};
    return can(policy, c.permission, ctx).allowed !== canEnforce(policy, c.permission, ctx).allowed;
  });
  assert.ok(diverges, 'no case distinguishes can() from canEnforce()');
});

test('EP-05.6: the browser bundle stays inside its size budget', () => {
  const bundle = browserBundle();
  const raw = Buffer.byteLength(bundle, 'utf8');
  const gzipped = gzipSync(Buffer.from(bundle, 'utf8')).byteLength;

  // Studio ships this to every browser on every load, and a shared library grows by accident — one
  // convenience import at a time, each individually defensible. Today it is ~1.1 kB gzipped; the
  // budget is a little over double that. Loose enough that ordinary work on the evaluator never
  // trips it, tight enough that pulling in a date library or a validator does immediately.
  // Raising it should be a decision someone makes on purpose, in the commit that needs it.
  const BUDGET_GZIP = 2_560;
  assert.ok(
    gzipped <= BUDGET_GZIP,
    `browser bundle is ${gzipped}B gzipped (${raw}B raw), over the ${BUDGET_GZIP}B budget — ` +
      'if this is a deliberate addition, raise the budget in the same commit and say why',
  );
});

test('EP-05.6: the bundle contains no Node built-in reference at all', () => {
  // Belt and braces with the vm test above, and it catches the case that one cannot: a `node:`
  // specifier that esbuild resolved to a browser shim would run fine in the sandbox while still
  // meaning the source reached for a Node API.
  const bundle = browserBundle();
  for (const forbidden of ['node:', 'require(', 'process.env', '__dirname', 'Buffer.from']) {
    assert.ok(
      !bundle.includes(forbidden),
      `the browser bundle contains "${forbidden}" — policy must not reach for a Node API`,
    );
  }
});
