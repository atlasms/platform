// Notifications — lifted from reference/notifications-service (EP-25.1): events become what lands
// in a person's inbox, durably, once.
//
// - `workflow.task.created` (BMS) → a TASK, offered to the user, group or role it names. One row
//   whoever it reaches: a group or a role is resolved to its people when an inbox is read (decided
//   2026-10-16; the resolution itself is EP-25.3).
// - `workflow.task.resolved` (BMS) → a workflow's task closed by MAM's verdict (EP-22.6).
// - Notifications from events — `asset.expired` and the rest — are the pipeline's (pipeline.ts).
//
// Each event is one unit of work: the seen-mark, the row, and what it announces — `task.created`
// with its `audit.recorded`, or `notification.raised` — commit together (AGENTS.md §5.4), so a
// redelivery writes nothing twice and a crash is a retry. A message this service cannot apply (not
// an envelope, off its schema) is thrown to the broker, never skipped.

import {
  delta,
  envelopeShapeErrors,
  validatePayload,
  type Envelope,
  type EventPayloads,
} from '@atlas/contracts';
import type { Message } from '@atlas/messaging';
import { canEnforce, type EffectivePolicy } from '@atlas/policy';
import { Conflict, NotFound, ValidationError } from '@atlas/service-kit';
import { ALERT_AUDIENCE } from './notification-types.ts';
import { isClosed, type EntityRef, type Inbox, type Task } from './inbox.ts';
import { outboxRecord } from './record.ts';
import type { Principal, PrincipalSource } from './principals.ts';
import type { InboxStore } from './store.ts';

/** Who is reading — the gateway's caller. */
export interface Caller {
  userId: string;
  channelId: string;
}

export interface NotificationsOptions {
  store: InboxStore;
  /**
   * Who the caller is as an addressee — groups and roles, from IAM (EP-25.3). Omitted, the inbox
   * holds what is offered to the caller by name, and says it is `partial`.
   */
  principals?: PrincipalSource;
  /** Why an inbox was partial — IAM away. Never a reason to fail the read. */
  onPrincipalsUnavailable?: (err: unknown, userId: string) => void;
  /**
   * The reader's policy, from IAM — which shared notifications are theirs (an alert to `ops:read`
   * holders; EP-25.5). Omitted, an inbox holds none of them.
   */
  policyFor?: (
    userId: string,
  ) => Promise<EffectivePolicy | undefined> | EffectivePolicy | undefined;
  now?: () => Date;
}

/** The permissions a shared notification may be addressed to — today, operations'. */
const SHARED_AUDIENCES = [ALERT_AUDIENCE];

const INBOX_TASKS = 100;
const INBOX_NOTIFICATIONS = 50;

export class NotificationsService {
  private readonly store: InboxStore;
  private readonly principals: PrincipalSource | undefined;
  private readonly onPrincipalsUnavailable: NotificationsOptions['onPrincipalsUnavailable'];
  private readonly policyFor: NotificationsOptions['policyFor'];
  private readonly now: () => Date;

  constructor(options: NotificationsOptions) {
    this.store = options.store;
    this.principals = options.principals;
    this.onPrincipalsUnavailable = options.onPrincipalsUnavailable;
    this.policyFor = options.policyFor;
    this.now = options.now ?? (() => new Date());
  }

  /** The audiences of shared notifications this reader belongs to NOW — by their own policy. */
  private async audiencesOf(caller: Caller): Promise<string[]> {
    if (!this.policyFor) return [];
    const policy = await this.policyFor(caller.userId);
    if (!policy) return [];
    return SHARED_AUDIENCES.filter(
      (p) => canEnforce(policy, p, { channelId: caller.channelId }).allowed,
    );
  }

  // --- the inbox -----------------------------------------------------------------------------------

