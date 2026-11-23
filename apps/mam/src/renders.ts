// The render-outcome subscription (EP-26.8's backend; media-editor.md §5.1): a render that MTS
// gave up on, or refused, fails its edit project.
//
// The render's SUCCESS needs no subscription of its own: it is a `transcode.completed`, which the
// file mirror already consumes, and the mirror routes one that names an edit project to the render
// path (`renderCompleted`). Its FAILURE is a `transcode.failed`, which MAM did not consume before —
// every other failure is Notifications' to tell. A message MAM cannot apply is THROWN, retried and
// dead-lettered, never acked and lost; one that is not a render's is acknowledged (`skipped`).

import type { Broker, Message, Subscription } from '@atlas/messaging';
import type { MamService, MirrorOutcome } from './service.ts';

/** Every channel's `transcode.failed` — `*` is the channel token. */
export const TRANSCODE_FAILED_PATTERN = 'atlas.*.transcode.failed';

export interface RenderOutcomeOptions {
  broker: Broker;
  service: MamService;
  maxAttempts?: number;
  onOutcome?: (subject: string, outcome: MirrorOutcome | 'skipped') => void;
  onError?: (err: unknown, msg: Message) => void;
}

export function startRenderOutcomeConsumer(options: RenderOutcomeOptions): Subscription {
  return options.broker.subscribe(
    TRANSCODE_FAILED_PATTERN,
    async (msg) => {
      try {
        options.onOutcome?.(msg.subject, await options.service.renderFailed(msg));
      } catch (err) {
        options.onError?.(err, msg);
        throw err;
      }
    },
    { maxAttempts: options.maxAttempts ?? 5 },
  );
}
