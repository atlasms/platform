// What a running instance does to the world — the bodies of its Temporal activities
// (temporal/activities.ts), written against the store so they are tested without a Temporal
// server.
//
// Every one is IDEMPOTENT, because Temporal runs an activity again after a crash, a timeout or a
// lost acknowledgement: a history entry is keyed by the instance's own sequence number, and every
// other write commits behind a deterministic key in the seen-mark table (EP-03.3) in the same
// transaction — a retry finds the key and writes nothing. What a write names (a task, a child
// instance) is a derived ULID, so a retry names the same thing. Every write goes out through the
// outbox in its transaction (AGENTS.md §5.4).

import { delta, type EventPayloads, type TaskKind } from '@atlas/contracts';
import {
  REVIEW_VERDICTS,
  WORKFLOW_COMMANDS,
  WORKFLOW_EVENTS,
  type WorkflowDefinition,
} from '@atlas/contracts/workflow';
import { Conflict, NotFound, ValidationError } from '@atlas/service-kit';
import type {
  CommandRequest,
  EventWait,
  HistoryEvent,
  RunResult,
  TaskSpec,
} from './engine/effects.ts';
import { derivedUlid } from './ids.ts';
import { answerWith, matches, signalPayload } from './event-match.ts';
import {
  afterHistory,
  assetKey,
  isTerminal,
  type BufferedEvent,
  type EventAwait,
  type Instance,
} from './instance.ts';
import { outboxRecord } from './record.ts';
import type { WorkflowStore, WorkflowTx } from './store.ts';

/** What a human step's await row records as its "command" — the event that asked for it. */
export const HUMAN_TASK = 'workflow.task.created';

/** BMS itself is the actor of what an instance does on its own. */
const SELF = { actor: { kind: 'service' as const, id: 'bms' } };

export interface BmsRuntimeOptions {
  store: WorkflowStore;
  now?: () => Date;
}

export class BmsRuntime {
  private readonly store: WorkflowStore;
  private readonly now: () => Date;

  constructor(options: BmsRuntimeOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
  }

  /** A step event: one history row (by its sequence number) and the mirror moved along. */
  async recordHistory(input: {
    instanceId: string;
    seq: number;
    stepId: string;
    event: HistoryEvent;
    result?: unknown;
  }): Promise<void> {
    await this.store.transaction(async (tx) => {
      const instance = await this.forUpdate(tx, input.instanceId);
      const appended = await tx.appendHistory({
        instanceId: instance.id,
        channelId: instance.channelId,
        seq: input.seq,
        stepId: input.stepId,
        event: input.event,
        at: this.now().toISOString(),
        ...(input.result !== undefined ? { result: input.result } : {}),
      });
      if (appended) await tx.putInstance(afterHistory(instance, input.stepId, input.event));
    });
  }

  /**
   * A command step (EP-22.4): the target service's OWN command, `workflow.step.requested` (the
   * observable record that BMS asked) and the await row the completion router answers by — one
   * transaction, through the outbox.
   *
   * The command's envelope carries a correlation id DERIVED from the instance and this activity's
   * key, so a retried activity names the same command and every visit of a step (a loop, a retry)
   * a new one; the target carries it to its answer (follow()'s rule). It is returned so the
   * workflow takes only that answer. Only a command in `WORKFLOW_COMMANDS` is issued — publish
   * refused anything else, and a definition is not trusted twice; a payload off the command's
   * schema is a ValidationError, which fails the step without retrying the activity.
   */
  async requestStep(input: {
    key: string;
    instanceId: string;
    req: CommandRequest;
  }): Promise<{ correlationId: string }> {
    const { req } = input;
    const command = WORKFLOW_COMMANDS[req.event];
    if (!command) {
      throw new ValidationError(`"${req.event}" is not a command a workflow may issue`);
    }
    const known = await this.store.instance(input.instanceId);
    if (!known) throw new NotFound(`instance ${input.instanceId}`);
    const correlationId = derivedUlid(Date.parse(known.startedAt), `command:${input.key}`);
    const at = this.now().toISOString();
    await this.store.transaction(async (tx) => {
      if (!(await tx.markSeen(input.key))) return;
      const instance = await this.forUpdate(tx, input.instanceId);
      // Built (and so validated) first: a refused payload writes nothing.
      const issued = outboxRecord(req.event, instance.channelId, req.payload, {
        ...SELF,
        correlationId,
      });
      await tx.insertAwait({
        correlationId,
        channelId: instance.channelId,
        instanceId: instance.id,
        stepId: req.stepId,
        command: req.event,
        issuedAt: at,
      });
      await tx.enqueue(
        outboxRecord(
          'workflow.step.requested',
          instance.channelId,
          {
            instanceId: instance.id,
            definitionId: instance.workflowId,
            stepId: req.stepId,
            stepKind: 'command',
            target: command.target,
            ...(instance.assetId !== undefined ? { assetId: instance.assetId } : {}),
            params: { command: req.event, input: req.payload, correlationId },
          } satisfies EventPayloads['workflow.step.requested'],
          { ...SELF, correlationId: instance.id },
        ),
      );
      await tx.enqueue(issued);
    });
    return { correlationId };
  }

