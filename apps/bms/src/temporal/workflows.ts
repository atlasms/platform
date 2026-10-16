// THE Temporal workflow (bms-workflow-dsl-and-designer.md §10): one generic workflow runs every
// definition — the definition is its argument, so an instance is pinned to the version it started
// on — by giving the pure interpreter an Effects built from Temporal's primitives.
//
// This file runs in Temporal's deterministic sandbox, bundled at image build (ADR-0010 evidence 2):
// it may import only deterministic code — the interpreter, FEEL, types — never the store, the
// broker or Node's I/O. Everything that touches the world is an activity (activities.ts), and
// `Date.now()` here is the workflow's own replay-safe clock.

import {
  ActivityFailure,
  condition,
  defineSignal,
  executeChild,
  proxyActivities,
  setHandler,
  sleep,
} from '@temporalio/workflow';
import type { WorkflowDefinition } from '@atlas/contracts/workflow';
import { StepTimeout, type Effects, type RunResult, type StartContext } from '../engine/effects.ts';
import { StepInbox, type StepSignal } from '../engine/inbox.ts';
import { runWorkflow } from '../engine/interpreter.ts';
import type { BmsActivities } from './activities.ts';

/** A step's completion, task outcome or event — the API's signal, or the completion router's (EP-22.4). */
export const stepSignal = defineSignal<[StepSignal]>('step');

const act = proxyActivities<BmsActivities>({
  startToCloseTimeout: '30 seconds',
  // Retried until it succeeds: every activity is idempotent (runtime.ts), and an instance that gave
  // up on a database blip would be an instance lost.
  retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '1 minute' },
});

/**
 * An activity's own words. Temporal hands the workflow an `ActivityFailure` that says only
 * "Activity task failed", with the refusal (a payload off its schema, a command not allowed) as its
 * cause — and the interpreter records what it is given in the step's history and the instance's
 * error, where a person reads it.
 */
async function unwrapped<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (err) {
    throw err instanceof ActivityFailure && err.cause !== undefined ? err.cause : err;
  }
}

export async function atlasWorkflow(
  definition: WorkflowDefinition,
  start: StartContext,
): Promise<RunResult> {
  const { instanceId } = start;
  // Completions that arrive before their step waits are kept — a fast service must not lose a race
  // with the workflow reaching the wait — and a command step takes only its own command's answer.
  const inbox = new StepInbox();
  setHandler(stepSignal, (signal) => inbox.put(signal));

  // Deterministic keys: the n-th activity of this instance is the n-th on every replay.
  let op = 0;
  const key = (): string => `${instanceId}:${++op}`;
  let seq = 0;

  const take = async (stepId: string, timeoutMs?: number): Promise<Record<string, unknown>> => {
    const arrived =
      timeoutMs === undefined
        ? (await condition(() => inbox.has(stepId)), true)
        : await condition(() => inbox.has(stepId), timeoutMs);
    if (!arrived) throw new StepTimeout(stepId);
    return inbox.take(stepId);
  };

  const fx: Effects = {
    now: () => Date.now(),
    sleep: (ms) => sleep(ms),
    emitCommand: async (req) => {
      const { correlationId } = await unwrapped(act.requestStep({ key: key(), instanceId, req }));
      inbox.expect(req.stepId, correlationId);
    },
    waitForCompletion: take,
    waitForTask: take,
    waitForEvent: take,
    createTask: async (spec) => {
      const taskId = await unwrapped(act.createTask({ key: key(), spec }));
      // Only this task's completion completes the step (EP-25.8) — a person's signal still does.
      inbox.expect(spec.stepId, taskId);
    },
    // A notification to the escalation target is Notifications' (EP-25); the instance records the
    // escalation in its history (the interpreter's `escalated`), which the overlay shows.
    escalate: async () => undefined,
    runChild: async (stepId, workflowId, version, input) => {
      const { childId, definition: child } = await act.prepareChild({
        key: `${key()}:${stepId}`,
        parentId: instanceId,
        workflowId,
        version,
        input,
      });
      const result = await executeChild(atlasWorkflow, {
        workflowId: childId,
        args: [child, { instanceId: childId, vars: input }],
      });
      if (result.state === 'failed') throw new Error(result.error ?? `sub-flow ${childId} failed`);
      return result.vars;
    },
    appendHistory: (stepId, event, result) =>
      act.recordHistory({
        instanceId,
        seq: ++seq,
        stepId,
        event,
        ...(result !== undefined ? { result } : {}),
      }),
  };

  const result = await runWorkflow(definition, start, fx);
  await act.finish({ instanceId, result });
  return result;
}
