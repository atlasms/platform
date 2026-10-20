import type { ModdleObject } from 'bpmn-moddle';
import type {
  DataMapping,
  OnError,
  Retry,
  Step,
  Transition,
  VarDecl,
  WorkflowDefinition,
} from '../workflow/types.ts';
import { positionOf, type Point } from './layout.ts';
import { fromBpmnId, newModdle } from './moddle.ts';

export interface UnsupportedElement {
  elementId?: string;
  elementType: string;
  reason?: string;
}

/**
 * An import refused (bms.yaml `ImportError`): the file is not BPMN at all (`MALFORMED_XML`), or it
 * uses constructs outside the Atlas subset (`UNSUPPORTED_BPMN`, each listed) — reported, never
 * silently dropped, because a dropped boundary event or lane is behaviour the author drew and the
 * engine would not have.
 */
export class ImportFailure extends Error {
  readonly code: 'UNSUPPORTED_BPMN' | 'MALFORMED_XML';
  readonly unsupported: UnsupportedElement[];
  constructor(
    code: ImportFailure['code'],
    message: string,
    unsupported: UnsupportedElement[] = [],
  ) {
    super(message);
    this.name = 'ImportFailure';
    this.code = code;
    this.unsupported = unsupported;
  }
}

// Reading a parsed element: every property is `unknown` until narrowed here.
type El = ModdleObject;
const isEl = (v: unknown): v is El =>
  typeof v === 'object' && v !== null && typeof (v as { $type?: unknown }).$type === 'string';
const str = (o: El | undefined, k: string) => (typeof o?.[k] === 'string' ? o[k] : undefined);
const num = (o: El | undefined, k: string) => (typeof o?.[k] === 'number' ? o[k] : undefined);
const bool = (o: El | undefined, k: string) => (typeof o?.[k] === 'boolean' ? o[k] : undefined);
const one = (o: El | undefined, k: string) => (isEl(o?.[k]) ? (o[k] as El) : undefined);
const many = (o: El | undefined, k: string): El[] => {
  const v = o?.[k];
  return Array.isArray(v) ? v.filter(isEl) : [];
};
const idOf = (o: El | undefined) => {
  const id = str(o, 'id');
  return id === undefined ? undefined : fromBpmnId(id);
};
const exts = (el: El) => many(one(el, 'extensionElements'), 'values');
const ext = (el: El, type: string) => exts(el).find((e) => e.$type === `atlas:${type}`);

const NODES = new Set([
  'bpmn:StartEvent',
  'bpmn:EndEvent',
  'bpmn:ServiceTask',
  'bpmn:UserTask',
  'bpmn:IntermediateCatchEvent',
  'bpmn:ExclusiveGateway',
  'bpmn:ParallelGateway',
  'bpmn:CallActivity',
]);

/** Which event definitions each node may carry — any other is behaviour the engine does not have. */
const EVENT_DEFINITIONS: Record<string, string[]> = {
  'bpmn:StartEvent': ['bpmn:MessageEventDefinition'],
  'bpmn:EndEvent': ['bpmn:TerminateEventDefinition'],
  'bpmn:IntermediateCatchEvent': ['bpmn:MessageEventDefinition', 'bpmn:TimerEventDefinition'],
};

export interface ImportOptions {
  /** The channel the new draft belongs to — the caller's, never the file's. */
  channelId: string;
}

/**
 * BPMN 2.0 XML → a DSL draft (DSL doc §11): the inverse of `exportBpmn`, and the subset a BPMN tool
 * may hand in. The result is a draft (version 1) to be validated like any other — import maps, the
 * validator judges, publish gates. Positions come from the DI when there is one.
 */
