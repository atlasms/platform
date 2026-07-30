import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  can,
  canEnforce,
  compile,
  permissionMatches,
  pathCovers,
  unionFieldGroups,
  type EffectivePolicy,
  type Rule,
} from '../src/index.ts';
import { cases, policy, SUBJECT } from './decision-table.ts';

// --- EP-05.1 permission matching ------------------------------------------
test('permission wildcards match on either half, and only structurally valid pairs', () => {
  assert.ok(permissionMatches('asset:write', 'asset:write'));
  assert.ok(permissionMatches('asset:*', 'asset:write'));
  assert.ok(permissionMatches('*:read', 'schedule:read'));
  assert.ok(permissionMatches('*:*', 'anything:goes'));

  assert.equal(permissionMatches('asset:read', 'asset:write'), false);
  assert.equal(permissionMatches('schedule:*', 'asset:write'), false);
  // Asking for a wildcard is a different question from holding one.
  assert.equal(permissionMatches('asset:read', 'asset:*'), false);
  // Malformed input never accidentally grants.
  assert.equal(permissionMatches('assetwrite', 'asset:write'), false);
  assert.equal(permissionMatches('a:b:c', 'a:b'), false);
});

// --- EP-05.4 category subtree ---------------------------------------------
test('category paths match as prefixes and cannot cross a segment boundary', () => {
  assert.ok(pathCovers('/sports/football/', '/sports/football/highlights/'));
  assert.ok(pathCovers('/sports/football/', '/sports/football/'));
  assert.ok(pathCovers('/', '/anything/at/all/'));
  // A grant written without its trailing slash still behaves correctly.
  assert.ok(pathCovers('/sports/football', '/sports/football/highlights/'));

  assert.equal(pathCovers('/sports/football/', '/sports/'), false); // parent is not covered
  assert.equal(pathCovers('/news/', '/sports/'), false);
  // The bug this guards: a name-prefix sibling must NOT be covered.
  assert.equal(pathCovers('/sports/football/', '/sports/footballing-legends/'), false);
  assert.equal(pathCovers('/sports/foot', '/sports/football/'), false);
});

// --- EP-05.2 field groups -------------------------------------------------
test('unionFieldGroups returns undefined (= all) if any rule is unrestricted', () => {
  const narrowed: Rule[] = [
    { id: 'a', permissions: ['asset:write'], fieldGroups: ['core'] },
    { id: 'b', permissions: ['asset:write'], fieldGroups: ['rights', 'core'] },
  ];
  assert.deepEqual(unionFieldGroups(narrowed), ['core', 'rights']); // deduped + sorted

  const withUnrestricted: Rule[] = [...narrowed, { id: 'c', permissions: ['asset:write'] }];
  assert.equal(unionFieldGroups(withUnrestricted), undefined);

  // An explicitly empty list means "not narrowed", same as omitting it.
  assert.equal(unionFieldGroups([{ id: 'd', permissions: ['x:y'], fieldGroups: [] }]), undefined);
});

// --- EP-05.5 the shared decision table ------------------------------------
test('decision table: every case matches the normative semantics', () => {
  for (const c of cases) {
    const d = can(policy, c.permission, c.ctx);
    assert.equal(
      d.allowed,
      c.allowed,
      `${c.name}: expected allowed=${c.allowed} (${d.reason ?? ''})`,
    );
    if (c.allowed) {
      assert.deepEqual(d.fieldGroups, c.fieldGroups, `${c.name}: fieldGroups`);
    }
  }
});

// This pins the single most dangerous property of the evaluator. Lenient mode is what the
// design doc specifies for broad questions, but it means an INCOMPLETE context yields a WIDER
// answer. Services must therefore enforce with canEnforce/strict.
test('SECURITY: an incomplete context widens a lenient decision but not a strict one', () => {
  const ctx = { categoryPath: '/news/politics/', ownerId: 'other' }; // channelId omitted

  // Lenient: r-rights is scoped to ch12, but with no channelId supplied it still matches.
  const lenient = can(policy, 'asset:write', ctx);
  assert.equal(lenient.allowed, true, 'lenient mode answers the broad question');
  assert.deepEqual(lenient.fieldGroups, ['rights']);

  // Strict: a declared predicate with nothing to check against cannot be satisfied.
  const strict = can(policy, 'asset:write', ctx, { strict: true });
  assert.equal(strict.allowed, false, 'strict mode refuses on an unsatisfiable predicate');

  // canEnforce is strict by construction — this is what services call.
  assert.equal(canEnforce(policy, 'asset:write', ctx).allowed, false);

  // Supplying the channel makes both agree.
  const full = { ...ctx, channelId: 'ch99' };
  assert.equal(can(policy, 'asset:write', full).allowed, false);
  assert.equal(canEnforce(policy, 'asset:write', full).allowed, false);
});

test('strict mode does not change decisions when the context is complete', () => {
  for (const c of cases.filter((x) => x.ctx && x.ctx.channelId !== undefined)) {
    const lenient = can(policy, c.permission, c.ctx);
    const strict = can(policy, c.permission, c.ctx, { strict: true });
    // Only compare where every predicate the policy declares is supplied.
    if (c.ctx?.categoryPath && c.ctx?.state && c.ctx?.ownerId) {
      assert.equal(strict.allowed, lenient.allowed, `${c.name}: strict must agree`);
    }
  }
});

