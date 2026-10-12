// The generic workflow interpreter (bms-workflow-dsl-and-designer.md §10): pure control flow over
// the Effects boundary — no broker, database, clock or Temporal here. One Temporal workflow runs
// this for every definition (the definition is its ARGUMENT, so an instance is pinned to the
// version it started on); the tests drive it with an in-memory Effects.
//
// Lifted from reference/bms-workflow/src/engine/interpreter.ts (its 7 cases pass here unchanged in
// substance). Changed on the lift: history is awaited (Effects §), a step's output is kept under
// `steps.<id>.output` so later expressions can read it (§3's `steps` root), a human task's assignee
// expression is evaluated before the task is created, and no class uses a parameter property
// (strip-only TypeScript — AGENTS.md §6).

import type {
  BranchConfig,
  CommandConfig,
  DataMapping,
  EndConfig,
  HumanTaskConfig,
  ParallelConfig,
  Step,
  SubFlowConfig,
  TimerConfig,
  Transition,
  WaitEventConfig,
  WorkflowDefinition,
} from '@atlas/contracts/workflow';
import type { Effects, RunResult, StartContext } from './effects.ts';
import { feelEval, type FeelContext } from './feel-eval.ts';

export class WorkflowError extends Error {
  readonly stepId: string;
  readonly compensate: boolean;
  constructor(stepId: string, compensate: boolean, cause?: unknown) {
    super(`workflow failed at "${stepId}"`, cause === undefined ? undefined : { cause });
    this.name = 'WorkflowError';
    this.stepId = stepId;
    this.compensate = compensate;
  }
}

// `next` undefined: no out-edge — the path ends there (a parallel branch reaching its join does).
type ExecResult = { kind: 'next'; next?: string | undefined } | { kind: 'end'; status?: string };

