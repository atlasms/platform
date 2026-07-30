import { newModdle, toBpmnId, ATLAS_NS } from './moddle.ts';
import type {
  WorkflowDefinition, Step, CommandConfig, HumanTaskConfig, WaitEventConfig,
  TimerConfig, BranchConfig, SubFlowConfig, StartConfig, EndConfig, DataMapping,
} from '../types.ts';

/** DSL -> BPMN 2.0 XML. Engine policy rides in the atlas: extension namespace. */
export async function exportBpmn(def: WorkflowDefinition): Promise<string> {
  const m = newModdle();
  const A = (type: string, props: any) => m.create('atlas:' + type, props);
  const ext = (values: any[]) => (values.length ? m.create('bpmn:ExtensionElements', { values }) : undefined);

  const mappingsToIo = (dir: 'in' | 'out', map: DataMapping | undefined, prefix = '') =>
    Object.entries(map ?? {}).map(([k, v]) => A('Mapping', { direction: dir, target: prefix + k, source: v }));

  const io = (parts: any[]) => (parts.length ? [A('Io', { mappings: parts })] : []);

  const nodes = new Map<string, any>();

  for (const s of def.steps) {
    let el: any;
    switch (s.kind) {
      case 'start': {
        const c = (s.config ?? {}) as StartConfig;
        const values = c.trigger ? [A('Trigger', { event: c.trigger.event, filter: c.trigger.filter })] : [];
        el = m.create('bpmn:StartEvent', {
          id: s.id, name: s.name, extensionElements: ext(values),
          eventDefinitions: c.trigger ? [m.create('bpmn:MessageEventDefinition', {})] : undefined,
        });
        break;
      }
      case 'end': {
        const c = (s.config ?? {}) as EndConfig;
        el = m.create('bpmn:EndEvent', {
          id: s.id, name: s.name,
          extensionElements: ext([A('End', { status: c.status, terminate: c.terminate })]),
          eventDefinitions: c.terminate ? [m.create('bpmn:TerminateEventDefinition', {})] : undefined,
        });
        break;
      }
      case 'command': {
        const c = s.config as CommandConfig;
        const values = [
          A('Command', { action: c.action, event: c.request.event }),
          ...(s.retry ? [A('Retry', { maxAttempts: s.retry.maxAttempts, backoffType: s.retry.backoff?.type, initial: s.retry.backoff?.initial, max: s.retry.backoff?.max, factor: s.retry.backoff?.factor })] : []),
          ...onErrorExt(s, A),
          ...(c.await ? [A('Await', { event: c.await.event, correlate: c.await.correlate })] : []),
          ...io([...mappingsToIo('in', c.request.input, 'request.'), ...mappingsToIo('out', c.await?.output)]),
        ];
        el = m.create('bpmn:ServiceTask', { id: s.id, name: s.name, extensionElements: ext(values) });
        break;
      }
      case 'human-task': {
        const c = s.config as HumanTaskConfig;
        const values = [
          A('Assignment', { taskType: c.taskType, userId: c.assignee.userId, role: c.assignee.role, expression: c.assignee.expression, reviewPointId: c.reviewPointId, dueIn: c.dueIn }),
          ...(c.escalation ? [A('Escalation', { after: c.escalation.after, action: c.escalation.action, userId: c.escalation.to?.userId, role: c.escalation.to?.role })] : []),
          ...io(mappingsToIo('out', c.output)),
        ];
        el = m.create('bpmn:UserTask', { id: s.id, name: s.name, extensionElements: ext(values) });
        break;
      }
      case 'wait-event': {
        const c = s.config as WaitEventConfig;
        const values = [A('Await', { event: c.event, correlate: c.correlate }), ...io(mappingsToIo('out', c.output))];
        el = m.create('bpmn:IntermediateCatchEvent', { id: s.id, name: s.name, extensionElements: ext(values), eventDefinitions: [m.create('bpmn:MessageEventDefinition', {})] });
        break;
      }
      case 'timer': {
        const c = s.config as TimerConfig;
        const prop = c.mode === 'date' ? 'timeDate' : c.mode === 'cron' ? 'timeCycle' : 'timeDuration';
        const ted = m.create('bpmn:TimerEventDefinition', { [prop]: m.create('bpmn:FormalExpression', { body: c.value }) });
        el = m.create('bpmn:IntermediateCatchEvent', { id: s.id, name: s.name, eventDefinitions: [ted] });
        break;
      }
      case 'branch':
        el = m.create('bpmn:ExclusiveGateway', { id: s.id, name: s.name }); // default set later
        break;
      case 'parallel':
        el = m.create('bpmn:ParallelGateway', { id: s.id, name: s.name });
        break;
      case 'sub-flow': {
        const c = s.config as SubFlowConfig;
        const values = [A('Call', { workflowId: c.workflowId, version: String(c.version ?? 'latest') }),
          ...io([...mappingsToIo('in', c.input, 'input.'), ...mappingsToIo('out', c.output)])];
        el = m.create('bpmn:CallActivity', { id: s.id, name: s.name, calledElement: toBpmnId(c.workflowId), extensionElements: ext(values) });
        break;
      }
    }
    nodes.set(s.id, el);
  }

  // Sequence flows.
  const flows = new Map<string, any>();
  for (const t of def.transitions) {
    const flow = m.create('bpmn:SequenceFlow', {
      id: t.id, name: t.name, sourceRef: nodes.get(t.from), targetRef: nodes.get(t.to),
      conditionExpression: t.when ? m.create('bpmn:FormalExpression', { body: t.when, language: 'feel' }) : undefined,
    });
    flows.set(t.id, flow);
  }
  // Branch default -> gateway.default references a flow.
  for (const s of def.steps.filter((s) => s.kind === 'branch')) {
    const def0 = (s.config as BranchConfig)?.default;
    if (def0 && flows.has(def0)) nodes.get(s.id).default = flows.get(def0);
  }

  const procExt = ext([
    m.create('atlas:Vars', {
      vars: (def.vars ?? []).map((v) => m.create('atlas:Var', { name: v.name, type: v.type, initial: v.initial === undefined ? undefined : String(v.initial) })),
    }),
  ]);

  const process = m.create('bpmn:Process', {
    id: toBpmnId(def.id), name: def.name, isExecutable: true,
    flowElements: [...nodes.values(), ...flows.values()],
    extensionElements: procExt,
  });

  const definitions = m.create('bpmn:Definitions', {
    id: 'Definitions_' + toBpmnId(def.id), targetNamespace: ATLAS_NS, rootElements: [process],
  });

  const { xml } = await m.toXML(definitions, { format: true });
  return xml;
}

function onErrorExt(s: Step, A: (t: string, p: any) => any) {
  if (!s.onError) return [];
  if (typeof s.onError === 'string') return [A('OnError', { mode: s.onError })];
  return [A('OnError', { mode: 'transition', transitionTo: s.onError.transitionTo })];
}
