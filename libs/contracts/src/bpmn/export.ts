import type { ModdleObject } from 'bpmn-moddle';
import type {
  BranchConfig,
  CommandConfig,
  DataMapping,
  EndConfig,
  HumanTaskConfig,
  ParallelConfig,
  StartConfig,
  Step,
  SubFlowConfig,
  TimerConfig,
  VarDecl,
  WaitEventConfig,
  WorkflowDefinition,
} from '../workflow/types.ts';
import { boundsOf, placeSteps, waypoints, type Bounds } from './layout.ts';
import { ATLAS_NS, newModdle, toBpmnId } from './moddle.ts';

type Props = Record<string, unknown>;

/**
 * DSL → BPMN 2.0 XML with DI (DSL doc §11). Control flow is standard BPMN; engine policy — the
 * command, the await and its correlation, retries, timeouts, mappings, the assignee — rides in the
 * `atlas:` extension namespace, so a BPMN tool shows the diagram and a re-import loses nothing the
 * graph holds. What is the RECORD's, not the graph's (channel, version, status, metadata), is not
 * written: an import becomes a new draft.
 */
export async function exportBpmn(def: WorkflowDefinition): Promise<string> {
  const m = newModdle();
  const atlas = (type: string, props: Props) => m.create(`atlas:${type}`, props);
  const ext = (values: ModdleObject[]) =>
    values.length ? m.create('bpmn:ExtensionElements', { values }) : undefined;
  const mappings = (direction: 'in' | 'out', map: DataMapping | undefined, prefix = '') =>
    Object.entries(map ?? {}).map(([target, source]) =>
      atlas('Mapping', { direction, target: prefix + target, source }),
    );
  const io = (parts: ModdleObject[]) => (parts.length ? [atlas('Io', { mappings: parts })] : []);

  // Retry, timeout and the error path are any step's (EP-22.9: a waiting step times out to its
  // onError), so they are written for every kind rather than per kind.
  const policy = (s: Step): ModdleObject[] => [
    ...(s.retry
      ? [
          atlas('Retry', {
            maxAttempts: s.retry.maxAttempts,
            backoffType: s.retry.backoff?.type,
            initial: s.retry.backoff?.initial,
            max: s.retry.backoff?.max,
            factor: s.retry.backoff?.factor,
          }),
        ]
      : []),
    ...(s.timeout ? [atlas('Timeout', { after: s.timeout })] : []),
    ...(s.onError !== undefined || s.compensation !== undefined
      ? [
          atlas('OnError', {
            mode: typeof s.onError === 'object' ? 'transition' : s.onError,
            transitionTo: typeof s.onError === 'object' ? s.onError.transitionTo : undefined,
            compensation: s.compensation,
          }),
        ]
      : []),
  ];

  const nodes = new Map<string, ModdleObject>();
  for (const s of def.steps) {
    const base = { id: toBpmnId(s.id), name: s.name };
    const el = (type: string, values: ModdleObject[], props: Props = {}) =>
      m.create(type, { ...base, ...props, extensionElements: ext([...values, ...policy(s)]) });
    switch (s.kind) {
      case 'start': {
        const c = (s.config ?? {}) as StartConfig;
        // A trigger's output (EP-22.7) rides as the start's out-mappings, as every step's does.
        nodes.set(
          s.id,
          el(
            'bpmn:StartEvent',
            c.trigger
              ? [
                  atlas('Trigger', { event: c.trigger.event, filter: c.trigger.filter }),
                  ...io(mappings('out', c.trigger.output)),
                ]
              : [],
            c.trigger ? { eventDefinitions: [m.create('bpmn:MessageEventDefinition', {})] } : {},
          ),
        );
        break;
      }
      case 'end': {
        const c = (s.config ?? {}) as EndConfig;
        nodes.set(
          s.id,
          el(
            'bpmn:EndEvent',
            c.status !== undefined || c.terminate !== undefined
              ? [atlas('End', { status: c.status, terminate: c.terminate })]
              : [],
            c.terminate
              ? { eventDefinitions: [m.create('bpmn:TerminateEventDefinition', {})] }
              : {},
          ),
        );
        break;
      }
      case 'command': {
        const c = s.config as CommandConfig;
        nodes.set(
          s.id,
          el('bpmn:ServiceTask', [
            atlas('Command', { action: c.action, event: c.request.event }),
            ...(c.await
              ? [atlas('Await', { event: c.await.event, correlate: c.await.correlate })]
              : []),
            ...io([
              ...mappings('in', c.request.input, 'request.'),
              ...mappings('out', c.await?.output),
            ]),
          ]),
        );
        break;
      }
      case 'human-task': {
        const c = s.config as HumanTaskConfig;
        nodes.set(
          s.id,
          el('bpmn:UserTask', [
            atlas('Assignment', {
              taskType: c.taskType,
              userId: c.assignee.userId,
              role: c.assignee.role,
              expression: c.assignee.expression,
              reviewPointId: c.reviewPointId,
              dueIn: c.dueIn,
            }),
            ...(c.escalation
              ? [
                  atlas('Escalation', {
                    after: c.escalation.after,
                    action: c.escalation.action,
                    userId: c.escalation.to?.userId,
                    role: c.escalation.to?.role,
                  }),
                ]
              : []),
            ...(c.form ? [atlas('Form', { json: JSON.stringify(c.form) })] : []),
            ...io(mappings('out', c.output)),
          ]),
        );
        break;
      }
      case 'wait-event': {
        const c = s.config as WaitEventConfig;
        nodes.set(
          s.id,
          el(
            'bpmn:IntermediateCatchEvent',
            [
              atlas('Await', { event: c.event, correlate: c.correlate }),
              ...io(mappings('out', c.output)),
            ],
            { eventDefinitions: [m.create('bpmn:MessageEventDefinition', {})] },
          ),
        );
        break;
      }
      case 'timer': {
        const c = s.config as TimerConfig;
        const property =
          c.mode === 'date' ? 'timeDate' : c.mode === 'cron' ? 'timeCycle' : 'timeDuration';
        const timer = m.create('bpmn:TimerEventDefinition', {
          [property]: m.create('bpmn:FormalExpression', { body: c.value }),
        });
        nodes.set(s.id, el('bpmn:IntermediateCatchEvent', [], { eventDefinitions: [timer] }));
        break;
      }
      case 'branch':
        nodes.set(s.id, el('bpmn:ExclusiveGateway', [])); // its default flow is set below
        break;
      case 'parallel': {
        const c = (s.config ?? {}) as ParallelConfig;
        // Standard BPMN says which way a gateway goes; import reads it back rather than guessing
        // from the number of edges.
        nodes.set(
          s.id,
          el('bpmn:ParallelGateway', [], {
            gatewayDirection: c.mode === 'join' ? 'Converging' : 'Diverging',
          }),
        );
        break;
      }
      case 'sub-flow': {
        const c = s.config as SubFlowConfig;
        nodes.set(
          s.id,
          el(
            'bpmn:CallActivity',
            [
              atlas('Call', {
                workflowId: c.workflowId,
                version: c.version === undefined ? undefined : String(c.version),
              }),
              ...io([...mappings('in', c.input, 'input.'), ...mappings('out', c.output)]),
            ],
            { calledElement: toBpmnId(c.workflowId) },
          ),
        );
        break;
      }
    }
  }

  const flows = new Map<string, ModdleObject>();
  for (const t of def.transitions) {
    flows.set(
      t.id,
      m.create('bpmn:SequenceFlow', {
        id: toBpmnId(t.id),
        name: t.name,
        sourceRef: nodes.get(t.from),
        targetRef: nodes.get(t.to),
        conditionExpression: t.when
          ? m.create('bpmn:FormalExpression', { body: t.when, language: 'feel' })
          : undefined,
      }),
    );
  }
  // A branch's default is the gateway's `default` flow — BPMN's own notion of it.
  for (const s of def.steps) {
    if (s.kind !== 'branch') continue;
    const fallback =
      (s.config as BranchConfig | undefined)?.default ??
      def.transitions.find((t) => t.from === s.id && t.isDefault)?.id;
    const node = nodes.get(s.id);
    if (fallback && node && flows.has(fallback)) node['default'] = flows.get(fallback);
  }

  const process = m.create('bpmn:Process', {
    id: toBpmnId(def.id),
    name: def.name,
    isExecutable: true,
    documentation: def.description
      ? [m.create('bpmn:Documentation', { text: def.description })]
      : undefined,
    flowElements: [...nodes.values(), ...flows.values()],
    extensionElements: ext([
      ...(def.scope ? [atlas('Scope', { ...def.scope })] : []),
      ...(def.vars?.length
        ? [atlas('Vars', { vars: def.vars.map((v) => atlas('Var', varProps(v))) })]
        : []),
    ]),
  });

  const definitions = m.create('bpmn:Definitions', {
    id: `Definitions_${toBpmnId(def.id)}`,
    targetNamespace: ATLAS_NS,
    rootElements: [process],
    diagrams: [diagram(def, process, nodes, flows)],
  });

  const { xml } = await m.toXML(definitions, { format: true });
  return xml;

  function diagram(
    d: WorkflowDefinition,
    proc: ModdleObject,
    stepEls: Map<string, ModdleObject>,
    flowEls: Map<string, ModdleObject>,
  ): ModdleObject {
    const positions = placeSteps(d);
    const bounds = new Map<string, Bounds>();
    for (const s of d.steps) bounds.set(s.id, boundsOf(s.kind, positions.get(s.id)!));
    const shapes = d.steps.map((s) =>
      m.create('bpmndi:BPMNShape', {
        id: `di_${toBpmnId(s.id)}`,
        bpmnElement: stepEls.get(s.id),
        isMarkerVisible: s.kind === 'branch' ? true : undefined,
        bounds: m.create('dc:Bounds', { ...bounds.get(s.id)! }),
      }),
    );
    const edges = d.transitions.flatMap((t) => {
      const from = bounds.get(t.from);
      const to = bounds.get(t.to);
      if (!from || !to) return []; // a dangling edge is the validator's to report, not drawn
      return [
        m.create('bpmndi:BPMNEdge', {
          id: `di_${toBpmnId(t.id)}`,
          bpmnElement: flowEls.get(t.id),
          waypoint: waypoints(from, to).map((p) => m.create('dc:Point', { ...p })),
        }),
      ];
    });
    return m.create('bpmndi:BPMNDiagram', {
      id: `Diagram_${toBpmnId(d.id)}`,
      plane: m.create('bpmndi:BPMNPlane', {
        id: `Plane_${toBpmnId(d.id)}`,
        bpmnElement: proc,
        planeElement: [...shapes, ...edges],
      }),
    });
  }
}

/**
 * A var's `initial` is any JSON value; an attribute is a string. A `string` var's initial is
 * written as itself (readable in a BPMN tool), anything else as JSON — import reads it back by the
 * var's declared type.
 */
function varProps(v: VarDecl): Props {
  return {
    name: v.name,
    type: v.type,
    description: v.description,
    initial:
      v.initial === undefined
        ? undefined
        : v.type === 'string' && typeof v.initial === 'string'
          ? v.initial
          : JSON.stringify(v.initial),
  };
}
