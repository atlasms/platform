// The completion router (EP-22.4; bms.md §13d): a durable consumer of every event that answers a
// command a workflow may issue (`commandAnswers()` — today `transcode.completed` and
// `transcode.failed`), delivering each answer to the step that is waiting for it. Since EP-22.6 it
// also consumes the events a step may WAIT for (`WORKFLOW_EVENTS`; `routeEvent`, matched by keys).
//
// The step is found by the answer's correlation id: BMS issued the command under one it derived,
// recorded it as an await, and the target carried it to its answer. Every other event of those
// types — MTS's own first renditions, a transcode a person started — has no await and is
// acknowledged untouched. That is most of them, so the lookup is the whole cost.
//
// Idempotent without a seen-mark: an await is answered at most once (a conditional update), and
// the signal is matched by correlation id in the instance (StepInbox), so a redelivered answer —
// even one that reached the instance before a crash kept the update from committing — completes
// nothing twice. The signal goes FIRST: an update committed for a signal that never arrived
// would strand the step until its timeout, while a signal sent twice is harmless.

import { envelopeShapeErrors, type Envelope, type EventPayloads } from '@atlas/contracts';
import {
  commandAnswers,
  REVIEW_VERDICTS,
  WORKFLOW_COMMANDS,
  WORKFLOW_EVENTS,
} from '@atlas/contracts/workflow';
import type { Broker, Message, Subscription } from '@atlas/messaging';
import { ValidationError } from '@atlas/service-kit';
import type { EventAwait } from './instance.ts';
import { outboxRecord } from './record.ts';
import { InstanceNotRunning, type InstanceRunner } from './runner.ts';
import { HUMAN_TASK } from './runtime.ts';
import type { WorkflowStore } from './store.ts';

export type RouteOutcome =
  /** Delivered to the waiting step. */
  | 'delivered'
  /** Not an answer to any command BMS issued — most events of these types. */
  | 'ignored'
  /** Already delivered; a redelivery. */
  | 'duplicate'
  /** BMS issued it, but the instance has ended: nothing waits for it any more. */
  | 'orphaned';

export interface CompletionRouterOptions {
  store: WorkflowStore;
  runner: InstanceRunner;
  now?: () => Date;
}

export class CompletionRouter {
  private readonly store: WorkflowStore;
  private readonly runner: InstanceRunner;
  private readonly now: () => Date;

  constructor(options: CompletionRouterOptions) {
    this.store = options.store;
    this.runner = options.runner;
    this.now = options.now ?? (() => new Date());
  }

  /** An event a step waits for — {@link routeEvent}. */
  async routeEvent(msg: Message): Promise<RouteOutcome> {
    return routeEvent(this.store, this.runner, msg, this.now);
  }

  /** A task change — {@link routeTask}. */
  async routeTask(msg: Message): Promise<RouteOutcome> {
    return routeTask(this.store, this.runner, msg, this.now);
  }

  async route(msg: Message): Promise<RouteOutcome> {
    const shape = envelopeShapeErrors(msg.body);
    if (!shape.valid) {
      throw new ValidationError(`message ${msg.id} on ${msg.subject} is not an envelope`);
    }
    const envelope = msg.body as Envelope;
    if (envelope.correlationId === undefined) return 'ignored';
    const awaited = await this.store.commandAwait(envelope.correlationId);
    // Another channel's event under a correlation id that happens to be ours is not an answer.
    if (!awaited || awaited.channelId !== envelope.channelId) return 'ignored';
    const command = WORKFLOW_COMMANDS[awaited.command];
    const fails = command?.fails.includes(envelope.type) ?? false;
    if (!fails && !command?.completes.includes(envelope.type)) return 'ignored';
    if (awaited.answeredAt !== undefined) return 'duplicate';

    let outcome: RouteOutcome = 'delivered';
    try {
      await this.runner.signal(awaited.instanceId, {
        stepId: awaited.stepId,
        correlationId: awaited.correlationId,
        payload: envelope.payload,
        ...(fails ? { error: errorOf(envelope.payload) } : {}),
      });
    } catch (err) {
      if (!(err instanceof InstanceNotRunning)) throw err; // the broker redelivers
      outcome = 'orphaned';
    }
    const at = this.now().toISOString();
    const first = await this.store.transaction((tx) =>
      tx.answerAwait(awaited.correlationId, at, msg.id),
    );
    return first ? outcome : 'duplicate';
  }
}

