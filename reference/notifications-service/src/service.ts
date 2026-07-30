import { ulid, type Envelope } from '../../contracts/src/index.ts';
import { idempotent, InMemorySeenStore, type Broker, type Message } from '../../messaging/src/index.ts';
import { createLogger, type Logger } from '../../service-kit/src/index.ts';
import { NotificationsStore } from './store.ts';
import type { Inbox, NotificationType } from './inbox.ts';

/**
 * Notifications vertical slice. A pure consumer that fans events out into per-user inboxes:
 * workflow.task.created (BMS) -> a task for the assignee; asset.expired (MAM) -> a "re-review due"
 * notification for the prior approver. Honors per-user, per-type preferences (opt-out).
 */
export class NotificationsService {
  private seen = new InMemorySeenStore();
  private log: Logger;

  constructor(private broker: Broker, private store: NotificationsStore) {
    this.log = createLogger('notifications');
  }

  start(): void {
    this.broker.subscribe('atlas.*.workflow.task.created', idempotent((m) => this.onTaskCreated(m), this.seen));
    this.broker.subscribe('atlas.*.asset.expired', idempotent((m) => this.onAssetExpired(m), this.seen));
  }

  private async onTaskCreated(m: Message): Promise<void> {
    const { taskId, assignee, assetId, kind, dueAt } = (m.body as Envelope).payload as any;
    this.store.addTask(assignee, { taskId, kind, assetId, dueAt, state: 'open' });
    this.log.info('task delivered', { assignee, taskId });
  }

  private async onAssetExpired(m: Message): Promise<void> {
    const { assetId, priorApprover } = (m.body as Envelope).payload as any;
    if (!priorApprover) return;
    this.raise(priorApprover, 're-review-due', assetId, `Asset ${assetId} expired — re-review required`);
  }

  private raise(userId: string, type: NotificationType, assetId: string | undefined, message: string): void {
    if (!this.store.enabled(userId, type)) return; // preference opt-out
    this.store.addNotification(userId, { id: ulid(), type, assetId, message, at: new Date().toISOString(), read: false });
    this.log.info('notification raised', { userId, type });
  }

  // --- API (what the WebSocket/HTTP edge reads) ---
  getInbox(userId: string): Inbox {
    const notifications = this.store.notifications(userId);
    return { tasks: this.store.tasks(userId), notifications, unreadCount: notifications.filter((n) => !n.read).length };
  }
  markRead(userId: string, id: string): void { this.store.markRead(userId, id); }
  completeTask(userId: string, taskId: string): void { this.store.completeTask(userId, taskId); }
  setPreference(userId: string, type: NotificationType, enabled: boolean): void { this.store.setPreference(userId, type, enabled); }
}
