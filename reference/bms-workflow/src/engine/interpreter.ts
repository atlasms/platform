// The generic workflow interpreter. Pure control flow over the Effects boundary — no broker/DB/
// clock/Temporal here. In production one Temporal workflow runs this (def passed as argument, so
// the instance is pinned to its version); in tests sim.ts drives it. See design §10.
import type {
  WorkflowDefinition, Step, Transition, DataMapping,
  CommandConfig, HumanTaskConfig, WaitEventConfig, TimerConfig, BranchConfig, SubFlowConfig, EndConfig, StartConfig,
} from '../types.ts';
import { feelEval } from '../feel.ts';
import type { Effects, StartContext, RunResult } from './effects.ts';
import { StepTimeout } from './effects.ts';

class WorkflowError extends Error {
  constructor(public stepId: string, public compensate: boolean, public cause?: unknown) {
    super(`workflow failed at "${stepId}"`);
  }
}

export async function runWorkflow(def: WorkflowDefinition, start: StartContext, fx: Effects): Promise<RunResult> {
  const byId = new Map(def.steps.map((s) => [s.id, s]));
  const outEdges = new Map<string, Transition[]>();
  for (const t of def.transitions) (outEdges.get(t.from) ?? outEdges.set(t.from, []).get(t.from)!).push(t);

  const vars: Record<string, unknown> = {};
  for (const v of def.vars ?? []) if (v.initial !== undefined) vars[v.name] = v.initial;
  Object.assign(vars, start.vars ?? {});
  let incoming: Record<string, unknown> = start.incoming ?? {};
  const compensations: { stepId: string; comp: string }[] = [];

  const ctx = () => ({ vars, incoming, now: fx.now() });
  const singleOut = (id: string) => outEdges.get(id)?.[0]?.to;

  const startStep = def.steps.find((s) => s.kind === 'start');
  if (!startStep) return { state: 'failed', vars, error: 'no start step' };

  try {
    const end = await runPath(startStep.id, undefined);
    return { state: 'completed', endStepId: end.endStepId, status: end.status, vars };
  } catch (e) {
    if (e instanceof WorkflowError && e.compensate) {
      for (const c of [...compensations].reverse()) {
        await execStep(byId.get(c.comp)!); // the compensation handler (a command)
        fx.appendHistory(c.stepId, 'compensated');
      }
    }
    return { state: 'failed', vars, error: (e as Error).message };
  }

  // Follow the graph from `fromId` until `stopAtId` (used by parallel branches) or an end.
  async function runPath(fromId: string, stopAtId: string | undefined): Promise<{ endStepId?: string; status?: string }> {
    let cur: string | undefined = fromId;
    while (cur && cur !== stopAtId) {
      const step = byId.get(cur)!;
      const res = await execStep(step);
      if (res.kind === 'end') return { endStepId: cur, status: res.status };
      cur = res.next;
    }
    return {};
  }

  type ExecResult = { kind: 'next'; next?: string } | { kind: 'end'; status?: string };

  async function execStep(step: Step): Promise<ExecResult> {
    fx.appendHistory(step.id, 'entered');
    switch (step.kind) {
      case 'start':
        fx.appendHistory(step.id, 'completed');
        return { kind: 'next', next: singleOut(step.id) };

      case 'end': {
        const c = (step.config ?? {}) as EndConfig;
        fx.appendHistory(step.id, 'completed', c.status);
        return { kind: 'end', status: c.status };
      }

      case 'command':
        return runCommand(step);

      case 'human-task':
        await runHumanTask(step);
        return { kind: 'next', next: singleOut(step.id) };

      case 'wait-event': {
        const c = step.config as WaitEventConfig;
        fx.appendHistory(step.id, 'awaiting');
        incoming = await fx.waitForEvent(step.id, toMs(step.timeout));
        if (c.output) applyToVars(c.output);
        fx.appendHistory(step.id, 'completed');
        return { kind: 'next', next: singleOut(step.id) };
      }

      case 'timer': {
        const c = step.config as TimerConfig;
        await fx.sleep(timerMs(c));
        fx.appendHistory(step.id, 'completed');
        return { kind: 'next', next: singleOut(step.id) };
      }

      case 'branch': {
        const c = (step.config ?? {}) as BranchConfig;
        const edges = outEdges.get(step.id) ?? [];
        const chosen =
          edges.find((e) => e.when && !e.isDefault && !!feelEval(e.when, ctx())) ??
          edges.find((e) => e.id === c.default) ??
          edges.find((e) => e.isDefault);
        fx.appendHistory(step.id, 'completed', chosen?.id);
        return { kind: 'next', next: chosen?.to };
      }

      case 'parallel': {
        const c = step.config as { mode: 'split' | 'join' };
        if (c.mode === 'join') return { kind: 'next', next: singleOut(step.id) }; // reached directly; pass through
        const joinId = findJoin(step.id);
        const branches = (outEdges.get(step.id) ?? []).map((e) => e.to);
        await Promise.all(branches.map((b) => runPath(b, joinId)));
        fx.appendHistory(joinId!, 'completed');
        return { kind: 'next', next: singleOut(joinId!) };
      }

      case 'sub-flow': {
        const c = step.config as SubFlowConfig;
        const input = evalObject(c.input);
        const out = await fx.runChild(c.workflowId, c.version ?? 'latest', input);
        incoming = out;
        if (c.output) applyToVars(c.output);
        fx.appendHistory(step.id, 'completed');
        return { kind: 'next', next: singleOut(step.id) };
      }
    }
  }

  async function runCommand(step: Step): Promise<ExecResult> {
    const c = step.config as CommandConfig;
    const maxAttempts = step.retry?.maxAttempts ?? 1;
    for (let attempt = 1; ; attempt++) {
      try {
        const payload = evalObject(c.request.input);
        await fx.emitCommand({
          event: c.request.event, payload,
          correlationId: `${start.instanceId}::${step.id}:${attempt}`,
          idempotencyKey: `${start.instanceId}:${step.id}:${attempt}`,
        });
        if (c.await) {
          fx.appendHistory(step.id, 'awaiting');
          incoming = await fx.waitForCompletion(step.id, toMs(step.timeout));
          if (c.await.output) applyToVars(c.await.output);
        }
        if (step.compensation) compensations.push({ stepId: step.id, comp: step.compensation });
        fx.appendHistory(step.id, 'completed');
        return { kind: 'next', next: singleOut(step.id) };
      } catch (err) {
        if (attempt < maxAttempts) { await fx.sleep(backoffMs(step, attempt)); continue; }
        fx.appendHistory(step.id, 'failed', (err as Error).message);
        return onFailure(step, err);
      }
    }
  }

  async function runHumanTask(step: Step): Promise<void> {
    const c = step.config as HumanTaskConfig;
    const dueAt = c.dueIn ? fx.now() + toMs(c.dueIn)! : undefined;
    await fx.createTask({ instanceId: start.instanceId, stepId: step.id, taskType: c.taskType, assignee: c.assignee, reviewPointId: c.reviewPointId, dueAt });
    fx.appendHistory(step.id, 'awaiting');
    const taskP = fx.waitForTask(step.id, toMs(step.timeout));
    if (c.escalation) {
      const winner = await Promise.race([taskP.then(() => 'task' as const), fx.sleep(toMs(c.escalation.after)!).then(() => 'esc' as const)]);
      if (winner === 'esc') { fx.appendHistory(step.id, 'escalated'); await fx.escalate(step.id, c.escalation.to, c.escalation.action); }
    }
    incoming = await taskP;
    if (c.output) applyToVars(c.output);
    fx.appendHistory(step.id, 'completed');
  }

  function onFailure(step: Step, err: unknown): ExecResult {
    const oe = step.onError;
    if (oe && typeof oe === 'object') return { kind: 'next', next: oe.transitionTo };
    throw new WorkflowError(step.id, oe === 'compensate', err);
  }

  // --- mapping / expression helpers ---
  function evalObject(map?: DataMapping): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, expr] of Object.entries(map ?? {})) out[k] = feelEval(expr, ctx());
    return out;
  }
  function applyToVars(map: DataMapping): void {
    for (const [target, expr] of Object.entries(map)) {
      const path = target.replace(/^vars\./, '').split('.');
      let obj: any = vars;
      for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]] ??= {};
      obj[path[path.length - 1]] = feelEval(expr, ctx());
    }
  }
  function findJoin(splitId: string): string | undefined {
    const seen = new Set<string>();
    let frontier = (outEdges.get(splitId) ?? []).map((e) => e.to);
    while (frontier.length) {
      const next: string[] = [];
      for (const id of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        const s = byId.get(id);
        if (s?.kind === 'parallel' && (s.config as any)?.mode === 'join') return id;
        for (const e of outEdges.get(id) ?? []) next.push(e.to);
      }
      frontier = next;
    }
    return undefined;
  }
}

// --- duration helpers ---
export function toMs(iso?: string): number | undefined {
  if (!iso) return undefined;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (!m) return 0;
  const [, d, h, mi, s] = m.map((x) => Number(x || 0));
  return ((((d * 24) + h) * 60 + mi) * 60 + s) * 1000;
}
function timerMs(c: TimerConfig): number {
  return c.mode === 'duration' ? toMs(c.value) ?? 0 : 0; // date/cron resolved by the real adapter
}
function backoffMs(step: Step, attempt: number): number {
  const b = step.retry?.backoff;
  if (!b) return 0;
  const init = toMs(b.initial) ?? 0;
  const raw = b.type === 'exponential' ? init * Math.pow(b.factor ?? 2, attempt - 1) : init;
  return b.max ? Math.min(raw, toMs(b.max) ?? raw) : raw;
}

export { WorkflowError };
