// Per-user inbox: assigned tasks (from BMS) + notifications (from lifecycle events). Real delivery
// pushes these live over the WebSocket service and emits notification.raised (out of scope here);
// this slice maintains the inbox state that delivery reads.
export interface Task {
  taskId: string;
  kind?: string;
  assetId?: string;
  dueAt?: string;
  state: 'open' | 'done';
}

export type NotificationType = 're-review-due' | 'asset-rejected' | 'generic';

export interface Notification {
  id: string;
  type: NotificationType;
  assetId?: string;
  message: string;
  at: string;
  read: boolean;
}

export interface Inbox {
  tasks: Task[];
  notifications: Notification[];
  unreadCount: number;
}
