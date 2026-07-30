// In-memory Effects driver for tests: a virtual clock plus programmable responders standing in for
// the broker, human tasks, and child workflows. Lets us prove the interpreter deterministically
// with no Temporal server.
import type { Effects, CommandRequest, TaskSpec, HistoryEvent } from './effects.ts';
import { StepTimeout } from './effects.ts';

type Decision = { action: 'complete' | 'fail' | 'timeout'; response?: Record<string, unknown> };
type CommandResponder = (event: string, attempt: number, payload: Record<string, unknown>) => Decision;

export interface SimConfig {
  commands?: Record<string, CommandResponder>;                 // by event
  events?: Record<string, Record<string, unknown>>;            // wait-event payload by stepId
  tasks?: Record<string, Record<string, unknown>>;             // auto task result by stepId
  children?: Record<string, (input: Record<string, unknown>) => Record<string, unknown>>; // by workflowId
}

export class SimDriver implements Effects {
  clock = 0;
  emitted: CommandRequest[] = [];
  tasksCreated: TaskSpec[] = [];
  escalations: { stepId: string; action: string }[] = [];
  history: { stepId: string; event: HistoryEvent; result?: unknown }[] = [];
  childCalls: { workflowId: string; input: Record<string, unknown> }[] = [];

  private decisions = new Map<string, Decision>();
  private autoTasks: Map<string, Record<string, unknown>>;
  private pendingTasks = new Map<string, (v: Record<string, unknown>) => void>();

  constructor(private cfg: SimConfig = {}) {
    this.autoTasks = new Map(Object.entries(cfg.tasks ?? {}));
  }

  now() { return this.clock; }
  sleep(ms: number): Promise<void> { this.clock += ms; return new Promise((r) => setImmediate(r)); }

  async emitCommand(req: CommandRequest): Promise<void> {
    this.emitted.push(req);
    const { stepId, attempt } = parseCorrelation(req.correlationId);
    const responder = this.cfg.commands?.[req.event];
    this.decisions.set(stepId, responder ? responder(req.event, attempt, req.payload) : { action: 'complete', response: {} });
  }
  async waitForCompletion(stepId: string): Promise<Record<string, unknown>> {
    const d = this.decisions.get(stepId) ?? { action: 'complete', response: {} };
    if (d.action === 'fail') throw new Error(`command at "${stepId}" failed`);
    if (d.action === 'timeout') throw new StepTimeout(stepId);
    return d.response ?? {};
  }

  async createTask(spec: TaskSpec): Promise<void> { this.tasksCreated.push(spec); }
  async waitForTask(stepId: string): Promise<Record<string, unknown>> {
    if (this.autoTasks.has(stepId)) return this.autoTasks.get(stepId)!;
    return new Promise((res) => this.pendingTasks.set(stepId, res));
  }
  /** Test hook: complete a task that was left pending. */
  completeTask(stepId: string, payload: Record<string, unknown>): void {
    const r = this.pendingTasks.get(stepId);
    if (r) { r(payload); this.pendingTasks.delete(stepId); } else this.autoTasks.set(stepId, payload);
  }
  async escalate(stepId: string, _to: unknown, action: string): Promise<void> { this.escalations.push({ stepId, action }); }

  async waitForEvent(stepId: string): Promise<Record<string, unknown>> { return this.cfg.events?.[stepId] ?? {}; }

  async runChild(workflowId: string, _v: number | 'latest', input: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.childCalls.push({ workflowId, input });
    return this.cfg.children?.[workflowId]?.(input) ?? {};
  }

  appendHistory(stepId: string, event: HistoryEvent, result?: unknown): void { this.history.push({ stepId, event, result }); }

  // Helpers for assertions.
  completedSteps(): string[] { return this.history.filter((h) => h.event === 'completed').map((h) => h.stepId); }
  emittedEvents(): string[] { return this.emitted.map((e) => e.event); }
}

function parseCorrelation(correlationId: string): { stepId: string; attempt: number } {
  const rest = correlationId.split('::')[1] ?? correlationId;
  const idx = rest.lastIndexOf(':');
  return { stepId: rest.slice(0, idx), attempt: Number(rest.slice(idx + 1)) };
}