export async function runWorkflow(
  def: WorkflowDefinition,
  start: StartContext,
  fx: Effects,
): Promise<RunResult> {
  const byId = new Map(def.steps.map((s) => [s.id, s]));
  const outEdges = new Map<string, Transition[]>();
  for (const t of def.transitions) {
    const list = outEdges.get(t.from) ?? [];
    list.push(t);
    outEdges.set(t.from, list);
  }

  const vars: Record<string, unknown> = {};
  for (const v of def.vars ?? []) if (v.initial !== undefined) vars[v.name] = v.initial;
  Object.assign(vars, start.vars ?? {});
  let incoming: Record<string, unknown> = start.incoming ?? {};
  const steps: FeelContext['steps'] = {};
  const compensations: { stepId: string; comp: string }[] = [];

  const ctx = (): FeelContext => ({ vars, incoming, steps, instance: { id: start.instanceId } });
  const singleOut = (id: string): string | undefined => outEdges.get(id)?.[0]?.to;
  const done = async (step: Step, result?: unknown): Promise<void> => {
    steps[step.id] = { output: incoming };
    await fx.appendHistory(step.id, 'completed', result);
  };

  const startStep = def.steps.find((s) => s.kind === 'start');
  if (!startStep) return { state: 'failed', vars, error: 'no start step' };

  try {
    const end = await runPath(startStep.id, undefined);
    return {
      state: 'completed',
      ...(end.endStepId !== undefined ? { endStepId: end.endStepId } : {}),
      ...(end.status !== undefined ? { status: end.status } : {}),
      vars,
    };
  } catch (e) {
    if (e instanceof WorkflowError && e.compensate) {
      for (const c of [...compensations].reverse()) {
        const handler = byId.get(c.comp);
        if (handler) await execStep(handler);
        await fx.appendHistory(c.stepId, 'compensated');
      }
    }
    return { state: 'failed', vars, error: (e as Error).message };
  }

  /** Follow the graph from `fromId` to an end, or to `stopAtId` (a parallel branch's join). */
  async function runPath(
    fromId: string,
    stopAtId: string | undefined,
  ): Promise<{ endStepId?: string; status?: string }> {
    let cur: string | undefined = fromId;
    while (cur !== undefined && cur !== stopAtId) {
      const step = byId.get(cur);
      if (!step) throw new WorkflowError(cur, false, new Error(`no step "${cur}"`));
      const res = await execStep(step);
      if (res.kind === 'end')
        return { endStepId: cur, ...(res.status !== undefined ? { status: res.status } : {}) };
      cur = res.next;
    }
    return {};
  }

  async function execStep(step: Step): Promise<ExecResult> {
    await fx.appendHistory(step.id, 'entered');
    switch (step.kind) {
      case 'start':
        await done(step);
        return { kind: 'next', next: singleOut(step.id) };

      case 'end': {
        const c = (step.config ?? {}) as EndConfig;
        await done(step, c.status);
        return { kind: 'end', ...(c.status !== undefined ? { status: c.status } : {}) };
      }

      case 'command':
        return runCommand(step);

      case 'human-task':
        await runHumanTask(step);
        return { kind: 'next', next: singleOut(step.id) };

      case 'wait-event': {
        const c = step.config as WaitEventConfig;
        await fx.appendHistory(step.id, 'awaiting');
        incoming = await fx.waitForEvent(step.id, toMs(step.timeout));
        if (c.output) applyToVars(c.output);
        await done(step);
        return { kind: 'next', next: singleOut(step.id) };
      }

      case 'timer': {
        const c = step.config as TimerConfig;
        await fx.appendHistory(step.id, 'awaiting');
        await fx.sleep(timerMs(c, fx.now()));
        await done(step);
        return { kind: 'next', next: singleOut(step.id) };
      }

      case 'branch': {
        const c = (step.config ?? {}) as BranchConfig;
        const edges = outEdges.get(step.id) ?? [];
        const chosen =
          edges.find(
            (e) => e.when !== undefined && !e.isDefault && truthy(feelEval(e.when, ctx())),
          ) ??
          edges.find((e) => e.id === c.default) ??
          edges.find((e) => e.isDefault);
        await done(step, chosen?.id);
        return { kind: 'next', next: chosen?.to };
      }

      case 'parallel': {
        const c = step.config as ParallelConfig;
        // A join reached directly is passed through; the split below waits for its branches.
        if (c.mode === 'join') return { kind: 'next', next: singleOut(step.id) };
        const joinId = findJoin(step.id);
        const branches = (outEdges.get(step.id) ?? []).map((e) => e.to);
        await Promise.all(branches.map((b) => runPath(b, joinId)));
        if (joinId === undefined) return { kind: 'next' };
        await fx.appendHistory(joinId, 'completed');
        return { kind: 'next', next: singleOut(joinId) };
      }

      case 'sub-flow': {
        const c = step.config as SubFlowConfig;
        incoming = await fx.runChild(
          step.id,
          c.workflowId,
          c.version ?? 'latest',
          evalObject(c.input),
        );
        if (c.output) applyToVars(c.output);
        await done(step);
        return { kind: 'next', next: singleOut(step.id) };
      }
    }
  }

  async function runCommand(step: Step): Promise<ExecResult> {
    const c = step.config as CommandConfig;
    const maxAttempts = step.retry?.maxAttempts ?? 1;
    for (let attempt = 1; ; attempt++) {
      try {
        await fx.emitCommand({
          stepId: step.id,
          event: c.request.event,
          payload: evalObject(c.request.input),
          correlationId: `${start.instanceId}::${step.id}:${attempt}`,
          idempotencyKey: `${start.instanceId}:${step.id}:${attempt}`,
        });
        if (c.await) {
          await fx.appendHistory(step.id, 'awaiting');
          incoming = await fx.waitForCompletion(step.id, toMs(step.timeout));
          if (c.await.output) applyToVars(c.await.output);
        }
        if (step.compensation) compensations.push({ stepId: step.id, comp: step.compensation });
        await done(step);
        return { kind: 'next', next: singleOut(step.id) };
      } catch (err) {
        if (attempt < maxAttempts) {
          await fx.sleep(backoffMs(step, attempt));
          continue;
        }
        await fx.appendHistory(step.id, 'failed', (err as Error).message);
        return onFailure(step, err);
      }
    }
  }

  async function runHumanTask(step: Step): Promise<void> {
    const c = step.config as HumanTaskConfig;
    const due = toMs(c.dueIn);
    // The expression form names an assignee at run time; it reaches the task as a user id.
    const assignee =
      c.assignee.expression !== undefined
        ? { userId: String(feelEval(c.assignee.expression, ctx())) }
        : {
            ...(c.assignee.userId !== undefined ? { userId: c.assignee.userId } : {}),
            ...(c.assignee.role !== undefined ? { role: c.assignee.role } : {}),
          };
    await fx.createTask({
      instanceId: start.instanceId,
      stepId: step.id,
      taskType: c.taskType,
      assignee,
      ...(c.reviewPointId !== undefined ? { reviewPointId: c.reviewPointId } : {}),
      ...(due !== undefined ? { dueAt: fx.now() + due } : {}),
    });
    await fx.appendHistory(step.id, 'awaiting');
    const task = fx.waitForTask(step.id, toMs(step.timeout));
    if (c.escalation) {
      const after = toMs(c.escalation.after) ?? 0;
      const winner = await Promise.race([
        task.then(() => 'task' as const),
        fx.sleep(after).then(() => 'escalate' as const),
      ]);
      if (winner === 'escalate') {
        await fx.appendHistory(step.id, 'escalated');
        await fx.escalate(step.id, c.escalation.to, c.escalation.action);
      }
    }
    incoming = await task;
    if (c.output) applyToVars(c.output);
    await done(step);
  }

  function onFailure(step: Step, err: unknown): ExecResult {
    const oe = step.onError;
    if (oe !== undefined && typeof oe === 'object') return { kind: 'next', next: oe.transitionTo };
    throw new WorkflowError(step.id, oe === 'compensate', err);
  }

  function evalObject(map?: DataMapping): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, expr] of Object.entries(map ?? {})) out[k] = feelEval(expr, ctx());
    return out;
  }

  /** `{ "vars.a.b": "= expr" }` — every target is a dotted path into vars. */
  function applyToVars(map: DataMapping): void {
    for (const [target, expr] of Object.entries(map)) {
      const path = target.replace(/^vars\./, '').split('.');
      const last = path.pop();
      if (last === undefined) continue;
      let obj: Record<string, unknown> = vars;
      for (const key of path) {
        const next = obj[key];
        obj = (typeof next === 'object' && next !== null ? next : (obj[key] = {})) as Record<
          string,
          unknown
        >;
      }
      obj[last] = feelEval(expr, ctx());
    }
  }

  function findJoin(splitId: string): string | undefined {
    const seen = new Set<string>();
    let frontier = (outEdges.get(splitId) ?? []).map((e) => e.to);
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const id of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        const s = byId.get(id);
        if (s?.kind === 'parallel' && (s.config as ParallelConfig | undefined)?.mode === 'join')
          return id;
        for (const e of outEdges.get(id) ?? []) next.push(e.to);
      }
      frontier = next;
    }
    return undefined;
  }
}