/**
 * A human step's completion (EP-25.8): Notifications' `task.updated` with `done`, for a task BMS
 * made. Found by the TASK's id (the envelope's correlation is the person's request, not ours) —
 * the await row `createTask` wrote. A claim or a forward is not a completion; a task nobody in BMS
 * made (assigned by hand) has no await and is acknowledged untouched.
 */
export async function routeTask(
  store: WorkflowStore,
  runner: InstanceRunner,
  msg: Message,
  now: () => Date,
): Promise<RouteOutcome> {
  const shape = envelopeShapeErrors(msg.body);
  if (!shape.valid) {
    throw new ValidationError(`message ${msg.id} on ${msg.subject} is not an envelope`);
  }
  const envelope = msg.body as Envelope;
  const payload = envelope.payload as {
    id?: unknown;
    state?: unknown;
    outcome?: unknown;
    by?: unknown;
  };
  if (payload.state !== 'done' || typeof payload.id !== 'string') return 'ignored';
  const awaited = await store.commandAwait(payload.id);
  if (!awaited || awaited.channelId !== envelope.channelId || awaited.command !== HUMAN_TASK)
    return 'ignored';
  if (awaited.answeredAt !== undefined) return 'duplicate';
  let outcome: RouteOutcome = 'delivered';
  try {
    await runner.signal(awaited.instanceId, {
      stepId: awaited.stepId,
      correlationId: awaited.correlationId,
      // What a human step's `output` maps from: `= incoming.outcome`.
      payload: {
        ...(typeof payload.outcome === 'string' ? { outcome: payload.outcome } : {}),
        ...(typeof payload.by === 'string' ? { by: payload.by } : {}),
        taskId: payload.id,
      },
    });
  } catch (err) {
    if (!(err instanceof InstanceNotRunning)) throw err;
    outcome = 'orphaned';
  }
  const first = await store.transaction((tx) =>
    tx.answerAwait(awaited.correlationId, now().toISOString(), msg.id),
  );
  return first ? outcome : 'duplicate';
}

/**
 * An event a step is waiting for (EP-22.6; bms.md §13f) — one of WORKFLOW_EVENTS, which nobody sent
 * BMS as an answer. The open awaits of its type in its channel (narrowed to its asset) are matched
 * by their keys, and every one that matches is signalled and then answered once; a redelivery finds
 * them answered and is ignored.
 *
 * A review step's verdict await is a little more than a key match (decided 2026-10-16): the verdict
 * must be on the instance's asset, and it resolves the step if it names that step's review point OR
 * NAMES NONE — the asset has been decided, and MAM would refuse a second verdict. The step gets the
 * verdict as its task's outcome (`= incoming.outcome`), and the task is closed with it: the same
 * transaction answers the task's await and emits `workflow.task.resolved`, which Notifications
 * applies.
 */
export async function routeEvent(
  store: WorkflowStore,
  runner: InstanceRunner,
  msg: Message,
  now: () => Date,
): Promise<RouteOutcome> {
  const shape = envelopeShapeErrors(msg.body);
  if (!shape.valid) {
    throw new ValidationError(`message ${msg.id} on ${msg.subject} is not an envelope`);
  }
  const envelope = msg.body as Envelope;
  if (!WORKFLOW_EVENTS.includes(envelope.type)) return 'ignored';
  const payload = envelope.payload;
  const assetId = typeof payload['assetId'] === 'string' ? payload['assetId'] : undefined;
  const open = await store.openEventAwaits(envelope.channelId, envelope.type, assetId);
  const matching = open.filter((a) => matches(a, payload));
  if (matching.length === 0) return 'ignored';

  const outcomes: RouteOutcome[] = [];
  for (const awaited of matching) {
    const verdict =
      awaited.reviewPointId !== undefined ? REVIEW_VERDICTS[envelope.type] : undefined;
    const by = verdict !== undefined ? payload[verdict.by] : undefined;
    const reviewPointId =
      typeof payload['reviewPointId'] === 'string' ? payload['reviewPointId'] : undefined;
    let outcome: RouteOutcome = 'delivered';
    try {
      await runner.signal(awaited.instanceId, {
        stepId: awaited.stepId,
        correlationId: awaited.correlationId,
        payload:
          verdict !== undefined
            ? {
                outcome: verdict.outcome,
                ...(typeof by === 'string' ? { by } : {}),
                taskId: awaited.correlationId,
                ...(assetId !== undefined ? { assetId } : {}),
                ...(reviewPointId !== undefined ? { reviewPointId } : {}),
                ...(typeof payload['reason'] === 'string' ? { reason: payload['reason'] } : {}),
                ...(typeof payload['expiresAt'] === 'string'
                  ? { expiresAt: payload['expiresAt'] }
                  : {}),
              }
            : payload,
      });
    } catch (err) {
      if (!(err instanceof InstanceNotRunning)) throw err; // the broker redelivers
      outcome = 'orphaned';
    }
    const at = now().toISOString();
    const first = await store.transaction(async (tx) => {
      if (!(await tx.answerEventAwaits(awaited.correlationId, at, msg.id))) return false;
      if (verdict === undefined) return true;
      // The review's task: its await answered (Notifications' `done` for it is then a duplicate)
      // and the task closed with the verdict — even for an instance that has ended, since the
      // verdict was given all the same.
      await tx.answerAwait(awaited.correlationId, at, msg.id);
      await tx.enqueue(
        outboxRecord(
          'workflow.task.resolved',
          awaited.channelId,
          {
            taskId: awaited.correlationId,
            workflowInstanceId: awaited.instanceId,
            outcome: verdict.outcome,
            ...(typeof by === 'string' ? { by } : {}),
            ...(assetId !== undefined ? { assetId } : {}),
            ...(reviewPointId !== undefined ? { reviewPointId } : {}),
            at,
          } satisfies EventPayloads['workflow.task.resolved'],
          {
            actor: { kind: 'service', id: 'bms' },
            correlationId: envelope.correlationId ?? envelope.messageId,
            causationId: envelope.messageId,
          },
        ),
      );
      return true;
    });
    outcomes.push(first ? outcome : 'duplicate');
  }
  return outcomes.includes('delivered')
    ? 'delivered'
    : outcomes.includes('orphaned')
      ? 'orphaned'
      : 'duplicate';
}

