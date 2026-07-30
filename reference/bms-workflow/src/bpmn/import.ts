import { newModdle, fromBpmnId } from './moddle.ts';
import type { WorkflowDefinition, Step, Transition, DataMapping, VarDecl } from '../types.ts';

const SUPPORTED = new Set([
  'bpmn:StartEvent', 'bpmn:EndEvent', 'bpmn:ServiceTask', 'bpmn:UserTask',
  'bpmn:IntermediateCatchEvent', 'bpmn:ExclusiveGateway', 'bpmn:ParallelGateway', 'bpmn:CallActivity',
]);

class ImportFailure extends Error {
  code = 'UNSUPPORTED_BPMN' as const;
  unsupported: { elementId?: string; elementType: string; reason?: string }[];
  constructor(unsupported: { elementId?: string; elementType: string }[]) {
    super(`unsupported BPMN elements: ${unsupported.map((u) => u.elementType).join(', ')}`);
    this.unsupported = unsupported;
  }
}

const exts = (el: any): any[] => el?.extensionElements?.values ?? [];
const findExt = (el: any, type: string) => exts(el).find((e) => e.$type === `atlas:${type}`);

function ioMappings(el: any) {
  const io = findExt(el, 'Io');
  const inM: DataMapping = {}, outM: DataMapping = {};
  for (const map of io?.mappings ?? []) (map.direction === 'in' ? inM : outM)[map.target] = map.source;
  return { inM, outM };
}
const strip = (obj: DataMapping, prefix: string): DataMapping =>
  Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.startsWith(prefix) ? k.slice(prefix.length) : k, v]));
const nonEmpty = (o: object) => (Object.keys(o).length ? o : undefined);

/** BPMN 2.0 XML -> DSL. Throws ImportFailure listing any out-of-subset constructs. */
export async function importBpmn(xml: string): Promise<WorkflowDefinition> {
  const m = newModdle();
  const { rootElement } = await m.fromXML(xml);
  const process = rootElement.rootElements.find((e: any) => e.$type === 'bpmn:Process');
  if (!process) throw new ImportFailure([{ elementType: 'missing bpmn:Process' }]);

  const elements: any[] = process.flowElements ?? [];
  const flows = elements.filter((e) => e.$type === 'bpmn:SequenceFlow');
  const nodes = elements.filter((e) => e.$type !== 'bpmn:SequenceFlow');

  const unsupported = nodes.filter((n) => !SUPPORTED.has(n.$type)).map((n) => ({ elementId: n.id, elementType: n.$type }));
  if (unsupported.length) throw new ImportFailure(unsupported);

  const transitions: Transition[] = flows.map((f) => clean<Transition>({
    id: f.id, from: fromBpmnId(f.sourceRef?.id), to: fromBpmnId(f.targetRef?.id),
    name: f.name, when: f.conditionExpression?.body,
  }));
  const inDeg = new Map<string, number>(), outDeg = new Map<string, number>();
  for (const t of transitions) { outDeg.set(t.from, (outDeg.get(t.from) ?? 0) + 1); inDeg.set(t.to, (inDeg.get(t.to) ?? 0) + 1); }

  const steps: Step[] = nodes.map((n) => nodeToStep(n, inDeg, outDeg));

  // Branch default -> config.default + isDefault on the transition.
  for (const n of nodes.filter((n) => n.$type === 'bpmn:ExclusiveGateway')) {
    const defFlowId = n.default?.id;
    if (defFlowId) {
      const step = steps.find((s) => s.id === n.id)!;
      (step.config as any).default = defFlowId;
      const tr = transitions.find((t) => t.id === defFlowId);
      if (tr) tr.isDefault = true;
    }
  }

  const varsEl = findExt(process, 'Vars');
  const vars: VarDecl[] = (varsEl?.vars ?? []).map((v: any) => clean<VarDecl>({ name: v.name, type: v.type, initial: v.initial }));

  return clean<WorkflowDefinition>({
    id: fromBpmnId(process.id), channelId: 'ch12', name: process.name, version: 1, status: 'draft',
    vars: vars.length ? vars : undefined, steps, transitions,
  });
}

