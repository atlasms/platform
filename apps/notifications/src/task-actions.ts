// What people do with tasks (EP-25.2; notifications.md §3.1) — decided 2026-10-16:
//
// - **Assign by hand** (`POST /tasks`) takes `task:assign` in the channel: a person hands work to a
//   user, a group or a role. A workflow's tasks are made by BMS (`workflow.task.created`), not here.
// - **Claim first.** A task offered to a group or a role is CLAIMED by someone who is in it — it
//   becomes theirs by name — before it is forwarded or completed, so two people never complete the
//   same one and the history says who did. First claim wins: every action is a compare-and-set on
//   the task's version, and the second is a 409.
// - **Forward** and **complete** are the holder's — the user it is assigned to by name. `task:admin`
//   may forward any task (reassign) and cancel one; a WORKFLOW's task is ended by its workflow,
//   never cancelled by hand. A workflow REVIEW task (a `reviewPointId`; EP-22.6) is not completed
//   here at all: its verdict is given in MAM, and closes it.
// - **Participants** — every user it was ever assigned to by name, who made it, claimed it or acted
//   on it — read its history without `task:audit` (the log enforces that, from these very records).
//
// Each action writes the task, `task.updated` (or `task.created`) and its `audit.recorded` delta in
// one transaction (AGENTS.md §5.4, §5.6).

import { delta, ulid, type EventPayloads } from '@atlas/contracts';
import { canEnforce, type EffectivePolicy } from '@atlas/policy';
import { Conflict, Forbidden, NotFound, Unavailable, ValidationError } from '@atlas/service-kit';
import { isClosed, type EntityRef, type PrincipalKind, type Task, type TaskKind } from './inbox.ts';
import type { PrincipalSource } from './principals.ts';
import { outboxRecord } from './record.ts';
import type { InboxStore } from './store.ts';

export interface ActingCaller {
  userId: string;
  channelId: string;
  policy: EffectivePolicy;
  correlationId?: string;
}

export interface NewTask {
  assignee: string;
  assigneeKind: PrincipalKind;
  kind?: TaskKind;
  subjectRef?: EntityRef;
  dueAt?: string;
  title?: string;
}

export interface TaskActionsOptions {
  store: InboxStore;
  /** Who the caller is as an addressee — a claim needs it. Omitted, a group/role task is unclaimable. */
  principals?: PrincipalSource;
  now?: () => Date;
}

type Change = 'claimed' | 'forwarded' | 'completed' | 'cancelled';

export class TaskActions {
  private readonly store: InboxStore;
  private readonly principals: PrincipalSource | undefined;
  private readonly now: () => Date;

  constructor(options: TaskActionsOptions) {
    this.store = options.store;
    this.principals = options.principals;
    this.now = options.now ?? (() => new Date());
  }

  /** Assign by hand — `task:assign` in the channel. */
  async create(caller: ActingCaller, input: NewTask): Promise<Task> {
    this.require(caller, 'task:assign');
    const task: Task = {
      id: ulid(),
      channelId: caller.channelId,
      assignee: input.assignee,
      assigneeKind: input.assigneeKind,
      kind: input.kind ?? 'generic',
      state: 'open',
      ...(input.subjectRef !== undefined ? { subjectRef: input.subjectRef } : {}),
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      createdBy: caller.userId,
      createdAt: this.now().toISOString(),
      version: 1,
      participants: unique([
        caller.userId,
        ...(input.assigneeKind === 'user' ? [input.assignee] : []),
      ]),
    };
    await this.store.transaction(async (tx) => {
      await tx.insertTask(task);
      await tx.enqueue(
        outboxRecord(
          'task.created',
          task.channelId,
          {
            id: task.id,
            assignee: task.assignee,
            assigneeKind: task.assigneeKind,
            kind: task.kind,
            ...(task.subjectRef !== undefined ? { subjectRef: task.subjectRef } : {}),
            ...(task.dueAt !== undefined ? { dueAt: task.dueAt } : {}),
            createdBy: task.createdBy,
            createdAt: task.createdAt,
          } satisfies EventPayloads['task.created'],
          this.chain(caller),
        ),
      );
      await tx.enqueue(this.audit(caller, undefined, task, 'task.created'));
    });
    return task;
  }

