// Notifications — lifted from reference/notifications-service (EP-25.1): events become what lands
// in a person's inbox, durably, once.
//
// - `workflow.task.created` (BMS) → a TASK, offered to the user, group or role it names. One row
//   whoever it reaches: a group or a role is resolved to its people when an inbox is read (decided
//   2026-10-16; the resolution itself is EP-25.3).
// - `asset.expired` (MAM) → a re-review-due NOTIFICATION for the person whose approval lapsed.
//
// Each event is one unit of work: the seen-mark, the row, and what it announces — `task.created`
// with its `audit.recorded`, or `notification.raised` — commit together (AGENTS.md §5.4), so a
// redelivery writes nothing twice and a crash is a retry. A message this service cannot apply (not
// an envelope, off its schema) is thrown to the broker, never skipped.

import {
  delta,
  envelopeShapeErrors,
  ulid,
  validatePayload,
  type Envelope,
  type EventPayloads,
} from '@atlas/contracts';
import type { Message } from '@atlas/messaging';
import { ValidationError } from '@atlas/service-kit';
import type { EntityRef, Inbox, Notification, Task } from './inbox.ts';
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
  now?: () => Date;
}

const INBOX_TASKS = 100;
const INBOX_NOTIFICATIONS = 50;

export class NotificationsService {
  private readonly store: InboxStore;
  private readonly principals: PrincipalSource | undefined;
  private readonly onPrincipalsUnavailable: NotificationsOptions['onPrincipalsUnavailable'];
  private readonly now: () => Date;

  constructor(options: NotificationsOptions) {
    this.store = options.store;
    this.principals = options.principals;
    this.onPrincipalsUnavailable = options.onPrincipalsUnavailable;
    this.now = options.now ?? (() => new Date());
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
    const [tasks, notifications, unreadCount] = await Promise.all([
      this.store.openTasks(caller.channelId, principals, INBOX_TASKS),
      this.store.notifications(caller.channelId, caller.userId, INBOX_NOTIFICATIONS),
      this.store.unreadCount(caller.channelId, caller.userId),
    ]);
    return { tasks, notifications, unreadCount, partial };
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

  /** `asset.expired` → re-review due, for the person whose approval lapsed. */
  async consumeAssetExpired(msg: Message): Promise<'applied' | 'duplicate' | 'skipped'> {
    const envelope = this.envelopeOf<EventPayloads['asset.expired']>(msg, 'asset.expired');
    const { assetId, priorApprover } = envelope.payload;
    if (priorApprover === undefined) return 'skipped'; // nobody to tell
    const notification: Notification = {
      id: ulid(),
      channelId: envelope.channelId,
      userId: priorApprover,
      type: 'asset.re-review-due',
      severity: 'warning',
      subjectRef: { entityType: 'asset', entityId: assetId },
      title: 'An asset you approved has expired and needs a fresh review',
      read: false,
      createdAt: this.now().toISOString(),
    };
    let outcome: 'applied' | 'duplicate' = 'applied';
    await this.store.transaction(async (tx) => {
      if (!(await tx.markSeen(msg.id))) {
        outcome = 'duplicate';
        return;
      }
      await tx.insertNotification(notification);
      await tx.enqueue(
        outboxRecord(
          'notification.raised',
          notification.channelId,
          {
            id: notification.id,
            userId: notification.userId,
            type: notification.type,
            severity: notification.severity,
            ...(notification.subjectRef !== undefined
              ? { subjectRef: notification.subjectRef }
              : {}),
            ...(notification.title !== undefined ? { title: notification.title } : {}),
            createdAt: notification.createdAt,
          } satisfies EventPayloads['notification.raised'],
          this.chainOf(envelope),
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