  /**
   * A wait-event step (EP-22.6): an await row of the event's type holding the keys its `correlate`
   * evaluated to, which the router matches events by. The correlation id is derived, so a retry
   * writes the same row (its primary key), and returned so the workflow takes only a signal sent
   * for THIS wait — a loop's earlier visit of the step is another row.
   */
  async awaitEvent(input: {
    key: string;
    instanceId: string;
    wait: EventWait;
  }): Promise<{ correlationId: string; early?: Record<string, unknown> }> {
    const { wait } = input;
    if (!WORKFLOW_EVENTS.includes(wait.event))
      throw new ValidationError(`"${wait.event}" is not an event a workflow may wait for`);
    const instance = await this.store.instance(input.instanceId);
    if (!instance) throw new NotFound(`instance ${input.instanceId}`);
    const correlationId = derivedUlid(Date.parse(instance.startedAt), `event:${input.key}`);
    const awaited: EventAwait = {
      correlationId,
      eventType: wait.event,
      channelId: instance.channelId,
      instanceId: instance.id,
      stepId: wait.stepId,
      match: wait.match,
      issuedAt: this.now().toISOString(),
    };
    await this.store.transaction((tx) => tx.insertEventAwait(awaited));
    const early = await this.takeBuffered(instance, [awaited]);
    return { correlationId, ...(early !== undefined ? { early } : {}) };
  }

  /**
   * The event a step that has just started waiting takes from the buffer (EP-22.7, decided
   * 2026-10-17): the EARLIEST one, since its instance started, that matches one of its awaits and
   * has not already moved this instance — so a verdict that resolved one review point is not taken
   * again by the next. Taken means answered, by the same once-only update the router uses: if the
   * router got there first, its signal is on its way and nothing is returned here.
   *
   * Written before it is read (the await row) while the router writes the event before it reads
   * the awaits: of the two, at least one sees the other.
   *
   * A retried activity whose await is already answered gets that answer back again — the step is
   * still waiting for it, and the inbox takes one signal per correlation id.
   */
  private async takeBuffered(
    instance: Instance,
    awaits: EventAwait[],
  ): Promise<Record<string, unknown> | undefined> {
    const [first] = awaits;
    if (!first) return undefined;
    const answered = (await this.store.eventAwaitsFor(first.correlationId)).find(
      (a) => a.answeredBy !== undefined,
    );
    if (answered?.answeredBy !== undefined) {
      const event = await this.store.bufferedEvent(answered.answeredBy);
      return event ? signalPayload(answered, event.eventType, event.payload) : undefined;
    }
    const used = new Set(await this.store.eventsUsedBy(instance.id));
    let best: { awaited: EventAwait; event: BufferedEvent } | undefined;
    for (const awaited of awaits) {
      const events = await this.store.bufferedEvents(
        instance.channelId,
        awaited.eventType,
        instance.startedAt,
        assetKey(awaited) ?? undefined,
      );
      const event = events.find((e) => !used.has(e.messageId) && matches(awaited, e.payload));
      if (event && (!best || earlier(event, best.event))) best = { awaited, event };
    }
    if (!best) return undefined;
    const { awaited, event } = best;
    const took = await answerWith(
      this.store,
      awaited,
      {
        type: event.eventType,
        messageId: event.messageId,
        ...(event.correlationId !== undefined ? { correlationId: event.correlationId } : {}),
        payload: event.payload,
      },
      this.now().toISOString(),
    );
    return took ? signalPayload(awaited, event.eventType, event.payload) : undefined;
  }

