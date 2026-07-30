import type { Task, Notification, NotificationType } from './inbox.ts';

interface UserInbox { tasks: Task[]; notifications: Notification[]; prefs: Map<NotificationType, boolean>; }

export class NotificationsStore {
  private inboxes = new Map<string, UserInbox>();

  private ensure(userId: string): UserInbox {
    let i = this.inboxes.get(userId);
    if (!i) { i = { tasks: [], notifications: [], prefs: new Map() }; this.inboxes.set(userId, i); }
    return i;
  }

  addTask(userId: string, task: Task): void { this.ensure(userId).tasks.push(task); }
  completeTask(userId: string, taskId: string): void {
    const t = this.inboxes.get(userId)?.tasks.find((t) => t.taskId === taskId);
    if (t) t.state = 'done';
  }
  addNotification(userId: string, n: Notification): void { this.ensure(userId).notifications.push(n); }
  markRead(userId: string, id: string): void {
    const n = this.inboxes.get(userId)?.notifications.find((n) => n.id === id);
    if (n) n.read = true;
  }

  setPreference(userId: string, type: NotificationType, enabled: boolean): void { this.ensure(userId).prefs.set(type, enabled); }
  enabled(userId: string, type: NotificationType): boolean { return this.inboxes.get(userId)?.prefs.get(type) ?? true; } // opt-out model

  tasks(userId: string): Task[] { return this.inboxes.get(userId)?.tasks ?? []; }
  notifications(userId: string): Notification[] { return this.inboxes.get(userId)?.notifications ?? []; }
}