  /**
   * The caller's own inbox — any authenticated caller, nobody else's. The open tasks offered to
   * them by name, to a group they are in, or to a role they hold — resolved NOW, at read time
   * (decided 2026-10-16), so a new holder sees an open task and someone who left does not. IAM
   * away is not a failed read: the inbox holds what is theirs by name and says it is `partial`.
   */
  async inbox(caller: Caller): Promise<Inbox> {
    const principals: Principal[] = [{ kind: 'user', id: caller.userId }];
    let partial = this.principals === undefined;
    if (this.principals) {
      try {
        principals.push(...(await this.principals.principalsOf(caller.userId)));
      } catch (err) {
        partial = true;
        this.onPrincipalsUnavailable?.(err, caller.userId);
      }
    }
    const audiences = await this.audiencesOf(caller);
    const [tasks, own, unread, shared, sharedUnread] = await Promise.all([
      this.store.openTasks(caller.channelId, principals, INBOX_TASKS),
      this.store.notifications(caller.channelId, caller.userId, INBOX_NOTIFICATIONS),
      this.store.unreadCount(caller.channelId, caller.userId),
      this.store.sharedFor(caller.channelId, audiences, caller.userId, INBOX_NOTIFICATIONS),
      this.store.sharedUnread(caller.channelId, audiences, caller.userId),
    ]);
    // One list, newest first — ids are ULIDs, so by id is by time.
    const notifications = [...own, ...shared]
      .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .slice(0, INBOX_NOTIFICATIONS);
    return { tasks, notifications, unreadCount: unread + sharedUnread, partial };
  }

  /** Mark one of the caller's notifications read (or unread) — theirs only; another's is not found. */
  async markRead(caller: Caller, id: string, read: boolean): Promise<void> {
    const audiences = await this.audiencesOf(caller);
    const done = await this.store.transaction(
      async (tx) =>
        (await tx.markRead(caller.channelId, caller.userId, id, read)) ||
        // A shared one — an alert — is marked for this reader only, and only if it is theirs.
        tx.markSharedRead(caller.channelId, caller.userId, id, read, audiences),
    );
    if (!done) throw new NotFound(`notification ${id}`);
  }

  // --- consumers -------------------------------------------------------------------------------------