  /**
   * A human task: `workflow.task.created`, which Notifications materializes (EP-25.1), and an await
   * row keyed by the task's id — the completion router finds the waiting step by it when the task
   * is completed (`task.updated` → `done`; EP-25.8). The id is derived, so a retry names the same
   * task, and it is returned so the workflow takes only THAT task's completion.
   *
   * A REVIEW step's task (a `reviewPointId`; EP-22.6) is resolved by MAM's verdict instead: the same
   * transaction records an event await per verdict, keyed on the instance's asset, under the task's
   * id — so the verdict is delivered as that task's outcome, and the step needs no second wait.
   */
  async createTask(input: {
    key: string;
    spec: TaskSpec;
  }): Promise<{ taskId: string; early?: Record<string, unknown> }> {
    const instance = await this.store.instance(input.spec.instanceId);
    if (!instance) throw new NotFound(`instance ${input.spec.instanceId}`);
    const { spec } = input;
    if (spec.reviewPointId !== undefined && instance.assetId === undefined)
      throw new ValidationError(
        `step "${spec.stepId}" reviews point "${spec.reviewPointId}", but the instance has no asset to review`,
      );
    const taskId = derivedUlid(Date.parse(instance.startedAt), `task:${input.key}`);
    const at = this.now().toISOString();
    const verdicts: EventAwait[] =
      spec.reviewPointId === undefined
        ? []
        : Object.keys(REVIEW_VERDICTS).map((eventType) => ({
            correlationId: taskId,
            eventType,
            channelId: instance.channelId,
            instanceId: instance.id,
            stepId: spec.stepId,
            match: { assetId: instance.assetId },
            reviewPointId: spec.reviewPointId!,
            issuedAt: at,
          }));
    await this.store.transaction(async (tx) => {
      if (!(await tx.markSeen(input.key))) return;
      await tx.insertAwait({
        correlationId: taskId,
        channelId: instance.channelId,
        instanceId: instance.id,
        stepId: spec.stepId,
        command: HUMAN_TASK,
        issuedAt: at,
      });
      for (const verdict of verdicts) await tx.insertEventAwait(verdict);
      await tx.enqueue(
        outboxRecord(
          'workflow.task.created',
          instance.channelId,
          {
            taskId,
            workflowInstanceId: instance.id,
            assignee: spec.assignee.userId ?? spec.assignee.role ?? '',
            // A role is offered to everyone who holds it, resolved when an inbox is read (EP-25.1).
            assigneeKind: spec.assignee.userId !== undefined ? 'user' : 'role',
            kind: spec.taskType as TaskKind,
            ...(instance.assetId !== undefined ? { assetId: instance.assetId } : {}),
            ...(spec.dueAt !== undefined ? { dueAt: new Date(spec.dueAt).toISOString() } : {}),
            ...(spec.reviewPointId !== undefined ? { reviewPointId: spec.reviewPointId } : {}),
          } satisfies EventPayloads['workflow.task.created'],
          { ...SELF, correlationId: instance.id },
        ),
      );
    });
    // A verdict given before the review reached this step — at ready, by MAM itself for a category
    // that needs no review, or by an editor during the transcode — resolves it now (EP-22.7).
    const early = verdicts.length > 0 ? await this.takeBuffered(instance, verdicts) : undefined;
    return { taskId, ...(early !== undefined ? { early } : {}) };
  }