  /** One task — to a participant, a holder of what it is offered to, or `task:admin`. */
  async get(caller: ActingCaller, id: string): Promise<Task> {
    const task = await this.load(caller, id);
    if (
      task.participants.includes(caller.userId) ||
      this.allows(caller, 'task:admin') ||
      (await this.holds(caller, task))
    )
      return task;
    throw new NotFound(`task ${id}`); // not a 403: whether it exists is not theirs to learn
  }

  /** Take a task offered to a group or role you are in. First claim wins. */
  async claim(caller: ActingCaller, id: string): Promise<Task> {
    const before = await this.open(caller, id);
    if (before.assigneeKind === 'user') {
      if (before.assignee === caller.userId) return before; // already yours: the same task back
      throw new Conflict(`task ${id} is already held by someone`);
    }
    if (!(await this.holds(caller, before)))
      throw new Forbidden(`not in the ${before.assigneeKind} task ${id} is offered to`);
    return this.change(caller, before, 'claimed', {
      assignee: caller.userId,
      assigneeKind: 'user',
    });
  }

  /** Hand a task you hold to someone else — or any task, with `task:admin` (a reassignment). */
  async forward(
    caller: ActingCaller,
    id: string,
    to: { assignee: string; assigneeKind: PrincipalKind },
  ): Promise<Task> {
    const before = await this.open(caller, id);
    if (!this.allows(caller, 'task:admin')) {
      this.mustHold(caller, before);
    }
    return this.change(caller, before, 'forwarded', {
      assignee: to.assignee,
      assigneeKind: to.assigneeKind,
    });
  }

  /** Complete a task you hold, with its outcome. */
  async complete(caller: ActingCaller, id: string, outcome?: string): Promise<Task> {
    const before = await this.open(caller, id);
    this.mustHold(caller, before);
    // A review's verdict is MAM's, where `asset:approve` is checked (decided 2026-10-16): a "done,
    // approved" here would move the workflow past an asset MAM never approved.
    if (before.reviewPointId !== undefined)
      throw new Conflict(
        `task ${id} is a review: approve or reject the asset in MAM at review point "${before.reviewPointId}" — the verdict closes it`,
      );
    const at = this.now().toISOString();
    return this.change(caller, before, 'completed', {
      state: 'done',
      ...(outcome !== undefined ? { outcome } : {}),
      closedBy: caller.userId,
      closedAt: at,
    });
  }

  /** Cancel — `task:admin`. A workflow's task ends with its workflow, never by hand. */
  async cancel(caller: ActingCaller, id: string): Promise<Task> {
    this.require(caller, 'task:admin');
    const before = await this.open(caller, id);
    if (before.workflowInstanceId !== undefined)
      throw new Conflict(`task ${id} belongs to a workflow, which ends it`);
    return this.change(caller, before, 'cancelled', {
      state: 'cancelled',
      closedBy: caller.userId,
      closedAt: this.now().toISOString(),
    });
  }

  // --- the one write -----------------------------------------------------------------------------

