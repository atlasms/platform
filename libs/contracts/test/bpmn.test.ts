import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boundsOf,
  exportBpmn,
  fromBpmnId,
  importBpmn,
  ImportFailure,
  newModdle,
  positionOf,
  toBpmnId,
} from '../src/bpmn/index.ts';
import { validateDefinition, type WorkflowDefinition } from '../src/workflow/index.ts';

// Lifted from reference/bms-workflow/test/bpmn.test.ts (EP-23.2), positions now included: the
// round trip carries the layout as well as the graph.
const workflows = new URL('../../../docs/architecture/workflows/', import.meta.url);
const load = (name: string): WorkflowDefinition =>
  JSON.parse(readFileSync(new URL(`presets/${name}`, workflows), 'utf8')) as WorkflowDefinition;
const golden = readFileSync(new URL('fixtures/canonical-ingest-to-air.bpmn', workflows), 'utf8');
const PRESETS = [
  'canonical-ingest-to-air.workflow.json',
  'simple-approval.workflow.json',
  're-review-on-expiry.workflow.json',
  'post-approval-distribution.workflow.json',
];
const CH = '01J9ZKQ2M8XABCDEFGHJKMNPQ0';

/** Keys sorted, `undefined` dropped — so two shapes compare by content. */
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) o[k] = canon(x);
    }
    return o;
  }
  return v;
}
/** What the file carries: the graph, its layout and its description — not the record's fields. */
function graph(def: WorkflowDefinition) {
  return canon({
    id: def.id,
    name: def.name,
    description: def.description,
    scope: def.scope,
    vars: [...(def.vars ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    steps: [...def.steps].sort((a, b) => a.id.localeCompare(b.id)),
    transitions: [...def.transitions].sort((a, b) => a.id.localeCompare(b.id)),
  });
}
const errors = (def: WorkflowDefinition) =>
  validateDefinition(def).issues.filter((i) => i.severity === 'error');

test('the golden fixture parses with no warnings, and survives a moddle round trip', async () => {
  const m = newModdle();
  const { rootElement, warnings } = await m.fromXML(golden);
  assert.deepEqual(warnings, []);
  const { xml } = await m.toXML(rootElement, { format: false });
  assert.deepEqual((await m.fromXML(xml)).warnings, []);
});

test('importing the golden fixture reproduces the canonical preset — positions included', async () => {
  const imported = await importBpmn(golden, { channelId: CH });
  assert.deepEqual(errors(imported), []);
  const preset = load('canonical-ingest-to-air.workflow.json');
  const { description: _d, ...withoutDescription } = graph(preset) as Record<string, unknown>;
  assert.deepEqual(graph(imported), withoutDescription); // the fixture carries no documentation
  assert.equal(imported.channelId, CH, 'the channel is the caller’s, never the file’s');
  assert.equal(imported.status, 'draft');
  assert.equal(imported.version, 1);
});

test('export writes standard BPMN with the atlas policy, FEEL conditions and a DI shape per step', async () => {
  const def = load('canonical-ingest-to-air.workflow.json');
  const xml = await exportBpmn(def);
  assert.match(xml, /<atlas:command /);
  assert.match(xml, /language="feel"/);
  const { rootElement, warnings } = await newModdle().fromXML(xml);
  assert.deepEqual(warnings, []);
  const shapes = xml.match(/<bpmndi:BPMNShape /g) ?? [];
  const edges = xml.match(/<bpmndi:BPMNEdge /g) ?? [];
  assert.equal(shapes.length, def.steps.length);
  assert.equal(edges.length, def.transitions.length);
  assert.equal(rootElement.$type, 'bpmn:Definitions');
  // A gateway's default flow is BPMN's own `default`, so a BPMN tool draws the slash on it.
  assert.match(xml, /<bpmn:exclusiveGateway id="s_gate" name="Approved\?" default="t_reject"/);
});

for (const name of PRESETS) {
  test(`lossless round trip DSL → BPMN → DSL: ${name}`, async () => {
    const def = load(name);
    const back = await importBpmn(await exportBpmn(def), { channelId: def.channelId });
    assert.deepEqual(graph(back), graph(def));
    // Not every preset is publishable (post-approval-distribution issues commands the closed list
    // no longer holds) — the import must add no problem the definition did not have.
    assert.deepEqual(errors(back), errors(def));
  });
}

test('what the reference dropped round-trips too: timeouts, error paths, compensation, forms, scope, typed initials', async () => {
  const def: WorkflowDefinition = {
    id: '01JA0000000000000000000000',
    channelId: CH,
    name: 'Everything',
    description: 'Two lines\nof description.',
    scope: { categoryId: '01JA0000000000000000000009', mediaType: 'video' },
    version: 3,
    status: 'published',
    vars: [
      { name: 'title', type: 'string', initial: 'untitled', description: 'shown in the task' },
      { name: 'attempts', type: 'number', initial: 0 },
      { name: 'urgent', type: 'boolean', initial: false },
      { name: 'tags', type: 'array', initial: ['a', 'b'] },
      { name: 'meta', type: 'object', initial: { k: 1 } },
      { name: 'later', type: 'string' },
    ],
    steps: [
      { id: 's_start', kind: 'start', position: { x: 0, y: 0 }, config: {} },
      {
        id: '01JA0000000000000000000001', // a ULID: it starts with a digit, which an NCName cannot
        kind: 'command',
        name: 'Transcode',
        position: { x: 180, y: 0 },
        retry: { maxAttempts: 3, backoff: { type: 'exponential', initial: 'PT10S', factor: 2.5 } },
        timeout: 'PT1H',
        onError: { transitionTo: 's_fail' },
        compensation: 's_undo',
        config: {
          action: 'transcode',
          request: { event: 'transcode.job.create', input: { assetId: '= vars.assetId' } },
          await: { output: { 'vars.rendition': '= incoming.outputs' } },
        },
      },
      {
        id: 's_review',
        kind: 'human-task',
        position: { x: 360, y: 0 },
        timeout: 'P2D',
        onError: 'fail',
        config: {
          taskType: 'approve',
          assignee: { role: 'librarian' },
          form: { fields: [{ name: 'note', type: 'text' }], required: ['note'] },
          escalation: { after: 'P1D', action: 'reassign', to: { role: 'editor' } },
        },
      },
      { id: 's_undo', kind: 'end', position: { x: 540, y: 120 }, config: { status: 'undone' } },
      { id: 's_fail', kind: 'end', position: { x: 540, y: 240 }, config: { terminate: true } },
      { id: 's_end', kind: 'end', position: { x: 540, y: 0 }, config: {} },
    ],
    transitions: [
      { id: 't1', from: 's_start', to: '01JA0000000000000000000001' },
      { id: '01JA0000000000000000000002', from: '01JA0000000000000000000001', to: 's_review' },
      { id: 't3', from: 's_review', to: 's_end', name: 'done' },
    ],
  };
  const xml = await exportBpmn(def);
  assert.match(xml, /id="wf_01JA0000000000000000000001"/);
  assert.doesNotMatch(xml, /id="0/, 'every BPMN id is an NCName');
  assert.deepEqual((await newModdle().fromXML(xml)).warnings, []);
  const back = await importBpmn(xml, { channelId: CH });
  assert.deepEqual(graph(back), graph(def));
});

test('a definition with no positions is laid out — left to right from the start — and imports with them', async () => {
  const def = load('simple-approval.workflow.json');
  const bare: WorkflowDefinition = {
    ...def,
    steps: def.steps.map(({ position: _p, ...s }) => s),
  };
  const back = await importBpmn(await exportBpmn(bare), { channelId: def.channelId });
  const at = new Map(back.steps.map((s) => [s.id, s.position]));
  assert.ok(
    back.steps.every((s) => s.position),
    'every step is placed',
  );
  const start = bare.steps.find((s) => s.kind === 'start')!;
  assert.deepEqual(at.get(start.id), { x: 0, y: 0 });
  for (const t of bare.transitions)
    if (t.from !== t.to && at.get(t.to)!.x <= at.get(t.from)!.x)
      assert.ok(
        bare.transitions.some((u) => u.to === t.to && at.get(u.from)!.x < at.get(t.to)!.x),
        `${t.to} sits to the right of whatever first reaches it`,
      );
  assert.deepEqual(
    graph({ ...back, steps: back.steps.map(({ position: _p, ...s }) => s) }),
    graph(bare),
  );
});

test('positions are left edges on a centre line: every kind on one y lines up', () => {
  const centre = (kind: Parameters<typeof boundsOf>[0]) => {
    const b = boundsOf(kind, { x: 40, y: 100 });
    return b.y + b.height / 2;
  };
  assert.equal(centre('start'), centre('command'));
  assert.equal(centre('command'), centre('branch'));
  for (const kind of ['start', 'command', 'branch', 'sub-flow'] as const)
    assert.deepEqual(positionOf(boundsOf(kind, { x: 40, y: 100 })), { x: 40, y: 100 });
  // A modeler's own sizes are read by their centre too.
  assert.deepEqual(positionOf({ x: 10, y: 0, width: 120, height: 100 }), { x: 10, y: 32 });
});

test('ids: an NCName is written for a ULID, and the mapping is a bijection', () => {
  for (const id of ['s_start', '01JA0000000000000000000001', 'wf_x', 'wf_01J', 'wf_wf_1', '9'])
    assert.equal(fromBpmnId(toBpmnId(id)), id);
  assert.equal(toBpmnId('01J'), 'wf_01J');
  assert.equal(toBpmnId('s_a'), 's_a');
  assert.equal(fromBpmnId('wf_review'), 'wf_review', 'a wf_ the writer did not add is kept');
});

const bpmn = (body: string, extra = '') => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="x" id="d">
  <bpmn:process id="wf_x">${body}</bpmn:process>${extra}
</bpmn:definitions>`;
async function refused(xml: string, code: ImportFailure['code']) {
  try {
    await importBpmn(xml, { channelId: CH });
  } catch (e) {
    assert.ok(e instanceof ImportFailure, String(e));
    assert.equal(e.code, code);
    return e.unsupported;
  }
  assert.fail('the import was accepted');
}

test('outside the subset is REPORTED, element by element — never silently dropped', async () => {
  const listed = await refused(
    bpmn(`
      <bpmn:startEvent id="s"><bpmn:timerEventDefinition/></bpmn:startEvent>
      <bpmn:inclusiveGateway id="ig"/>
      <bpmn:userTask id="u"><bpmn:multiInstanceLoopCharacteristics/></bpmn:userTask>
      <bpmn:boundaryEvent id="b" attachedToRef="u"/>
      <bpmn:intermediateCatchEvent id="c"/>
      <bpmn:laneSet id="ls"><bpmn:lane id="l1"/></bpmn:laneSet>`),
    'UNSUPPORTED_BPMN',
  );
  const got = listed.map((u) => `${u.elementId}:${u.elementType}`).sort();
  assert.deepEqual(got, [
    'b:bpmn:BoundaryEvent',
    'c:bpmn:IntermediateCatchEvent',
    'ig:bpmn:InclusiveGateway',
    'l1:bpmn:Lane',
    's:bpmn:TimerEventDefinition',
    'u:bpmn:MultiInstanceLoopCharacteristics',
  ]);
  assert.ok(
    listed.every((u) => u.elementType),
    'each names what it is',
  );
});

test('a second process or a collaboration of pools is refused; one pool around the process is not', async () => {
  const two = await refused(
    bpmn('<bpmn:startEvent id="s"/>', '<bpmn:process id="p2"/>'),
    'UNSUPPORTED_BPMN',
  );
  assert.deepEqual(
    two.map((u) => u.elementId),
    ['p2'],
  );
  const pools = await refused(
    bpmn(
      '<bpmn:startEvent id="s"/>',
      '<bpmn:collaboration id="co"><bpmn:participant id="a" processRef="wf_x"/><bpmn:participant id="b"/></bpmn:collaboration>',
    ),
    'UNSUPPORTED_BPMN',
  );
  assert.deepEqual(
    pools.map((u) => u.elementId),
    ['co'],
  );
  const pool = await importBpmn(
    bpmn(
      '<bpmn:startEvent id="s"/>',
      '<bpmn:collaboration id="co"><bpmn:participant id="a" processRef="wf_x"/></bpmn:collaboration>',
    ),
    { channelId: CH },
  );
  assert.deepEqual(
    pool.steps.map((s) => s.kind),
    ['start'],
  );
});

test('a file that is not BPMN is MALFORMED_XML, not a crash', async () => {
  await refused('this is not xml', 'MALFORMED_XML');
  await refused('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>', 'MALFORMED_XML');
});

test('a file from another tool: no DI and no gateway direction still imports — a parallel read by its edges', async () => {
  const def = await importBpmn(
    bpmn(`
      <bpmn:startEvent id="s"/>
      <bpmn:parallelGateway id="fork"/>
      <bpmn:serviceTask id="a"/><bpmn:serviceTask id="b"/>
      <bpmn:parallelGateway id="joined"/>
      <bpmn:endEvent id="e"/>
      <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="fork"/>
      <bpmn:sequenceFlow id="f2" sourceRef="fork" targetRef="a"/>
      <bpmn:sequenceFlow id="f3" sourceRef="fork" targetRef="b"/>
      <bpmn:sequenceFlow id="f4" sourceRef="a" targetRef="joined"/>
      <bpmn:sequenceFlow id="f5" sourceRef="b" targetRef="joined"/>
      <bpmn:sequenceFlow id="f6" sourceRef="joined" targetRef="e"/>`),
    { channelId: CH },
  );
  const mode = (id: string) =>
    (def.steps.find((s) => s.id === id)?.config as { mode?: string } | undefined)?.mode;
  assert.equal(mode('fork'), 'split');
  assert.equal(mode('joined'), 'join');
  assert.ok(
    def.steps.every((s) => s.position === undefined),
    'no DI, no invented positions',
  );
  assert.equal(def.name, 'wf_x', 'a process with no name is named by its id');
  // A service task with no atlas:command imports — and the validator says what it lacks.
  assert.ok(errors(def).length > 0);
});