  /**
   * A sub-flow: the child's instance, named by a derived ULID so a retry names the same child, and
   * its definition — the published version asked for, or the latest.
   */
  async prepareChild(input: {
    key: string;
    parentId: string;
    workflowId: string;
    version: number | 'latest';
    input: Record<string, unknown>;
  }): Promise<{ childId: string; definition: WorkflowDefinition }> {
    const parent = await this.store.instance(input.parentId);
    if (!parent) throw new NotFound(`instance ${input.parentId}`);
    const header = await this.store.get(input.workflowId);
    if (!header || header.channelId !== parent.channelId)
      throw new NotFound(`workflow ${input.workflowId}`);
    // Only an active workflow starts (EP-22.11) — a child as much as a top-level instance. Publish
    // refused a sub-flow naming one that was not; this is it being deactivated since.
    if (header.state !== 'active')
      throw new Conflict(`sub-flow workflow ${header.id} is ${header.state}, not active`);
    const version = input.version === 'latest' ? header.latestVersion : input.version;
    const published = version > 0 ? await this.store.version(header.id, version) : undefined;
    if (!published || published.status !== 'published')
      throw new Conflict(`workflow ${header.id} has no published version ${version}`);

    const child: Instance = {
      id: derivedUlid(Date.parse(parent.startedAt), `child:${input.key}`),
      channelId: parent.channelId,
      workflowId: header.id,
      version: published.version,
      parentId: parent.id,
      ...(parent.assetId !== undefined ? { assetId: parent.assetId } : {}),
      state: 'running',
      currentSteps: [],
      startedAt: this.now().toISOString(),
      startedBy: parent.startedBy,
    };
    await this.store.transaction(async (tx) => {
      if (!(await tx.insertInstance(child))) return;
      await tx.enqueue(instanceAudit(child, 1, 'workflow-instance.started', undefined));
    });
    return { childId: child.id, definition: published.definition };
  }

  /** The end: the mirror's terminal state, `workflow.completed`, and the audit record. */
  async finish(input: { instanceId: string; result: RunResult }): Promise<void> {
    await this.store.transaction(async (tx) => {
      const before = await this.forUpdate(tx, input.instanceId);
      if (isTerminal(before.state)) return; // a retried finish
      const { result } = input;
      const after: Instance = {
        ...before,
        state: result.state,
        currentSteps: [],
        endedAt: this.now().toISOString(),
        vars: result.vars,
        ...(result.endStepId !== undefined ? { endStepId: result.endStepId } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
      };
      await tx.putInstance(after);
      await tx.enqueue(
        outboxRecord(
          'workflow.completed',
          after.channelId,
          {
            instanceId: after.id,
            definitionId: after.workflowId,
            outcome: result.state,
            startedAt: after.startedAt,
            ...(after.endedAt !== undefined ? { completedAt: after.endedAt } : {}),
            ...(after.assetId !== undefined ? { assetId: after.assetId } : {}),
            ...(result.error !== undefined
              ? { error: { code: 'WORKFLOW_FAILED', message: result.error, retryable: false } }
              : {}),
          } satisfies EventPayloads['workflow.completed'],
          { ...SELF, correlationId: after.id },
        ),
      );
      await tx.enqueue(instanceAudit(after, 2, `workflow-instance.${result.state}`, before));
    });
  }

  private async forUpdate(tx: WorkflowTx, id: string): Promise<Instance> {
    const instance = await tx.instanceForUpdate(id);
    if (!instance) throw new NotFound(`instance ${id}`);
    return instance;
  }
}

/**
 * An instance's audit: revision 1 when it starts, 2 when it ends. Its steps are not each audited —
 * `workflow_step_history` is that record, append-only, and the overlay reads it (FR-BMS-6).
 */
export function instanceAudit(
  after: Instance,
  revision: number,
  action: string,
  before: Instance | undefined,
  actor: { kind: 'user' | 'service'; id: string } = SELF.actor,
): ReturnType<typeof outboxRecord> {
  return outboxRecord(
    'audit.recorded',
    after.channelId,
    {
      entityType: 'workflow-instance',
      entityId: after.id,
      revision,
      action,
      origin: { service: 'bms' },
      delta: delta(
        before as unknown as Record<string, unknown> | undefined,
        after as unknown as Record<string, unknown>,
      ),
    } satisfies EventPayloads['audit.recorded'],
    { actor, correlationId: after.id },
  );
}

/** Oldest first; the message id breaks a tie, as the store orders them. */
function earlier(a: BufferedEvent, b: BufferedEvent): boolean {
  return (
    a.occurredAt < b.occurredAt || (a.occurredAt === b.occurredAt && a.messageId < b.messageId)
  );
}