  private async change(
    caller: ActingCaller,
    before: Task,
    change: Change,
    fields: Partial<Task>,
  ): Promise<Task> {
    const after: Task = {
      ...before,
      ...fields,
      version: before.version + 1,
      participants: unique([
        ...before.participants,
        caller.userId,
        ...(fields.assigneeKind === 'user' && fields.assignee !== undefined
          ? [fields.assignee]
          : []),
      ]),
    };
    const at = this.now().toISOString();
    await this.store.transaction(async (tx) => {
      // Compare-and-set: the second of two claims, or an action on a task someone just moved.
      if (!(await tx.updateTask(after, before.version)))
        throw new Conflict(`task ${before.id} changed under you — read it again`);
      await tx.enqueue(
        outboxRecord(
          'task.updated',
          after.channelId,
          {
            id: after.id,
            // A claim or a forward is a reassignment — `forwarded`, naming who holds it now.
            state: change === 'claimed' || change === 'forwarded' ? 'forwarded' : after.state,
            by: caller.userId,
            ...(change === 'claimed' || change === 'forwarded'
              ? { forwardedTo: after.assignee }
              : {}),
            ...(after.outcome !== undefined && change === 'completed'
              ? { outcome: after.outcome }
              : {}),
            at,
          } satisfies EventPayloads['task.updated'],
          this.chain(caller),
        ),
      );
      await tx.enqueue(this.audit(caller, before, after, `task.${change}`));
    });
    return after;
  }

  // --- who may -------------------------------------------------------------------------------------

  private async load(caller: ActingCaller, id: string): Promise<Task> {
    const task = await this.store.task(id);
    if (!task || task.channelId !== caller.channelId) throw new NotFound(`task ${id}`);
    return task;
  }

  private async open(caller: ActingCaller, id: string): Promise<Task> {
    const task = await this.load(caller, id);
    if (isClosed(task)) throw new Conflict(`task ${id} is ${task.state}`);
    return task;
  }

  /** Forward and complete are the holder's — the user it is assigned to BY NAME. Claim first. */
  private mustHold(caller: ActingCaller, task: Task): void {
    if (task.assigneeKind !== 'user')
      throw new Conflict(`task ${task.id} is offered to a ${task.assigneeKind} — claim it first`);
    if (task.assignee !== caller.userId) throw new Forbidden(`task ${task.id} is not yours`);
  }

  /** Is the caller in the group, or do they hold the role, the task is offered to — NOW? */
  private async holds(caller: ActingCaller, task: Task): Promise<boolean> {
    if (task.assigneeKind === 'user') return task.assignee === caller.userId;
    if (!this.principals) return false;
    let principals;
    try {
      principals = await this.principals.principalsOf(caller.userId);
    } catch {
      throw new Unavailable('who holds what cannot be resolved right now');
    }
    return principals.some((p) => p.kind === task.assigneeKind && p.id === task.assignee);
  }

  private allows(caller: ActingCaller, permission: string): boolean {
    return canEnforce(caller.policy, permission, { channelId: caller.channelId }).allowed;
  }

  private require(caller: ActingCaller, permission: string): void {
    const decision = canEnforce(caller.policy, permission, { channelId: caller.channelId });
    if (!decision.allowed) throw new Forbidden(decision.reason ?? `missing ${permission}`);
  }

  private chain(caller: ActingCaller) {
    return {
      actor: { kind: 'user' as const, id: caller.userId },
      ...(caller.correlationId !== undefined ? { correlationId: caller.correlationId } : {}),
    };
  }

  private audit(caller: ActingCaller, before: Task | undefined, after: Task, action: string) {
    return outboxRecord(
      'audit.recorded',
      after.channelId,
      {
        entityType: 'task',
        entityId: after.id,
        revision: after.version,
        action,
        origin: { service: 'notifications' },
        delta: delta(before ? { ...before } : undefined, { ...after }),
      } satisfies EventPayloads['audit.recorded'],
      this.chain(caller),
    );
  }
}

const unique = (xs: string[]): string[] => [...new Set(xs)];

/** Parse a `{ assignee, assigneeKind }` from a request body. */
export function parseAssignee(body: Record<string, unknown>): {
  assignee: string;
  assigneeKind: PrincipalKind;
} {
  const assignee = body['assignee'];
  const kind = body['assigneeKind'];
  if (typeof assignee !== 'string' || assignee === '')
    throw new ValidationError('assignee is required');
  if (kind !== 'user' && kind !== 'group' && kind !== 'role')
    throw new ValidationError('assigneeKind must be user, group or role');
  return { assignee, assigneeKind: kind };
}
