// The acceptance engine, pure (EP-15.3): the vocabulary, the parser's refusals, scope matching,
// and the verdict — the worst failure decides, the first rule at that severity names the reason,
// an unknown is a quarantine and never a pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from '@atlas/contracts';
import {
  applies,
  evaluate,
  parseRuleSetInput,
  type AcceptanceRuleSet,
  type Facts,
} from '../src/index.ts';

const set = (over: Partial<AcceptanceRuleSet> = {}): AcceptanceRuleSet => ({
  id: ulid(),
  channelId: 'ch12',
  name: 'masters',
  scope: {},
  rules: [],
  enabled: true,
  createdBy: 'u',
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z',
  version: 1,
  ...over,
});
const facts = (over: Partial<Facts> = {}): Facts => ({
  source: 'upload',
  sourceKind: 'upload',
  filename: 'bulletin.mxf',
  sizeBytes: 10_000,
  ...over,
});

test('no applicable set is accepted; a disabled set, a wrong kind and a wrong source do not apply', () => {
  assert.deepEqual(evaluate([], facts()), { outcome: 'accepted' });
  const r = {
    id: ulid(),
    kind: 'minSizeBytes' as const,
    onFail: 'reject' as const,
    bytes: 1 << 30,
  };
  assert.equal(applies(set({ enabled: false, rules: [r] }), facts()), false);
  assert.equal(applies(set({ scope: { sourceKind: 'watch' }, rules: [r] }), facts()), false);
  assert.equal(applies(set({ scope: { sourceId: 'newsroom-drop' }, rules: [r] }), facts()), false);
  assert.equal(applies(set({ scope: { sourceKind: 'upload' } }), facts()), true);
  assert.equal(applies(set({ scope: { sourceId: 'upload' } }), facts()), true);
  assert.equal(
    evaluate(
      [set({ enabled: false, rules: [r] }), set({ scope: { sourceKind: 'ftp' }, rules: [r] })],
      facts(),
    ).outcome,
    'accepted',
  );
});

test('each kind: container by extension (case-insensitive, none is a failure), size bounds inclusive', () => {
  const c = {
    id: ulid(),
    kind: 'container' as const,
    onFail: 'reject' as const,
    containers: ['mxf', 'mov'],
  };
  assert.equal(evaluate([set({ rules: [c] })], facts({ filename: 'A.MXF' })).outcome, 'accepted');
  assert.equal(evaluate([set({ rules: [c] })], facts({ filename: 'a.mp4' })).outcome, 'rejected');
  const bare = evaluate([set({ rules: [c] })], facts({ filename: 'README' }));
  assert.equal(bare.outcome, 'rejected');
  assert.match(bare.reason ?? '', /has no container extension/);
  assert.equal(evaluate([set({ rules: [c] })], facts({ filename: '.hidden' })).outcome, 'rejected');

  const min = {
    id: ulid(),
    kind: 'minSizeBytes' as const,
    onFail: 'quarantine' as const,
    bytes: 10_000,
  };
  const max = {
    id: ulid(),
    kind: 'maxSizeBytes' as const,
    onFail: 'quarantine' as const,
    bytes: 10_000,
  };
  assert.equal(
    evaluate([set({ rules: [min, max] })], facts({ sizeBytes: 10_000 })).outcome,
    'accepted',
  );
  assert.equal(
    evaluate([set({ rules: [min] })], facts({ sizeBytes: 9_999 })).outcome,
    'quarantined',
  );
  assert.equal(
    evaluate([set({ rules: [max] })], facts({ sizeBytes: 10_001 })).outcome,
    'quarantined',
  );
});

test('an aspect-ratio rule is undecidable until the probe: quarantined, not passed, whatever onFail says', () => {
  const r = {
    id: ulid(),
    kind: 'aspectRatio' as const,
    onFail: 'reject' as const,
    aspectRatio: '16:9',
  };
  const unknown = evaluate([set({ rules: [r] })], facts());
  assert.equal(
    unknown.outcome,
    'quarantined',
    'reject is for a decided failure; an unknown is held',
  );
  assert.match(unknown.reason ?? '', /has not been probed/);
  assert.equal(
    evaluate([set({ rules: [r] })], facts({ technicalMetadata: { aspectRatio: '16:9' } })).outcome,
    'accepted',
  );
  assert.equal(
    evaluate([set({ rules: [r] })], facts({ technicalMetadata: { aspectRatio: '4:3' } })).outcome,
    'rejected',
  );
});