/** FEEL's `null` and `false` do not take a branch; every other value does. */
function truthy(v: unknown): boolean {
  return v !== null && v !== undefined && v !== false;
}

/** ISO-8601 duration → ms (`PnDTnHnMnS`). Absent → undefined: no timeout. */
export function toMs(iso?: string): number | undefined {
  if (!iso) return undefined;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (!m) return 0;
  const [d, h, mi, s] = [m[1], m[2], m[3], m[4]].map((x) => Number(x ?? 0)) as [
    number,
    number,
    number,
    number,
  ];
  return (((d * 24 + h) * 60 + mi) * 60 + s) * 1000;
}

/** A timer's wait: a duration as given; a date as the time until it (never negative). */
function timerMs(c: TimerConfig, nowMs: number): number {
  if (c.mode === 'duration') return toMs(c.value) ?? 0;
  if (c.mode === 'date') return Math.max(0, Date.parse(c.value) - nowMs);
  // A cron timer needs a calendar; it is the designer's to offer once the engine has one.
  throw new WorkflowError('timer', false, new Error('cron timers are not supported yet'));
}

function backoffMs(step: Step, attempt: number): number {
  const b = step.retry?.backoff;
  if (!b) return 0;
  const init = toMs(b.initial) ?? 0;
  const raw = b.type === 'exponential' ? init * Math.pow(b.factor ?? 2, attempt - 1) : init;
  return b.max !== undefined ? Math.min(raw, toMs(b.max) ?? raw) : raw;
}