function nodeToStep(n: any, inDeg: Map<string, number>, outDeg: Map<string, number>): Step {
  const base = { id: n.id, name: n.name };
  switch (n.$type) {
    case 'bpmn:StartEvent': {
      const trig = findExt(n, 'Trigger');
      return clean<Step>({ ...base, kind: 'start', config: trig ? { trigger: clean({ event: trig.event, filter: trig.filter }) } : {} });
    }
    case 'bpmn:EndEvent': {
      const end = findExt(n, 'End');
      const terminate = (n.eventDefinitions ?? []).some((d: any) => d.$type === 'bpmn:TerminateEventDefinition');
      return clean<Step>({ ...base, kind: 'end', config: clean({ status: end?.status, terminate: terminate || end?.terminate }) });
    }
    case 'bpmn:ServiceTask': {
      const cmd = findExt(n, 'Command'), aw = findExt(n, 'Await'), retry = findExt(n, 'Retry'), oe = findExt(n, 'OnError');
      const { inM, outM } = ioMappings(n);
      return clean<Step>({
        ...base, kind: 'command', retry: retryFrom(retry), onError: onErrorFrom(oe),
        config: clean({
          action: cmd?.action,
          request: clean({ event: cmd?.event, input: nonEmpty(strip(inM, 'request.')) }),
          await: aw ? clean({ event: aw.event, correlate: aw.correlate, output: nonEmpty(outM) }) : undefined,
        }),
      });
    }
    case 'bpmn:UserTask': {
      const a = findExt(n, 'Assignment'), esc = findExt(n, 'Escalation');
      const { outM } = ioMappings(n);
      return clean<Step>({
        ...base, kind: 'human-task',
        config: clean({
          taskType: a?.taskType, assignee: clean({ userId: a?.userId, role: a?.role, expression: a?.expression }),
          reviewPointId: a?.reviewPointId, dueIn: a?.dueIn, output: nonEmpty(outM),
          escalation: esc ? clean({ after: esc.after, action: esc.action, to: nonEmpty(clean({ userId: esc.userId, role: esc.role })) }) : undefined,
        }),
      });
    }
    case 'bpmn:IntermediateCatchEvent': {
      const timer = (n.eventDefinitions ?? []).find((d: any) => d.$type === 'bpmn:TimerEventDefinition');
      if (timer) {
        const [mode, expr] = timer.timeDate ? ['date', timer.timeDate] : timer.timeCycle ? ['cron', timer.timeCycle] : ['duration', timer.timeDuration];
        return clean<Step>({ ...base, kind: 'timer', config: { mode, value: expr?.body } });
      }
      const aw = findExt(n, 'Await');
      const { outM } = ioMappings(n);
      return clean<Step>({ ...base, kind: 'wait-event', config: clean({ event: aw?.event, correlate: aw?.correlate, output: nonEmpty(outM) }) });
    }
    case 'bpmn:ExclusiveGateway':
      return clean<Step>({ ...base, kind: 'branch', config: {} });
    case 'bpmn:ParallelGateway':
      return clean<Step>({ ...base, kind: 'parallel', config: { mode: (outDeg.get(n.id) ?? 0) > 1 ? 'split' : 'join' } });
    case 'bpmn:CallActivity': {
      const call = findExt(n, 'Call');
      const { inM, outM } = ioMappings(n);
      const version = call?.version === 'latest' || call?.version == null ? 'latest' : /^\d+$/.test(call.version) ? Number(call.version) : call.version;
      return clean<Step>({ ...base, kind: 'sub-flow', config: clean({ workflowId: call?.workflowId, version, input: nonEmpty(strip(inM, 'input.')), output: nonEmpty(outM) }) });
    }
    default:
      throw new ImportFailure([{ elementId: n.id, elementType: n.$type }]);
  }
}

function retryFrom(r: any) {
  if (!r) return undefined;
  const backoff = clean({ type: r.backoffType, initial: r.initial, max: r.max, factor: r.factor });
  return clean({ maxAttempts: r.maxAttempts, backoff: Object.keys(backoff).length ? backoff : undefined });
}
function onErrorFrom(oe: any) {
  if (!oe) return undefined;
  return oe.mode === 'transition' ? { transitionTo: oe.transitionTo } : oe.mode;
}

/** Drop undefined values (recursively for plain objects) so shapes compare cleanly. */
function clean<T>(obj: any): T {
  if (Array.isArray(obj)) return obj as T;
  const out: any = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? clean(v) : v;
  }
  return out as T;
}

export { ImportFailure };
