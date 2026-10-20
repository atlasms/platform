import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_TYPES, payloadShape } from '../src/index.ts';
import {
  commandAnswers,
  correlationKeys,
  feelProblem,
  REVIEW_VERDICTS,
  WORKFLOW_EVENTS,
  WORKFLOW_TRIGGERS,
  palette,
  validateDefinition,
  WORKFLOW_COMMANDS,
  type CommandConfig,
  type BranchConfig,
  type HumanTaskConfig,
  type StartConfig,
  type WaitEventConfig,
  type WorkflowDefinition,
} from '../src/workflow/index.ts';

// The presets in docs/ are the single source — the same files the reference implementation and
// the BPMN golden fixture were proven against.
const presets = new URL('../../../docs/architecture/workflows/presets/', import.meta.url);
const load = (name: string): WorkflowDefinition =>
  JSON.parse(readFileSync(new URL(name, presets), 'utf8')) as WorkflowDefinition;
const PRESETS = [
  'canonical-ingest-to-air.workflow.json',
  'simple-approval.workflow.json',
  're-review-on-expiry.workflow.json',
];

for (const name of PRESETS) {
  test(`the preset ${name} validates clean, inside the FEEL subset`, () => {
    const res = validateDefinition(load(name));
    assert.deepEqual(
      res.issues.filter((i) => i.severity === 'error'),
      [],
    );
    assert.equal(res.valid, true);
  });
}

test('a definition that is not the schema is refused before the graph is judged', () => {
  const res = validateDefinition({ name: 'x' });
  assert.equal(res.valid, false);
  assert.ok(res.issues.every((i) => i.code === 'SCHEMA'));
});

test('the graph: a broken edge, an unreachable step, a branch with no default', () => {
  const broken = load('canonical-ingest-to-air.workflow.json');
  broken.transitions[0]!.to = 'does_not_exist';
  assert.ok(validateDefinition(broken).issues.some((i) => i.code === 'BAD_TO'));

  const island = load('simple-approval.workflow.json');
  island.steps.push({ id: 's_island', kind: 'end' });
  const unreachable = validateDefinition(island).issues.find((i) => i.code === 'UNREACHABLE_STEP');
  assert.equal(unreachable?.stepId, 's_island');

  const gateless = load('canonical-ingest-to-air.workflow.json');
  const gate = gateless.steps.find((s) => s.id === 's_gate')!;
  gate.config = {} as BranchConfig;
  const reject = gateless.transitions.find((t) => t.id === 't_reject')!;
  delete reject.isDefault;
  reject.when = '= vars.verdict = "rejected"';
  assert.ok(validateDefinition(gateless).issues.some((i) => i.code === 'BRANCH_NO_DEFAULT'));
});

test('an expression that does not parse is FEEL_PARSE, anchored to its edge', () => {
  const def = load('canonical-ingest-to-air.workflow.json');
  def.transitions.find((t) => t.id === 't_ok')!.when = '= vars.verdict = (';
  const issue = validateDefinition(def).issues.find((i) => i.code === 'FEEL_PARSE');
  assert.equal(issue?.transitionId, 't_ok');
});

test('an expression outside the subset is FEEL_SUBSET — refused at publish, construct named', () => {
  const def = load('canonical-ingest-to-air.workflow.json');
  def.transitions.find((t) => t.id === 't_ok')!.when = '= some v in vars.list satisfies v > 1';
  const res = validateDefinition(def);
  assert.equal(res.valid, false);
  const issue = res.issues.find((i) => i.code === 'FEEL_SUBSET');
  assert.equal(issue?.transitionId, 't_ok');
  assert.match(issue!.message, /`some` \/ `every`/);
});

test('an undeclared var is a warning, not an error', () => {
  const def = load('simple-approval.workflow.json');
  def.transitions.find((t) => t.id === 't_yes')!.when = '= vars.notDeclared = 1';
  const res = validateDefinition(def);
  assert.ok(res.issues.some((i) => i.code === 'UNBOUND_VAR' && i.severity === 'warning'));
});

