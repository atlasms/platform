import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workflowsDir } from '../src/paths.ts';
import { validateDefinition } from '../src/index.ts';
import type { WorkflowDefinition } from '../src/index.ts';

const load = (name: string): WorkflowDefinition =>
  JSON.parse(readFileSync(join(workflowsDir, 'presets', name), 'utf8'));

const PRESETS = ['canonical-ingest-to-air.workflow.json', 'simple-approval.workflow.json', 'post-approval-distribution.workflow.json'];

for (const name of PRESETS) {
  test(`preset validates clean: ${name}`, () => {
    const res = validateDefinition(load(name));
    const errors = res.issues.filter((i) => i.severity === 'error');
    assert.deepEqual(errors, [], `errors: ${JSON.stringify(errors)}`);
    assert.equal(res.valid, true);
  });
}

test('catches a broken transition target', () => {
  const def = load('canonical-ingest-to-air.workflow.json');
  def.transitions[0].to = 'does_not_exist';
  const res = validateDefinition(def);
  assert.equal(res.valid, false);
  assert.ok(res.issues.some((i) => i.code === 'BAD_TO'));
});

test('catches a FEEL parse error', () => {
  const def = load('canonical-ingest-to-air.workflow.json');
  def.transitions.find((t) => t.id === 't_ok')!.when = '= vars.verdict = ('; // unbalanced
  const res = validateDefinition(def);
  assert.equal(res.valid, false);
  const feel = res.issues.find((i) => i.code === 'FEEL_PARSE');
  assert.ok(feel, 'expected FEEL_PARSE');
  assert.equal(feel!.transitionId, 't_ok');
});

test('catches a branch with no default and all-conditional edges', () => {
  const def = load('canonical-ingest-to-air.workflow.json');
  const gate = def.steps.find((s) => s.id === 's_gate')!;
  (gate.config as any).default = undefined;
  const rej = def.transitions.find((t) => t.id === 't_reject')!;
  rej.isDefault = undefined;
  rej.when = '= vars.verdict = "rejected"';
  const res = validateDefinition(def);
  assert.ok(res.issues.some((i) => i.code === 'BRANCH_NO_DEFAULT'));
});

test('warns on an undeclared var reference', () => {
  const def = load('simple-approval.workflow.json');
  def.transitions.find((t) => t.id === 't_yes')!.when = '= vars.notDeclared = 1';
  const res = validateDefinition(def);
  assert.ok(res.issues.some((i) => i.code === 'UNBOUND_VAR' && i.severity === 'warning'));
});
