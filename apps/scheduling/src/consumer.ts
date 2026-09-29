// The approval consumer's subscription (EP-31): Scheduling's first broker consumer.
//
// ONE pattern over every asset event, not one per type: each subscription is its own durable
// cursor, and an `asset.approved` and the `asset.updated` after it on two cursors would be applied
// in whatever order the two happened to run. The service ignores what says nothing about approval.
// A message it cannot apply is THROWN — retried, then dead-lettered — never skipped.

import type { Broker, Message, Subscription } from '@atlas/messaging';
import type { ApprovalOutcome, SchedulingService } from './service.ts';

/** Every channel's asset events — `*` is the channel token, the last `*` the action. */
export const ASSET_EVENTS_PATTERN = 'atlas.*.asset.*';

export interface ApprovalConsumerOptions {
  broker: Broker;
  service: SchedulingService;
  /** Delivery attempts before the broker dead-letters a message the consumer keeps refusing. */
  maxAttempts?: number;
  onApplied?: (subject: string) => void;
  onSkipped?: (subject: string, outcome: Exclude<ApprovalOutcome, 'applied'>) => void;
  onError?: (err: unknown, msg: Message) => void;
}

export function startApprovalConsumer(options: ApprovalConsumerOptions): Subscription {
  return options.broker.subscribe(
    ASSET_EVENTS_PATTERN,
    async (msg) => {
      try {
        const outcome = await options.service.applyAssetEvent(msg);
        if (outcome === 'applied') options.onApplied?.(msg.subject);
        else options.onSkipped?.(msg.subject, outcome);
      } catch (err) {
        options.onError?.(err, msg);
        throw err;
      }
    },
    { maxAttempts: options.maxAttempts ?? 5 },
  );
}