test('the subset: everything §3 allows passes', () => {
  for (const ok of [
    '= vars.x > 3 and steps.probe.output.durationMs <= 10',
    '= incoming.outcome = "approved" or not(vars.skip)',
    '= if vars.n > 1 then "many" else null',
    '= vars.n between 1 and 5',
    '= vars.kind in ["proxy", "thumbnail"]',
    '= count(incoming.renditions) + string length(vars.title) * 2 - 1',
    '= starts with(vars.title, "News") and ends with(vars.title, "!")',
    '= contains(lower case(vars.title), upper case("x"))',
    '= date("2026-10-12") + duration("P1D") > now()',
    '= (vars.a = true) != false',
    '= instance.id',
  ])
    assert.equal(feelProblem(ok), null, ok);
});

test('the subset: what §3 leaves out is refused, by name', () => {
  const refused: [string, RegExp][] = [
    ['= function(a) a + 1', /function definition/],
    ['= for x in vars.xs return x', /`for` loop/],
    ['= every x in vars.xs satisfies x > 1', /`some` \/ `every`/],
    ['= vars.xs[item > 1]', /list filter/],
    ['= {a: 1}', /context literal/],
    ['= sum(vars.xs)', /the function `sum`/],
    ['= somethingElse.x', /`somethingElse` is not one of vars, incoming, steps, instance/],
  ];
  for (const [expr, why] of refused) {
    const problem = feelProblem(expr);
    assert.equal(problem?.code, 'FEEL_SUBSET', expr);
    assert.match(problem!.message, why, expr);
  }
  assert.equal(feelProblem('= ')?.code, 'FEEL_PARSE');
  // `instance` is a context root, so `instance of` no longer parses at all — refused either way.
  assert.notEqual(feelProblem('= vars.x instance of number'), null);
});

// EP-22.4 — a command step issues a PLATFORM command, from a closed list, with its own fields.

test('every command a workflow may issue, and every event that answers one, has a schema', () => {
  for (const [command, spec] of Object.entries(WORKFLOW_COMMANDS)) {
    assert.ok(EVENT_TYPES.includes(command), command);
    for (const e of [...spec.completes, ...spec.fails]) assert.ok(EVENT_TYPES.includes(e), e);
    // A failure fails the step with its error, so the answer must carry one.
    for (const e of spec.fails) assert.ok(payloadShape(e)?.required.includes('error'), e);
  }
  assert.deepEqual(commandAnswers(), {
    completes: ['transcode.completed'],
    fails: ['transcode.failed'],
  });
});

test('a command step may not publish a fact, nor a command nobody consumes', () => {
  const def = load('canonical-ingest-to-air.workflow.json');
  const step = def.steps.find((s) => s.id === 's_transcode')!;
  (step.config as CommandConfig).request.event = 'asset.approved';
  const res = validateDefinition(def);
  assert.equal(res.valid, false);
  const issue = res.issues.find((i) => i.code === 'UNKNOWN_COMMAND');
  assert.equal(issue?.stepId, 's_transcode');
  assert.equal(issue?.path, '/steps/1/config/request/event');

  // The distribution preset names EP-37's publishing commands, which do not exist yet — and starts
  // on `asset.approved`, which EP-37 makes a trigger with them.
  const later = validateDefinition(load('post-approval-distribution.workflow.json'));
  assert.deepEqual(
    later.issues.filter((i) => i.severity === 'error').map((i) => [i.code, i.stepId]),
    [
      ['UNKNOWN_COMMAND', 's_web'],
      ['UNKNOWN_COMMAND', 's_social'],
      ['UNKNOWN_TRIGGER', 's_start'],
    ],
  );
});

test("a command's input names its fields — a misspelt one and a missing one are refused", () => {
  const def = load('canonical-ingest-to-air.workflow.json');
  const cfg = def.steps.find((s) => s.id === 's_transcode')!.config as CommandConfig;
  cfg.request.input = { assetId: '= vars.assetId', profile: '= vars.profile' };
  const issues = validateDefinition(def).issues.filter((i) => i.code === 'COMMAND_INPUT');
  assert.equal(issues.length, 2);
  assert.match(issues[0]!.message, /no field "profile"/);
  assert.match(issues[1]!.message, /needs "presetIds"/);
});

