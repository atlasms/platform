// The interpreter run in this process against the real runtime — what the tests use in place of
// Temporal. The same Effects shape as temporal/workflows.ts (an inbox per instance, deterministic
// keys, history by sequence), so what the tests prove about the service is what Temporal runs;
// what it does NOT have is durability, which is Temporal's and is tested against a real server.
import type { WorkflowDefinition } from '@atlas/contracts/workflow';
import { StepTimeout, type Effects, type RunResult, type StartContext } from './engine/effects.ts';
import { runWorkflow } from './engine/interpreter.ts';
import type { InstanceRunner } from './runner.ts';
import type { BmsRuntime } from './runtime.ts';

export interface InProcessRunner extends InstanceRunner {
  /** Resolves when the instance has ended — what a test awaits instead of polling. */
  settled(instanceId: string): Promise<RunResult>;
}

export function inProcessRunner(runtime: BmsRuntime): InProcessRunner {
  const inboxes = new Map<string, Map<string, Record<string, unknown>>>();
  const waiters = new Map<string, () => void>();
  const runs = new Map<string, Promise<RunResult>>();

  const run = (definition: WorkflowDefinition, start: StartContext): Promise<RunResult> => {
    const { instanceId } = start;
    const inbox = new Map<string, Record<string, unknown>>();
    inboxes.set(instanceId, inbox);
    let op = 0;
    const key = (): string => `${instanceId}:${++op}`;
    let seq = 0;
    const take = async (stepId: string, timeoutMs?: number): Promise<Record<string, unknown>> => {
      while (!inbox.has(stepId)) {
        const arrived = await new Promise<boolean>((resolve) => {
          waiters.set(`${instanceId}:${stepId}`, () => resolve(true));
          if (timeoutMs !== undefined) setTimeout(() => resolve(false), timeoutMs);
        });
        if (!arrived && !inbox.has(stepId)) throw new StepTimeout(stepId);
      }
      const payload = inbox.get(stepId) ?? {};
      inbox.delete(stepId);
      return payload;
    };
    const fx: Effects = {
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))),
      emitCommand: (req) => runtime.requestStep({ key: key(), instanceId, req }),
      waitForCompletion: take,
      waitForTask: take,
      waitForEvent: take,
      createTask: async (spec) => {
        await runtime.createTask({ key: key(), spec });
      },
      escalate: async () => undefined,
      runChild: async (stepId, workflowId, version, input) => {
        const { childId, definition: child } = await runtime.prepareChild({
          key: `${key()}:${stepId}`,
          parentId: instanceId,
          workflowId,
          version,
          input,
        });
        const result = await run(child, { instanceId: childId, vars: input });
        if (result.state === 'failed')
          throw new Error(result.error ?? `sub-flow ${childId} failed`);
        return result.vars;
      },
      appendHistory: (stepId, event, result) =>
        runtime.recordHistory({
          instanceId,
          seq: ++seq,
          stepId,
          event,
          ...(result !== undefined ? { result } : {}),
        }),
    };
    const done = runWorkflow(definition, start, fx).then(async (result) => {
      await runtime.finish({ instanceId, result });
      return result;
    });
    runs.set(instanceId, done);
    return done;
  };

  return {
    async start({ definition, start }) {
      if (runs.has(start.instanceId)) return;
      void run(definition, start);
    },
    async signal(instanceId, stepId, payload) {
      const inbox = inboxes.get(instanceId);
      if (!inbox) throw new Error(`instance ${instanceId} is not running here`);
      inbox.set(stepId, payload);
      waiters.get(`${instanceId}:${stepId}`)?.();
    },
    async settled(instanceId) {
      const done = runs.get(instanceId);
      if (!done) throw new Error(`instance ${instanceId} was never started here`);
      return done;
    },
  };
}