  /** `workflow.task.created` → a task, announced (`task.created`) and audited. */
  async consumeTaskCreated(msg: Message): Promise<'applied' | 'duplicate'> {
    const envelope = this.envelopeOf<EventPayloads['workflow.task.created']>(
      msg,
      'workflow.task.created',
    );
    const p = envelope.payload;
    const subjectRef: EntityRef | undefined =
      p.assetId !== undefined
        ? { entityType: 'asset', entityId: p.assetId }
        : p.workflowInstanceId !== undefined
          ? { entityType: 'workflowInstance', entityId: p.workflowInstanceId }
          : undefined;
    const task: Task = {
      id: p.taskId,
      channelId: envelope.channelId,
      assignee: p.assignee,
      // Before EP-25.1 BMS did not say; what it sent then was a user id or a role, and a role has
      // never been a valid `assignee` without saying so — absent is a user, as the schema says.
      assigneeKind: p.assigneeKind ?? 'user',
      kind: p.kind ?? 'generic',
      state: 'open',
      ...(subjectRef !== undefined ? { subjectRef } : {}),
      ...(p.workflowInstanceId !== undefined ? { workflowInstanceId: p.workflowInstanceId } : {}),
      ...(p.reviewPointId !== undefined ? { reviewPointId: p.reviewPointId } : {}),
      ...(p.dueAt !== undefined ? { dueAt: p.dueAt } : {}),
      createdBy: envelope.actor?.id ?? 'bms',
      createdAt: this.now().toISOString(),
      version: 1,
      participants: (p.assigneeKind ?? 'user') === 'user' ? [p.assignee] : [],
    };
    const chain = this.chainOf(envelope);

    let outcome: 'applied' | 'duplicate' = 'applied';
    await this.store.transaction(async (tx) => {
      // The seen-mark is the message; the task id is BMS's own (derived, so a retried BMS
      // activity names the same task) — either one repeating is the same task delivered again.
      if (!(await tx.markSeen(msg.id)) || !(await tx.insertTask(task))) {
        outcome = 'duplicate';
        return;
      }
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
            ...(task.workflowInstanceId !== undefined
              ? { workflowInstanceId: task.workflowInstanceId }
              : {}),
            createdAt: task.createdAt,
          } satisfies EventPayloads['task.created'],
          chain,
        ),
      );
      await tx.enqueue(
        outboxRecord(
          'audit.recorded',
          task.channelId,
          {
            entityType: 'task',
            entityId: task.id,
            revision: 1,
            action: 'task.created',
            origin: { service: 'notifications' },
            delta: delta(undefined, { ...task }),
          } satisfies EventPayloads['audit.recorded'],
          chain,
        ),
      );
    });
    return outcome;
  }

  /**
   * `workflow.task.resolved` → a workflow's task closed by something other than its completion
   * here. DONE (EP-22.6): a review step's verdict in MAM — the verdict its outcome, its author who
   * closed it (a participant from now on). CANCELLED (EP-22.9): the step timed out, or its workflow
   * failed while the task was open — closed by BMS, with why. Either is announced (`task.updated`,
   * which BMS finds already answered) and audited in one transaction.
   *
   * A task not here YET is thrown to the broker: its `workflow.task.created` rides another durable
   * and may simply be behind. One already closed is a duplicate.
   */
  async consumeTaskResolved(msg: Message): Promise<'applied' | 'duplicate' | 'skipped'> {
    const envelope = this.envelopeOf<EventPayloads['workflow.task.resolved']>(
      msg,
      'workflow.task.resolved',
    );
    const p = envelope.payload;
    const before = await this.store.task(p.taskId);
    if (!before) throw new NotFound(`task ${p.taskId} — not here yet`);
    if (before.channelId !== envelope.channelId) return 'skipped';
    if (isClosed(before)) return 'duplicate';
    const state = p.state ?? 'done';
    const after: Task = {
      ...before,
      state,
      ...(state === 'done' && p.outcome !== undefined ? { outcome: p.outcome } : {}),
      closedBy: p.by ?? 'bms',
      closedAt: p.at,
      version: before.version + 1,
      participants: [...new Set([...before.participants, ...(p.by !== undefined ? [p.by] : [])])],
    };
    const chain = this.chainOf(envelope);
    let outcome: 'applied' | 'duplicate' = 'applied';
    await this.store.transaction(async (tx) => {
      if (!(await tx.markSeen(msg.id))) {
        outcome = 'duplicate';
        return;
      }
      // Someone moved it since the read (a claim): the broker redelivers, and it is read again.
      if (!(await tx.updateTask(after, before.version)))
        throw new Conflict(`task ${before.id} changed while it was being resolved`);
      await tx.enqueue(
        outboxRecord(
          'task.updated',
          after.channelId,
          {
            id: after.id,
            state,
            ...(p.by !== undefined ? { by: p.by } : {}),
            ...(after.outcome !== undefined ? { outcome: after.outcome } : {}),
            at: p.at,
          } satisfies EventPayloads['task.updated'],
          chain,
        ),
      );
      await tx.enqueue(
        outboxRecord(
          'audit.recorded',
          after.channelId,
          {
            entityType: 'task',
            entityId: after.id,
            revision: after.version,
            action: state === 'cancelled' ? 'task.cancelled' : 'task.resolved',
            origin: { service: 'notifications' },
            delta: delta({ ...before }, { ...after }),
          } satisfies EventPayloads['audit.recorded'],
          chain,
        ),
      );
    });
    return outcome;
  }

  /** follow()'s rule (EP-03.5): the chain continues, caused by the message it answers. */
  private chainOf(envelope: Pick<Envelope, 'messageId' | 'correlationId'>) {
    return {
      actor: { kind: 'service' as const, id: 'notifications' },
      correlationId: envelope.correlationId ?? envelope.messageId,
      causationId: envelope.messageId,
    };
  }

  private envelopeOf<P extends object>(msg: Message, type: string): Envelope<P> {
    const shape = envelopeShapeErrors(msg.body);
    if (!shape.valid) {
      throw new ValidationError(`message ${msg.id} on ${msg.subject} is not an envelope`);
    }
    const envelope = msg.body as Envelope;
    if (envelope.type !== type) {
      throw new ValidationError(`message ${msg.id} is a ${envelope.type}, not a ${type}`);
    }
    const payload = validatePayload(type, envelope.payload);
    if (!payload.valid) {
      throw new ValidationError(
        `message ${msg.id} payload does not match ${type}: ${payload.errors
          .map((e) => `${e.path} ${e.message}`)
          .join('; ')}`,
      );
    }
    return envelope as Envelope<P>;
  }
}
