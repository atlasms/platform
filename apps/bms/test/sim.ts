// An in-memory Effects for the interpreter's tests: a virtual clock and programmable responders in
// place of the broker, people and child workflows — lifted from reference/bms-workflow's sim.ts.
import {
  StepTimeout,
  type CommandRequest,
  type Effects,
  type EventWait,
  type HistoryEvent,
  type TaskSpec,
} from '../src/engine/effects.ts';

type Decision = { action: 'complete' | 'fail' | 'timeout'; response?: Record<string, unknown> };
type CommandResponder = (
  event: string,
  attempt: number,
  payload: Record<string, unknown>,
) => Decision;

export interface SimConfig {
  commands?: Record<string, CommandResponder>;
  events?: Record<string, Record<string, unknown>>;
  tasks?: Record<string, Record<string, unknown>>;
  children?: Record<string, (input: Record<string, unknown>) => Record<string, unknown>>;
}

export class SimDriver implements Effects {
  clock = 0;
  emitted: CommandRequest[] = [];
  tasksCreated: TaskSpec[] = [];
  escalations: { stepId: string; action: string }[] = [];
  history: { stepId: string; event: HistoryEvent; result?: unknown }[] = [];
  childCalls: { workflowId: string; input: Record<string, unknown> }[] = [];

  private readonly cfg: SimConfig;
  private readonly decisions = new Map<string, Decision>();
  private readonly autoTasks: Map<string, Record<string, unknown>>;
  private readonly pendingTasks = new Map<string, (v: Record<string, unknown>) => void>();

  constructor(cfg: SimConfig = {}) {
    this.cfg = cfg;
    this.autoTasks = new Map(Object.entries(cfg.tasks ?? {}));
  }

  now(): number {
    return this.clock;
  }
  sleep(ms: number): Promise<void> {
    this.clock += ms;
    return new Promise((r) => setImmediate(r));
  }
  async emitCommand(req: CommandRequest): Promise<void> {
    this.emitted.push(req);
    const attempt = Number(req.correlationId.slice(req.correlationId.lastIndexOf(':') + 1));
    const responder = this.cfg.commands?.[req.event];
    this.decisions.set(
      req.stepId,
      responder ? responder(req.event, attempt, req.payload) : { action: 'complete', response: {} },
    );
  }
  async waitForCompletion(stepId: string): Promise<Record<string, unknown>> {
    const d = this.decisions.get(stepId) ?? { action: 'complete', response: {} };
    if (d.action === 'fail') throw new Error(`command at "${stepId}" failed`);
    if (d.action === 'timeout') throw new StepTimeout(stepId);
    return d.response ?? {};
  }
  async createTask(spec: TaskSpec): Promise<void> {
    this.tasksCreated.push(spec);
  }
  async waitForTask(stepId: string): Promise<Record<string, unknown>> {
    const auto = this.autoTasks.get(stepId);
    if (auto) return auto;
    return new Promise((res) => this.pendingTasks.set(stepId, res));
  }
  /** Test hook: complete a task left pending. */
  completeTask(stepId: string, payload: Record<string, unknown>): void {
    const r = this.pendingTasks.get(stepId);
    if (r) {
      r(payload);
      this.pendingTasks.delete(stepId);
    } else this.autoTasks.set(stepId, payload);
  }
  async escalate(stepId: string, _to: unknown, action: string): Promise<void> {
    this.escalations.push({ stepId, action });
  }
  readonly eventWaits: EventWait[] = [];
  async awaitEvent(wait: EventWait): Promise<void> {
    this.eventWaits.push(wait);
  }
  readonly closed: { stepId: string; reason: string }[] = [];
  async closeTask(stepId: string, reason: string): Promise<void> {
    this.closed.push({ stepId, reason });
  }
  async closeWait(stepId: string): Promise<void> {
    this.closed.push({ stepId, reason: 'wait' });
  }
  async waitForEvent(stepId: string): Promise<Record<string, unknown>> {
    return this.cfg.events?.[stepId] ?? {};
  }
  async runChild(
    _stepId: string,
    workflowId: string,
    _v: number | 'latest',
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.childCalls.push({ workflowId, input });
    return this.cfg.children?.[workflowId]?.(input) ?? {};
  }
  async appendHistory(stepId: string, event: HistoryEvent, result?: unknown): Promise<void> {
    this.history.push({ stepId, event, ...(result !== undefined ? { result } : {}) });
  }
  completedSteps(): string[] {
    return this.history.filter((h) => h.event === 'completed').map((h) => h.stepId);
  }
  emittedEvents(): string[] {
    return this.emitted.map((e) => e.event);
  }
}