test('the awaited event must answer the command, and is matched by correlation id only', () => {
  const def = load('canonical-ingest-to-air.workflow.json');
  const cfg = def.steps.find((s) => s.id === 's_transcode')!.config as CommandConfig;
  cfg.await = { event: 'asset.ready', correlate: '= incoming.assetId = vars.assetId' };
  const codes = validateDefinition(def).issues.map((i) => i.code);
  assert.ok(codes.includes('AWAIT_EVENT'));
  assert.ok(codes.includes('CORRELATE_UNSUPPORTED'));
});

test('correlate is equality keys: each `incoming.<field> = <expr>`, joined with `and`', () => {
  assert.deepEqual(correlationKeys('= incoming.assetId = vars.assetId'), {
    keys: [{ field: 'assetId', expr: 'vars.assetId' }],
  });
  // Either side, nested fields, parentheses, a literal holding an `=`.
  assert.deepEqual(correlationKeys('= (vars.a = incoming.x.y) and incoming.k = "p=q"'), {
    keys: [
      { field: 'x.y', expr: 'vars.a' },
      { field: 'k', expr: '"p=q"' },
    ],
  });
  for (const [expr, why] of [
    ['= incoming.a != vars.a', /not an equality/],
    ['= incoming.a = 1 or incoming.b = 2', /not an equality/],
    ['= vars.a = vars.b', /no `incoming.<field>` side/],
    ['= incoming.a = incoming.b', /may not read `incoming`/],
    ['= incoming.a = 1 and incoming.a = 2', /keyed twice/],
    ['= incoming.a > 1', /not an equality/],
  ] as const) {
    const res = correlationKeys(expr);
    assert.ok('problem' in res, expr);
    assert.match(res.problem, why, expr);
  }
});

test('every event a workflow may wait for has a schema; a review verdict names who gave it', () => {
  for (const e of WORKFLOW_EVENTS) assert.ok(EVENT_TYPES.includes(e), e);
  for (const [e, v] of Object.entries(REVIEW_VERDICTS)) {
    assert.ok(WORKFLOW_EVENTS.includes(e), e);
    const shape = payloadShape(e);
    assert.ok(shape?.properties.includes(v.by), `${e}.${v.by}`);
    assert.ok(shape?.properties.includes('reviewPointId'), `${e}.reviewPointId`);
  }
});

test('a wait-event step: an event from the closed list, keyed on fields the event has', () => {
  const def = load('canonical-ingest-to-air.workflow.json');
  const cfg = def.steps.find((s) => s.id === 's_wait_ready')!.config as WaitEventConfig;
  const issues = (): [string, string | undefined][] =>
    validateDefinition(def)
      .issues.filter((i) => i.severity === 'error')
      .map((i) => [i.code, i.path]);

  cfg.event = 'permissions.changed';
  assert.deepEqual(issues(), [['UNKNOWN_EVENT', '/steps/2/config/event']]);
  cfg.event = 'asset.ready';
  cfg.correlate = '= incoming.assetId != vars.assetId';
  assert.deepEqual(issues(), [['CORRELATE_SHAPE', '/steps/2/config/correlate']]);
  cfg.correlate = '= incoming.asset = vars.assetId';
  const [only] = validateDefinition(def).issues.filter((i) => i.severity === 'error');
  assert.equal(only?.code, 'CORRELATE_FIELD');
  assert.match(only?.message ?? '', /asset\.ready has no field "asset"/);
});

