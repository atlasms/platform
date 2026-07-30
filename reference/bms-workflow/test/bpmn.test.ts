import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workflowsDir } from '../src/paths.ts';
import { newModdle, exportBpmn, importBpmn, ImportFailure, validateDefinition } from '../src/index.ts';
import type { WorkflowDefinition } from '../src/index.ts';

const loadPreset = (name: string): WorkflowDefinition =>
  JSON.parse(readFileSync(join(workflowsDir, 'presets', name), 'utf8'));
const golden = readFileSync(join(workflowsDir, 'fixtures', 'canonical-ingest-to-air.bpmn'), 'utf8');

/** Comparable projection: vars/steps/transitions only, positions dropped, keys sorted. */
function canon(v: any): any {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const o: any = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) o[k] = canon(v[k]);
    return o;
  }
  return v;
}
function graph(def: WorkflowDefinition) {
  const steps = [...def.steps].sort((a, b) => a.id.localeCompare(b.id)).map((s) => {
    const { position, ...rest } = s;
    return rest;
  });
  const transitions = [...def.transitions].sort((a, b) => a.id.localeCompare(b.id));
  const vars = [...(def.vars ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  return canon({ vars, steps, transitions });
}

test('golden fixture: bpmn-moddle round-trip is clean', async () => {
  const m = newModdle();
  const { rootElement, warnings } = await m.fromXML(golden);
  assert.equal(warnings.length, 0, JSON.stringify(warnings));
  const { xml } = await m.toXML(rootElement, { format: false });
  const back = await m.fromXML(xml);
  assert.equal(back.warnings.length, 0);
});

test('import(golden BPMN) reproduces the canonical DSL graph', async () => {
  const imported = await importBpmn(golden);
  const res = validateDefinition(imported);
  assert.deepEqual(res.issues.filter((i) => i.severity === 'error'), []);
  assert.deepEqual(graph(imported), graph(loadPreset('canonical-ingest-to-air.workflow.json')));
});

test('export(DSL) produces parseable BPMN with atlas policy', async () => {
  const xml = await exportBpmn(loadPreset('canonical-ingest-to-air.workflow.json'));
  assert.match(xml, /atlas:command/i);
  assert.match(xml, /language="feel"/);
  const { warnings } = await newModdle().fromXML(xml);
  assert.equal(warnings.length, 0, JSON.stringify(warnings));
});

for (const name of ['canonical-ingest-to-air.workflow.json', 'simple-approval.workflow.json', 'post-approval-distribution.workflow.json']) {
  test(`lossless round-trip DSL -> BPMN -> DSL: ${name}`, async () => {
    const def = loadPreset(name);
    const back = await importBpmn(await exportBpmn(def));
    assert.deepEqual(graph(back), graph(def));
  });
}

test('import rejects out-of-subset BPMN with a report', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="x">
  <bpmn:process id="wf_x"><bpmn:inclusiveGateway id="ig"/></bpmn:process>
</bpmn:definitions>`;
  await assert.rejects(importBpmn(xml), (e: any) => {
    assert.ok(e instanceof ImportFailure);
    assert.equal(e.code, 'UNSUPPORTED_BPMN');
    assert.ok(e.unsupported.some((u: any) => u.elementType === 'bpmn:InclusiveGateway'));
    return true;
  });
});