export async function importBpmn(xml: string, options: ImportOptions): Promise<WorkflowDefinition> {
  let root: El;
  try {
    root = (await newModdle().fromXML(xml)).rootElement;
  } catch (e) {
    throw new ImportFailure('MALFORMED_XML', `not a BPMN 2.0 document: ${(e as Error).message}`);
  }
  if (root.$type !== 'bpmn:Definitions')
    throw new ImportFailure('MALFORMED_XML', `not a BPMN 2.0 document: the root is ${root.$type}`);

  const roots = many(root, 'rootElements');
  const processes = roots.filter((e) => e.$type === 'bpmn:Process');
  const process = processes[0];
  if (!process)
    throw new ImportFailure('UNSUPPORTED_BPMN', 'the file has no bpmn:Process', [
      { elementType: 'bpmn:Process', reason: 'a workflow is one process' },
    ]);

  const unsupported: UnsupportedElement[] = [];
  const refuse = (el: El, reason?: string, elementType = el.$type) =>
    unsupported.push(clean<UnsupportedElement>({ elementId: str(el, 'id'), elementType, reason }));
  for (const p of processes.slice(1)) refuse(p, 'one process per file');
  for (const c of roots.filter((e) => e.$type === 'bpmn:Collaboration'))
    if (many(c, 'participants').length > 1 || many(c, 'messageFlows').length)
      refuse(c, 'pools and message flows: a workflow is one process');
  for (const set of many(process, 'laneSets'))
    for (const lane of many(set, 'lanes'))
      refuse(lane, "lanes: who does a task is the human task's assignee");

  const elements = many(process, 'flowElements');
  const flows = elements.filter((e) => e.$type === 'bpmn:SequenceFlow');
  const nodes = elements.filter((e) => e.$type !== 'bpmn:SequenceFlow');
  for (const n of nodes) {
    if (!NODES.has(n.$type)) {
      refuse(n);
      continue;
    }
    const allowed = EVENT_DEFINITIONS[n.$type] ?? [];
    const definitions = many(n, 'eventDefinitions');
    for (const d of definitions)
      if (!allowed.includes(d.$type)) refuse(n, `on a ${n.$type}`, d.$type);
    if (n.$type === 'bpmn:IntermediateCatchEvent' && definitions.length !== 1)
      refuse(n, 'a catch event waits for exactly one message or timer');
    const loop = one(n, 'loopCharacteristics');
    if (loop) refuse(n, 'loops and multi-instance: a loop is an edge back', loop.$type);
  }
  for (const f of flows)
    if (!one(f, 'sourceRef') || !one(f, 'targetRef'))
      refuse(f, "a sequence flow joins two of the process's nodes");
  if (unsupported.length)
    throw new ImportFailure(
      'UNSUPPORTED_BPMN',
      `outside the Atlas subset: ${[...new Set(unsupported.map((u) => u.elementType))].join(', ')}`,
      unsupported,
    );

  const positions = diagramPositions(root);
  const transitions: Transition[] = flows.map((f) =>
    clean<Transition>({
      id: idOf(f),
      from: idOf(one(f, 'sourceRef')),
      to: idOf(one(f, 'targetRef')),
      name: str(f, 'name'),
      when: str(one(f, 'conditionExpression'), 'body'),
    }),
  );
  const outgoing = new Map<string, number>();
  for (const f of flows) {
    const from = str(one(f, 'sourceRef'), 'id') ?? '';
    outgoing.set(from, (outgoing.get(from) ?? 0) + 1);
  }
  const steps = nodes.map((n) => {
    const step = toStep(n, outgoing);
    const at = positions.get(str(n, 'id') ?? '');
    return at ? { ...step, position: at } : step;
  });

  // A gateway's default flow is the branch's `default` and that edge's `isDefault`.
  for (const n of nodes) {
    if (n.$type !== 'bpmn:ExclusiveGateway') continue;
    const fallback = idOf(one(n, 'default'));
    if (!fallback) continue;
    const step = steps.find((s) => s.id === idOf(n));
    if (step) step.config = { default: fallback };
    const t = transitions.find((x) => x.id === fallback);
    if (t) t.isDefault = true;
  }

  const vars = many(ext(process, 'Vars'), 'vars').map(toVar);
  const scope = ext(process, 'Scope');
  const description = many(process, 'documentation')
    .map((d) => str(d, 'text'))
    .filter((t) => t !== undefined)
    .join('\n');
  return clean<WorkflowDefinition>({
    id: idOf(process),
    channelId: options.channelId,
    name: str(process, 'name') ?? idOf(process),
    description: description || undefined,
    scope: scope
      ? nonEmpty(
          clean({
            categoryId: str(scope, 'categoryId'),
            mediaType: str(scope, 'mediaType'),
            usage: str(scope, 'usage'),
          }),
        )
      : undefined,
    version: 1,
    status: 'draft',
    vars: vars.length ? vars : undefined,
    steps,
    transitions,
  });
}

