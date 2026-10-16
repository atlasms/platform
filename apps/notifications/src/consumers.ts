// The broker side: one durable per event this service turns into an inbox item. A message it
// cannot apply is thrown to the broker — retried, then dead-lettered where scripts/dlq.mjs shows
// it — never acknowledged and lost.

import type { Broker, Message, Subscription } from '@atlas/messaging';
import type { PrincipalSource } from './principals.ts';
import type { NotificationsService } from './service.ts';

export const TASK_CREATED_PATTERN = 'atlas.*.workflow.task.created';
export const ASSET_EXPIRED_PATTERN = 'atlas.*.asset.expired';
export const TASK_RESOLVED_PATTERN = 'atlas.*.workflow.task.resolved';

export interface ConsumerOptions {
  broker: Broker;
  service: NotificationsService;
  maxAttempts?: number;
  onOutcome?: (subject: string, outcome: string) => void;
  onError?: (err: unknown, msg: Message) => void;
}

export const PERMISSIONS_CHANGED_PATTERN = 'atlas.*.permissions.changed';
export const MEMBERSHIP_CHANGED_PATTERN = 'atlas.*.group.membership.changed';

/**
 * EP-25.3: a user's grants or memberships changed, so what this replica cached about who they are
 * as an addressee is stale. BROADCAST — every replica holds its own cache, so every replica must
 * hear it (EP-03's `broadcast: true`: from now on, once, never retried). A missed one is bounded by
 * the cache's TTL.
 */
export function startPrincipalInvalidation(options: {
  broker: Broker;
  principals: PrincipalSource;
}): Subscription[] {
  const forget = async (msg: Message): Promise<void> => {
    const userId = (msg.body as { payload?: { userId?: unknown } } | undefined)?.payload?.userId;
    if (typeof userId === 'string') options.principals.forget(userId);
  };
  return [PERMISSIONS_CHANGED_PATTERN, MEMBERSHIP_CHANGED_PATTERN].map((pattern) =>
    options.broker.subscribe(pattern, forget, { broadcast: true }),
  );
}

export function startConsumers(options: ConsumerOptions): Subscription[] {
  const handle =
    (fn: (msg: Message) => Promise<string>) =>
    async (msg: Message): Promise<void> => {
      try {
        options.onOutcome?.(msg.subject, await fn(msg));
      } catch (err) {
        options.onError?.(err, msg);
        throw err;
      }
    };
  const retry = { maxAttempts: options.maxAttempts ?? 5 };
  return [
    options.broker.subscribe(
      TASK_CREATED_PATTERN,
      handle((m) => options.service.consumeTaskCreated(m)),
      retry,
    ),
    options.broker.subscribe(
      TASK_RESOLVED_PATTERN,
      handle((m) => options.service.consumeTaskResolved(m)),
      retry,
    ),
    options.broker.subscribe(
      ASSET_EXPIRED_PATTERN,
      handle((m) => options.service.consumeAssetExpired(m)),
      retry,
    ),
  ];
}
