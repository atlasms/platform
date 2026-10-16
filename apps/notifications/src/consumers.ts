// The broker side: one durable per event this service turns into an inbox item. A message it
// cannot apply is thrown to the broker — retried, then dead-lettered where scripts/dlq.mjs shows
// it — never acknowledged and lost.

import type { Broker, Message, Subscription } from '@atlas/messaging';
import type { NotificationsService } from './service.ts';

export const TASK_CREATED_PATTERN = 'atlas.*.workflow.task.created';
export const ASSET_EXPIRED_PATTERN = 'atlas.*.asset.expired';

export interface ConsumerOptions {
  broker: Broker;
  service: NotificationsService;
  maxAttempts?: number;
  onOutcome?: (subject: string, outcome: string) => void;
  onError?: (err: unknown, msg: Message) => void;
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
      ASSET_EXPIRED_PATTERN,
      handle((m) => options.service.consumeAssetExpired(m)),
      retry,
    ),
  ];
}
