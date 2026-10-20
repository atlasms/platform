import { Injectable, inject } from '@angular/core';
import { ApiClient } from './api-client.ts';
import type {
  Inbox,
  InboxTask,
  Message,
  MessagePage,
  MessageRecipient,
  Preferences,
} from './generated/notifications.types.ts';
import { NotificationsOperations as ops } from './generated/notifications.operations.ts';

/**
 * Notifications, through the gateway (EP-25.9) — the caller's OWN inbox, messages and preferences:
 * no call here names another user, because none of these routes takes one
 * (notifications.yaml). Types and operations come from `generated/`.
 */
@Injectable({ providedIn: 'root' })
export class InboxService {
  private readonly api = inject(ApiClient);

  /** Open tasks offered to the caller (by name, group or role), and their newest notifications. */
  inbox() {
    return this.api.call(ops.getInbox).as<Inbox>();
  }

  /** Take a task offered to a group or role the caller is in — first claim wins (409 after). */
  claim(id: string) {
    return this.api.call(ops.claimTask, { params: { id } }).as<InboxTask>();
  }

  /** Complete a task the caller holds. A review task is refused (409): its verdict is MAM's. */
  complete(id: string, outcome?: string) {
    return this.api
      .call(ops.completeTask, {
        params: { id },
        body: outcome !== undefined ? { outcome } : {},
      })
      .as<InboxTask>();
  }

  markRead(id: string, read: boolean) {
    return this.api.call(ops.updateNotification, { params: { id }, body: { read } }).as<void>();
  }

  messages(options: { after?: string; limit?: number } = {}) {
    return this.api.call(ops.listMessages, { query: { ...options } }).as<MessagePage>();
  }

  send(to: MessageRecipient[], body: string) {
    return this.api.call(ops.sendMessage, { body: { to, body } }).as<Message>();
  }

  preferences() {
    return this.api.call(ops.getPreferences).as<Preferences>();
  }

  /** Replace the caller's choices — a compare-and-set on the version read (409 if it moved). */
  savePreferences(version: number, types: Record<string, boolean>) {
    return this.api
      .call(ops.putPreferences, { query: { version }, body: { types } })
      .as<Preferences>();
  }
}