test('a denial always carries a reason — denials are audited (FR-AUD-1)', () => {
  for (const c of cases.filter((x) => !x.allowed)) {
    const d = can(policy, c.permission, c.ctx);
    assert.ok(d.reason && d.reason.length > 0, `${c.name} must explain itself`);
  }
});

// --- deny extension --------------------------------------------------------
test('deny overrides allow regardless of rule order', () => {
  const allow: Rule = { id: 'a', permissions: ['asset:write'] };
  const deny: Rule = {
    id: 'd',
    effect: 'deny',
    permissions: ['asset:write'],
    scope: { categoryPaths: ['/embargoed/'] },
  };
  const p = (rules: Rule[]): EffectivePolicy => ({ subjectId: SUBJECT, permVersion: 1, rules });

  for (const rules of [
    [allow, deny],
    [deny, allow],
  ]) {
    const d = can(p(rules), 'asset:write', { categoryPath: '/embargoed/x/' });
    assert.equal(d.allowed, false, 'deny must win in either order');
    assert.match(d.reason ?? '', /denied by rule d/);
  }
  // Outside the deny's scope the allow still stands.
  assert.equal(can(p([allow, deny]), 'asset:write', { categoryPath: '/open/' }).allowed, true);
});

// --- EP-05.3 compile -------------------------------------------------------
test('compile unions user + role + group rules and de-duplicates by id', () => {
  const shared: Rule = { id: 'shared', permissions: ['asset:read'] };
  const p = compile({
    subjectId: SUBJECT,
    permVersion: 3,
    rules: [{ id: 'direct', permissions: ['asset:write'] }],
    roles: [{ id: 'editor', rules: [shared] }],
    groups: [
      { id: 'g1', rules: [shared] }, // same rule reached twice
      {
        id: 'g2',
        roles: [{ id: 'approver', rules: [{ id: 'appr', permissions: ['asset:approve'] }] }],
      },
    ],
  });

  assert.equal(p.subjectId, SUBJECT);
  assert.equal(p.permVersion, 3);
  assert.deepEqual(p.rules.map((r) => r.id).sort(), ['appr', 'direct', 'shared']);
  assert.equal(can(p, 'asset:approve').allowed, true);
  assert.equal(can(p, 'user:admin').allowed, false);
});

test('compile of an empty subject grants nothing', () => {
  const p = compile({ subjectId: 'nobody', permVersion: 1 });
  assert.deepEqual(p.rules, []);
  assert.equal(can(p, 'asset:read').allowed, false);
});

test('compile sorts deny rules first for readability, without changing decisions', () => {
  const p = compile({
    subjectId: SUBJECT,
    permVersion: 1,
    rules: [
      { id: 'a1', permissions: ['asset:read'] },
      { id: 'd1', effect: 'deny', permissions: ['asset:read'] },
    ],
  });
  assert.equal(p.rules[0]?.id, 'd1');
  assert.equal(can(p, 'asset:read').allowed, false);
});

// --- EP-05.6 browser safety ------------------------------------------------
test('the library has ZERO runtime dependencies and imports no Node built-ins', () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(pkg.dependencies, undefined, 'policy must stay dependency-free (Studio imports it)');

  const srcDir = join(here, '..', 'src');
  for (const file of readdirSync(srcDir)) {
    const body = readFileSync(join(srcDir, file), 'utf8');
    // Only relative, type-only or same-package imports are allowed.
    for (const m of body.matchAll(/from\s+'([^']+)'/g)) {
      const spec = m[1] ?? '';
      assert.ok(
        spec.startsWith('./') || spec.startsWith('../'),
        `${file} imports "${spec}" — policy must remain browser-safe (no bare or node: imports)`,
      );
    }
  }
});

// --- the grant contract ----------------------------------------------------
test('the starter roles from the design doc behave as documented', () => {
  // Approver = Editor + asset:approve scoped to a category subtree.
  const approver = compile({
    subjectId: SUBJECT,
    permVersion: 1,
    roles: [
      {
        id: 'editor',
        rules: [
          { id: 'e-read', permissions: ['asset:read'] },
          {
            id: 'e-write',
            permissions: ['asset:write'],
            fieldGroups: ['core', 'taxonomy', 'cast', 'shotlist'],
          },
        ],
      },
      {
        id: 'approver',
        rules: [
          {
            id: 'ap',
            permissions: ['asset:approve'],
            scope: { categoryPaths: ['/sports/'] },
          },
        ],
      },
    ],
  });

  assert.equal(can(approver, 'asset:approve', { categoryPath: '/sports/football/' }).allowed, true);
  assert.equal(can(approver, 'asset:approve', { categoryPath: '/news/' }).allowed, false);
  // Editors may not touch rights.
  assert.equal(can(approver, 'asset:write', { fieldGroup: 'rights' }).allowed, false);
  assert.equal(can(approver, 'asset:write', { fieldGroup: 'cast' }).allowed, true);
});