test('the worst failure decides, and the FIRST rule at that severity names the reason — sets in id order', () => {
  const q1 = {
    id: ulid(),
    kind: 'minSizeBytes' as const,
    onFail: 'quarantine' as const,
    bytes: 1 << 30,
    label: 'q1',
  };
  const q2 = {
    id: ulid(),
    kind: 'maxSizeBytes' as const,
    onFail: 'quarantine' as const,
    bytes: 1,
    label: 'q2',
  };
  const rj = {
    id: ulid(),
    kind: 'container' as const,
    onFail: 'reject' as const,
    containers: ['mov'],
    label: 'rj',
  };
  const a = set({ id: '01H0000000000000000000000A', rules: [q1] });
  const b = set({ id: '01H0000000000000000000000B', rules: [q2, rj] });
  // Quarantine first, reject later: the reject wins with its own reason.
  const v = evaluate([b, a], facts());
  assert.equal(v.outcome, 'rejected');
  assert.equal(v.ruleId, rj.id);
  assert.equal(v.ruleSetId, b.id);
  // Two quarantines: the first in set order, whatever order the sets came in.
  const only = evaluate([set({ id: b.id, rules: [q2] }), a], facts());
  assert.equal(only.ruleId, q1.id, 'set A sorts before set B');
  assert.match(only.reason ?? '', /\(q1\)$/);
});

test('the parser: names, scope, ids minted or kept, the parameter per kind and nothing else', () => {
  const parsed = parseRuleSetInput({
    name: '  masters ',
    rules: [
      { kind: 'container', onFail: 'reject', containers: [' MXF', 'mov', 'mxf'] },
      { id: '01H0000000000000000000000Z', kind: 'minSizeBytes', onFail: 'quarantine', bytes: 0 },
    ],
  });
  assert.equal(parsed.name, 'masters');
  assert.deepEqual(parsed.scope, {});
  assert.equal(parsed.enabled, true);
  assert.deepEqual(parsed.rules[0]!.containers, ['mxf', 'mov'], 'normalised and de-duplicated');
  assert.equal(parsed.rules[0]!.id.length, 26);
  assert.equal(parsed.rules[1]!.id, '01H0000000000000000000000Z');

  const refuse = (body: unknown, re: RegExp): void => {
    assert.throws(() => parseRuleSetInput(body), re);
  };
  refuse({ rules: [] }, /name/);
  refuse({ name: 'x', rules: 'no' }, /rules must be an array/);
  refuse({ name: 'x', rules: [{ kind: 'codec', onFail: 'reject' }] }, /kind must be one of/);
  refuse(
    { name: 'x', rules: [{ kind: 'container', onFail: 'drop', containers: ['mxf'] }] },
    /onFail/,
  );
  refuse({ name: 'x', rules: [{ kind: 'container', onFail: 'reject' }] }, /containers must list/);
  refuse(
    { name: 'x', rules: [{ kind: 'container', onFail: 'reject', containers: ['.mxf'] }] },
    /extensions/,
  );
  refuse(
    { name: 'x', rules: [{ kind: 'container', onFail: 'reject', containers: ['mxf'], bytes: 1 }] },
    /takes only/,
  );
  refuse({ name: 'x', rules: [{ kind: 'minSizeBytes', onFail: 'reject', bytes: -1 }] }, /bytes/);
  refuse({ name: 'x', rules: [{ kind: 'maxSizeBytes', onFail: 'reject', bytes: 1.5 }] }, /bytes/);
  refuse(
    { name: 'x', rules: [{ kind: 'aspectRatio', onFail: 'reject', aspectRatio: '16x9' }] },
    /W:H/,
  );
  refuse(
    { name: 'x', rules: [{ id: 'nope', kind: 'minSizeBytes', onFail: 'reject', bytes: 1 }] },
    /ULID/,
  );
  const dup = '01H0000000000000000000000Z';
  refuse(
    {
      name: 'x',
      rules: [
        { id: dup, kind: 'minSizeBytes', onFail: 'reject', bytes: 1 },
        { id: dup, kind: 'maxSizeBytes', onFail: 'reject', bytes: 1 },
      ],
    },
    /distinct/,
  );
  refuse({ name: 'x', rules: [], scope: { sourceKind: 'email' } }, /sourceKind/);
  refuse({ name: 'x', rules: [], enabled: 'yes' }, /enabled/);
});
