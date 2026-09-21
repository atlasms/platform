// The FileRef mirror's subscription (EP-17.8): MAM's first broker consumer.
//
// Two subjects, one handler shape each, both refusing what they cannot apply: a message that
// is not an envelope of the expected type, or one for an asset this channel does not have, is
// THROWN — the broker retries, then dead-letters it (`scripts/dlq.mjs` shows it to a person).
// Skipping would ack an event the mirror then silently lacks. Duplicates are the seen-mark's
// business inside the service, and are reported, not thrown.

import type { Broker, Message, Subscription } from '@atlas/messaging';
import type { MamService, MirrorOutcome } from './service.ts';

export interface FileMirrorOptions {
  broker: Broker;
  service: MamService;
  /** Delivery attempts before the broker dead-letters a message this mirror keeps refusing. */
  maxAttempts?: number;
  onApplied?: (subject: string) => void;
  onDuplicate?: (subject: string) => void;
  onError?: (err: unknown, msg: Message) => void;
}

/** Every channel's `transcode.completed` and `file.placed` — `*` is the channel token. */
export const FILE_MIRROR_PATTERNS = {
  transcode: 'atlas.*.transcode.completed',
  placed: 'atlas.*.file.placed',
} as const;

export function startFileMirror(options: FileMirrorOptions): Subscription[] {
  const handle =
    (apply: (msg: Message) => Promise<MirrorOutcome>) =>
    async (msg: Message): Promise<void> => {
      try {
        const outcome = await apply(msg);
        if (outcome === 'applied') options.onApplied?.(msg.subject);
        else options.onDuplicate?.(msg.subject);
      } catch (err) {
        options.onError?.(err, msg);
        throw err;
      }
    };
  const opts = { maxAttempts: options.maxAttempts ?? 5 };
  return [
    options.broker.subscribe(
      FILE_MIRROR_PATTERNS.transcode,
      handle((msg) => options.service.mirrorTranscode(msg)),
      opts,
    ),
    options.broker.subscribe(
      FILE_MIRROR_PATTERNS.placed,
      handle((msg) => options.service.mirrorPlacement(msg)),
      opts,
    ),
  ];
}
