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
import { WORKFLOW_COMMANDS, type WorkflowDefinition } from '@atlas/contracts/workflow';
import { Conflict, NotFound, ValidationError } from '@atlas/service-kit';
import type { CommandRequest, HistoryEvent, RunResult, TaskSpec } from './engine/effects.ts';
import { derivedUlid } from './ids.ts';
import { afterHistory, isTerminal, type Instance } from './instance.ts';
import { outboxRecord } from './record.ts';
import type { WorkflowStore, WorkflowTx } from './store.ts';

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

  /** A human task: `workflow.task.created`, which Notifications materializes (EP-25.2). */
  async createTask(input: { key: string; spec: TaskSpec }): Promise<string> {
    const instance = await this.store.instance(input.spec.instanceId);
    if (!instance) throw new NotFound(`instance ${input.spec.instanceId}`);
    const taskId = derivedUlid(Date.parse(instance.startedAt), `task:${input.key}`);
    await this.store.transaction(async (tx) => {
      if (!(await tx.markSeen(input.key))) return;
      const { spec } = input;
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
          } satisfies EventPayloads['workflow.task.created'],
          { ...SELF, correlationId: instance.id },
        ),
      );
    });
    return taskId;
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
