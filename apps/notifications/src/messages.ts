// Chat messages (EP-25.4; notifications.md §13d), decided 2026-10-18:
//
// - **Who may message whom.** With `message:send` in the channel, a person may message ANY user
//   and ANY group of their channel — member of it or not. A role is not addressable for chat (it is
//   a set of permissions, not of people one talks to). The channel is the boundary: a message is a
//   row of the sender's channel and is read only in it, so an id from elsewhere reaches nobody.
// - **Who reads a group's message.** Whoever is in the group WHEN IT IS READ — a chat room: a member
//   who joins reads its history, one who leaves no longer does. Resolved like a role's task (EP-25.3):
//   the reader's groups come from IAM at read time; IAM away, the read holds what is theirs by name
//   (sent by or to them) and says it is `partial`.
//
// Sending is one transaction: the message, its recipient rows, `message.sent` and the
// `audit.recorded` — whose delta carries the message's METADATA, not its body (notifications.md
// §10: content is private to the participants; who wrote to whom, when, is the record).

import { delta, ulid, type EventPayloads } from '@atlas/contracts';
import { canEnforce } from '@atlas/policy';
import { Forbidden, ValidationError } from '@atlas/service-kit';
import type { Caller } from './service.ts';
import type { Message, MessageRecipient } from './inbox.ts';
import type { PrincipalSource } from './principals.ts';
import { outboxRecord } from './record.ts';
import type { InboxStore } from './store.ts';
import type { ActingCaller } from './task-actions.ts';

export const MAX_BODY = 4000;
export const MAX_RECIPIENTS = 50;

export interface NewMessage {
  to: MessageRecipient[];
  body: string;
  threadId?: string;
}

export interface MessagesOptions {
  store: InboxStore;
  principals?: PrincipalSource;
  onPrincipalsUnavailable?: (err: unknown, userId: string) => void;
  now?: () => Date;
}

export class Messages {
  private readonly store: InboxStore;
  private readonly principals: PrincipalSource | undefined;
  private readonly onPrincipalsUnavailable: MessagesOptions['onPrincipalsUnavailable'];
  private readonly now: () => Date;

  constructor(options: MessagesOptions) {
    this.store = options.store;
    this.principals = options.principals;
    this.onPrincipalsUnavailable = options.onPrincipalsUnavailable;
    this.now = options.now ?? (() => new Date());
  }

  async send(caller: ActingCaller, input: NewMessage): Promise<Message> {
    const decision = canEnforce(caller.policy, 'message:send', { channelId: caller.channelId });
    if (!decision.allowed) throw new Forbidden(decision.reason ?? 'missing message:send');
    const message: Message = {
      id: ulid(),
      channelId: caller.channelId,
      from: caller.userId,
      to: input.to,
      body: input.body,
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      sentAt: this.now().toISOString(),
    };
    const chain = {
      actor: { kind: 'user' as const, id: caller.userId },
      ...(caller.correlationId !== undefined ? { correlationId: caller.correlationId } : {}),
    };
    const { body: _body, ...metadata } = message;
    await this.store.transaction(async (tx) => {
      await tx.insertMessage(message);
      await tx.enqueue(
        outboxRecord(
          'message.sent',
          message.channelId,
          {
            id: message.id,
            from: message.from,
            to: message.to,
            ...(message.threadId !== undefined ? { threadId: message.threadId } : {}),
            body: message.body,
            sentAt: message.sentAt,
          } satisfies EventPayloads['message.sent'],
          chain,
        ),
      );
      await tx.enqueue(
        outboxRecord(
          'audit.recorded',
          message.channelId,
          {
            entityType: 'message',
            entityId: message.id,
            revision: 1,
            action: 'message.sent',
            origin: { service: 'notifications' },
            delta: delta(undefined, { ...metadata }),
          } satisfies EventPayloads['audit.recorded'],
          chain,
        ),
      );
    });
    return message;
  }

  /** The caller's messages — sent, to them, to a group they are in now — newest first. */
  async list(
    caller: Caller,
    options: { after?: string; limit?: number } = {},
  ): Promise<{ items: Message[]; nextCursor?: string; partial: boolean }> {
    let groups: string[] = [];
    let partial = this.principals === undefined;
    if (this.principals) {
      try {
        groups = (await this.principals.principalsOf(caller.userId))
          .filter((p) => p.kind === 'group')
          .map((p) => p.id);
      } catch (err) {
        partial = true;
        this.onPrincipalsUnavailable?.(err, caller.userId);
      }
    }
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const items = await this.store.messagesFor(
      caller.channelId,
      { userId: caller.userId, groups },
      { ...(options.after !== undefined ? { after: options.after } : {}), limit },
    );
    const last = items[items.length - 1];
    return {
      items,
      ...(items.length === limit && last ? { nextCursor: last.id } : {}),
      partial,
    };
  }
}

/** `POST /messages`'s body, as notifications.yaml says it is. */
export function parseNewMessage(body: Record<string, unknown>): NewMessage {
  for (const key of Object.keys(body))
    if (!['to', 'body', 'threadId'].includes(key))
      throw new ValidationError(`unknown field ${key}`);
  const to = body['to'];
  if (!Array.isArray(to) || to.length === 0 || to.length > MAX_RECIPIENTS)
    throw new ValidationError(`to must list 1–${MAX_RECIPIENTS} recipients`);
  const recipients: MessageRecipient[] = [];
  const seen = new Set<string>();
  for (const r of to as unknown[]) {
    const { kind, id } = (r ?? {}) as { kind?: unknown; id?: unknown };
    if (kind === 'role')
      throw new ValidationError(
        'a role is not addressable for chat — message its people or a group',
      );
    if (
      (kind !== 'user' && kind !== 'group') ||
      typeof id !== 'string' ||
      id === '' ||
      id.length > 200
    )
      throw new ValidationError('each recipient is { kind: user | group, id }');
    const key = `${kind}:${id}`;
    if (!seen.has(key)) recipients.push({ kind, id });
    seen.add(key);
  }
  const text = body['body'];
  if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_BODY)
    throw new ValidationError(`body must be a non-empty string of at most ${MAX_BODY} characters`);
  const threadId = body['threadId'];
  if (
    threadId !== undefined &&
    (typeof threadId !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(threadId))
  )
    throw new ValidationError('threadId must be a message id');
  return { to: recipients, body: text, ...(threadId !== undefined ? { threadId } : {}) };
}