function toStep(n: El, outgoing: Map<string, number>): Step {
  const base = { id: idOf(n), name: str(n, 'name'), ...policyOf(n) };
  const { inputs, outputs } = io(n);
  switch (n.$type) {
    case 'bpmn:StartEvent': {
      const trigger = ext(n, 'Trigger');
      return clean<Step>({
        ...base,
        kind: 'start',
        config: trigger
          ? {
              trigger: clean({
                event: str(trigger, 'event'),
                filter: str(trigger, 'filter'),
                output: nonEmpty(outputs),
              }),
            }
          : {},
      });
    }
    case 'bpmn:EndEvent': {
      const end = ext(n, 'End');
      const terminates = many(n, 'eventDefinitions').some(
        (d) => d.$type === 'bpmn:TerminateEventDefinition',
      );
      return clean<Step>({
        ...base,
        kind: 'end',
        config: clean({
          status: str(end, 'status'),
          terminate: terminates || bool(end, 'terminate'),
        }),
      });
    }
    case 'bpmn:ServiceTask': {
      const command = ext(n, 'Command');
      const wait = ext(n, 'Await');
      return clean<Step>({
        ...base,
        kind: 'command',
        config: clean({
          action: str(command, 'action'),
          request: clean({
            event: str(command, 'event'),
            input: nonEmpty(strip(inputs, 'request.')),
          }),
          await: wait
            ? clean({
                event: str(wait, 'event'),
                correlate: str(wait, 'correlate'),
                output: nonEmpty(outputs),
              })
            : undefined,
        }),
      });
    }
    case 'bpmn:UserTask': {
      const a = ext(n, 'Assignment');
      const esc = ext(n, 'Escalation');
      const form = str(ext(n, 'Form'), 'json');
      return clean<Step>({
        ...base,
        kind: 'human-task',
        config: clean({
          taskType: str(a, 'taskType'),
          assignee: clean({
            userId: str(a, 'userId'),
            role: str(a, 'role'),
            expression: str(a, 'expression'),
          }),
          reviewPointId: str(a, 'reviewPointId'),
          form: form === undefined ? undefined : parseJson(form),
          dueIn: str(a, 'dueIn'),
          output: nonEmpty(outputs),
          escalation: esc
            ? clean({
                after: str(esc, 'after'),
                action: str(esc, 'action'),
                to: nonEmpty(clean({ userId: str(esc, 'userId'), role: str(esc, 'role') })),
              })
            : undefined,
        }),
      });
    }
    case 'bpmn:IntermediateCatchEvent': {
      const timer = many(n, 'eventDefinitions').find(
        (d) => d.$type === 'bpmn:TimerEventDefinition',
      );
      if (timer) {
        const [mode, value] = one(timer, 'timeDate')
          ? ['date', one(timer, 'timeDate')]
          : one(timer, 'timeCycle')
            ? ['cron', one(timer, 'timeCycle')]
            : ['duration', one(timer, 'timeDuration')];
        return clean<Step>({
          ...base,
          kind: 'timer',
          config: clean({ mode, value: str(value as El | undefined, 'body') }),
        });
      }
      const wait = ext(n, 'Await');
      return clean<Step>({
        ...base,
        kind: 'wait-event',
        config: clean({
          event: str(wait, 'event'),
          correlate: str(wait, 'correlate'),
          output: nonEmpty(outputs),
        }),
      });
    }
    case 'bpmn:ExclusiveGateway':
      return clean<Step>({ ...base, kind: 'branch', config: {} });
    case 'bpmn:ParallelGateway': {
      // The direction BPMN states; a tool that left it unspecified is read by its edges.
      const direction = str(n, 'gatewayDirection');
      const mode =
        direction === 'Converging'
          ? 'join'
          : direction === 'Diverging'
            ? 'split'
            : (outgoing.get(str(n, 'id') ?? '') ?? 0) > 1
              ? 'split'
              : 'join';
      return clean<Step>({ ...base, kind: 'parallel', config: { mode } });
    }
    default: {
      // bpmn:CallActivity — the only node left once the subset was checked.
      const call = ext(n, 'Call');
      const v = str(call, 'version');
      const version =
        v === undefined ? undefined : v === 'latest' ? 'latest' : /^\d+$/.test(v) ? Number(v) : v;
      return clean<Step>({
        ...base,
        kind: 'sub-flow',
        config: clean({
          workflowId: str(call, 'workflowId') ?? fromCalled(n),
          version,
          input: nonEmpty(strip(inputs, 'input.')),
          output: nonEmpty(outputs),
        }),
      });
    }
  }
}