/** Every key equal, and — for a review — the verdict naming this point or none. */
function matches(awaited: EventAwait, payload: Record<string, unknown>): boolean {
  for (const [path, value] of Object.entries(awaited.match))
    if (!sameValue(valueAt(payload, path), value)) return false;
  if (awaited.reviewPointId === undefined) return true;
  const named = payload['reviewPointId'];
  return named === undefined || named === awaited.reviewPointId;
}

function valueAt(payload: Record<string, unknown>, path: string): unknown {
  let cur: unknown = payload;
  for (const key of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** FEEL's `=` over JSON values — but a key that evaluated to null never matches anything. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function errorOf(payload: Record<string, unknown>): { code: string; message: string } {
  const error = payload['error'] as { code?: unknown; message?: unknown } | undefined;
  return {
    code: typeof error?.code === 'string' ? error.code : 'COMMAND_FAILED',
    message: typeof error?.message === 'string' ? error.message : 'the command failed',
  };
}

export interface RouterSubscriptionOptions {
  broker: Broker;
  router: CompletionRouter;
  maxAttempts?: number;
  onOutcome?: (subject: string, outcome: RouteOutcome) => void;
  onError?: (err: unknown, msg: Message) => void;
}

/** A human step's completion — Notifications' task changes (EP-25.8). */
export const TASK_UPDATED_PATTERN = 'atlas.*.task.updated';

/** The events a step may wait for (EP-22.6) — one durable per type, like the answers. */
export const eventPatterns = (): string[] => WORKFLOW_EVENTS.map((type) => `atlas.*.${type}`);

/**
 * Every channel's answers to every command a workflow may issue — one durable per event type — the
 * task changes that complete a human step, and the events a step may wait for.
 */
export function answerPatterns(): string[] {
  const { completes, fails } = commandAnswers();
  return [
    ...[...completes, ...fails].map((type) => `atlas.*.${type}`),
    TASK_UPDATED_PATTERN,
    ...eventPatterns(),
  ];
}

export function startCompletionRouter(options: RouterSubscriptionOptions): Subscription[] {
  const events = new Set(eventPatterns());
  return answerPatterns().map((pattern) =>
    options.broker.subscribe(
      pattern,
      async (msg: Message) => {
        try {
          const outcome =
            pattern === TASK_UPDATED_PATTERN
              ? await options.router.routeTask(msg)
              : events.has(pattern)
                ? await options.router.routeEvent(msg)
                : await options.router.route(msg);
          options.onOutcome?.(msg.subject, outcome);
        } catch (err) {
          // Thrown to the broker: the runtime unreachable is retried; a message that is not an
          // envelope is dead-lettered where scripts/dlq.mjs shows it.
          options.onError?.(err, msg);
          throw err;
        }
      },
      { maxAttempts: options.maxAttempts ?? 10 },
    ),
  );
}