test('a review point is an approval, and each one in a flow is its own', () => {
  const def = load('canonical-ingest-to-air.workflow.json');
  const review = def.steps.find((s) => s.id === 's_review')!;
  (review.config as HumanTaskConfig).taskType = 'edit';
  assert.deepEqual(
    validateDefinition(def)
      .issues.filter((i) => i.severity === 'error')
      .map((i) => i.code),
    ['REVIEW_TASK_TYPE'],
  );
  (review.config as HumanTaskConfig).taskType = 'approve';
  // A second review step at the same point.
  def.steps.push({ ...review, id: 's_review_2' });
  def.transitions.push({ id: 't_r2', from: 's_wait_ready', to: 's_review_2' });
  def.transitions.push({ id: 't_r2_out', from: 's_review_2', to: 's_gate' });
  const dup = validateDefinition(def).issues.find((i) => i.code === 'DUP_REVIEW_POINT');
  assert.equal(dup?.stepId, 's_review_2');
});

test('a start trigger is an event from the closed list, and every trigger has a schema', () => {
  for (const e of WORKFLOW_TRIGGERS) assert.ok(EVENT_TYPES.includes(e), e);
  const def = load('canonical-ingest-to-air.workflow.json');
  const start = def.steps.find((s) => s.kind === 'start')!.config as StartConfig;
  assert.deepEqual(start.trigger?.output, { 'vars.assetId': '= incoming.assetId' });
  start.trigger = { event: 'asset.approved' };
  const issue = validateDefinition(def).issues.find((i) => i.code === 'UNKNOWN_TRIGGER');
  assert.equal(issue?.stepId, 's_start');
  assert.equal(issue?.path, '/steps/0/config/trigger/event');
});

test('an error path is reachable: onError.transitionTo and a compensation handler count (EP-22.9)', () => {
  const def = load('simple-approval.workflow.json');
  const task = def.steps.find((s) => s.id === 's_task')!;
  task.onError = { transitionTo: 's_late' };
  task.compensation = 's_undo';
  def.steps.push(
    { id: 's_late', kind: 'end', config: { status: 'late' } },
    {
      id: 's_undo',
      kind: 'end',
      config: {},
    },
  );
  const codes = validateDefinition(def).issues.map((i) => i.code);
  assert.ok(!codes.includes('UNREACHABLE_STEP'), codes.join(','));
});

test('retry is a command step’s only', () => {
  const def = load('simple-approval.workflow.json');
  def.steps.find((s) => s.id === 's_task')!.retry = { maxAttempts: 2 };
  const issue = validateDefinition(def).issues.find((i) => i.code === 'RETRY_NOT_COMMAND');
  assert.equal(issue?.stepId, 's_task');
});

test('the palette: every step kind, a self-contained config schema each, and the closed lists', async () => {
  // ajv is CJS; typed here as the registry types it (src/registry.ts).
  const { default: Ajv2020 } = await import('ajv/dist/2020.js');
  const Ajv = Ajv2020 as unknown as new (opts: object) => {
    compile(schema: object): ((v: unknown) => boolean) & { errors?: unknown };
  };
  const entries = palette();
  const kinds = [
    'start',
    'end',
    'command',
    'human-task',
    'wait-event',
    'timer',
    'branch',
    'parallel',
    'sub-flow',
  ];
  assert.deepEqual(entries.map((e) => e.kind).sort(), [...kinds].sort());
  assert.ok(!JSON.stringify(entries).includes('$ref'), 'no $ref left to resolve');
  const of = (kind: string) => entries.find((e) => e.kind === kind)!;
  assert.deepEqual(of('start').choices, { triggers: [...WORKFLOW_TRIGGERS] });
  assert.deepEqual(of('wait-event').choices, { events: [...WORKFLOW_EVENTS] });
  assert.deepEqual(
    (of('command').choices?.['commands'] as { event: string }[]).map((c) => c.event),
    Object.keys(WORKFLOW_COMMANDS),
  );
  // Each preset step's config is valid against its kind's schema — the schema the designer edits by.
  const ajv = new Ajv({ strict: false, allErrors: true });
  for (const name of PRESETS)
    for (const step of load(name).steps) {
      const validate = ajv.compile(of(step.kind).configSchema);
      assert.ok(
        validate(step.config ?? {}),
        `${name} ${step.id}: ${JSON.stringify(validate.errors)}`,
      );
    }
});