/** `calledElement` is a plain id string in BPMN, not a reference. */
const fromCalled = (n: El) => {
  const id = str(n, 'calledElement');
  return id === undefined ? undefined : fromBpmnId(id);
};

function policyOf(n: El): {
  retry?: Retry;
  timeout?: string;
  onError?: OnError;
  compensation?: string;
} {
  const r = ext(n, 'Retry');
  const oe = ext(n, 'OnError');
  const mode = str(oe, 'mode');
  const backoff = r
    ? clean<NonNullable<Retry['backoff']>>({
        type: str(r, 'backoffType'),
        initial: str(r, 'initial'),
        max: str(r, 'max'),
        factor: num(r, 'factor'),
      })
    : undefined;
  return clean({
    retry: r
      ? clean({ maxAttempts: num(r, 'maxAttempts'), backoff: nonEmpty(backoff ?? {}) })
      : undefined,
    timeout: str(ext(n, 'Timeout'), 'after'),
    onError:
      mode === 'transition'
        ? { transitionTo: str(oe, 'transitionTo') }
        : mode === undefined
          ? undefined
          : mode,
    compensation: str(oe, 'compensation'),
  });
}

function io(n: El): { inputs: DataMapping; outputs: DataMapping } {
  const inputs: DataMapping = {};
  const outputs: DataMapping = {};
  for (const map of many(ext(n, 'Io'), 'mappings')) {
    const target = str(map, 'target');
    const source = str(map, 'source');
    if (target === undefined || source === undefined) continue;
    (str(map, 'direction') === 'in' ? inputs : outputs)[target] = source;
  }
  return { inputs, outputs };
}

function toVar(v: El): VarDecl {
  const type = str(v, 'type');
  const initial = str(v, 'initial');
  return clean<VarDecl>({
    name: str(v, 'name'),
    type,
    description: str(v, 'description'),
    // A string var's initial was written as itself; any other as JSON (export.ts `varProps`).
    initial: initial === undefined ? undefined : type === 'string' ? initial : parseJson(initial),
  });
}

/** Where the DI draws each node — keyed by the BPMN id, as the process's elements are. */
function diagramPositions(root: El): Map<string, Point> {
  const at = new Map<string, Point>();
  for (const d of many(root, 'diagrams'))
    for (const shape of many(one(d, 'plane'), 'planeElement')) {
      if (shape.$type !== 'bpmndi:BPMNShape') continue;
      const id = str(one(shape, 'bpmnElement'), 'id');
      const b = one(shape, 'bounds');
      const [x, y, width, height] = ['x', 'y', 'width', 'height'].map((k) => num(b, k));
      if (id === undefined || x === undefined || y === undefined) continue;
      if (!at.has(id)) at.set(id, positionOf({ x, y, width: width ?? 0, height: height ?? 0 }));
    }
  return at;
}

const strip = (map: DataMapping, prefix: string): DataMapping =>
  Object.fromEntries(
    Object.entries(map).map(([k, v]) => [k.startsWith(prefix) ? k.slice(prefix.length) : k, v]),
  );
const nonEmpty = <T extends object>(o: T): T | undefined => (Object.keys(o).length ? o : undefined);
const parseJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return s; // written by hand, not by export — kept as the text it is
  }
};

/** Drop `undefined` (recursively through plain objects) so a shape compares, and validates, clean. */
function clean<T>(obj: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] =
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      Object.getPrototypeOf(v) === Object.prototype
        ? clean(v as Record<string, unknown>)
        : v;
  }
  return out as T;
}
