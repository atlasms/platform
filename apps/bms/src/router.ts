// The completion router (EP-22.4; bms.md §13d): a durable consumer of every event that answers a
// command a workflow may issue (`commandAnswers()` — today `transcode.completed` and
// `transcode.failed`), delivering each answer to the step that is waiting for it.
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

import { envelopeShapeErrors, type Envelope } from '@atlas/contracts';
import { commandAnswers, WORKFLOW_COMMANDS } from '@atlas/contracts/workflow';
import type { Broker, Message, Subscription } from '@atlas/messaging';
import { ValidationError } from '@atlas/service-kit';
import { InstanceNotRunning, type InstanceRunner } from './runner.ts';
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

/** Every channel's answers to every command a workflow may issue: one durable per event type. */
export function answerPatterns(): string[] {
  const { completes, fails } = commandAnswers();
  return [...completes, ...fails].map((type) => `atlas.*.${type}`);
}

export function startCompletionRouter(options: RouterSubscriptionOptions): Subscription[] {
  return answerPatterns().map((pattern) =>
    options.broker.subscribe(
      pattern,
      async (msg: Message) => {
        try {
          options.onOutcome?.(msg.subject, await options.router.route(msg));
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
