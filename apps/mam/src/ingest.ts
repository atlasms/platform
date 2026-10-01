// The ingest subscription (EP-15.5): `ingest.accepted` becomes an asset.
//
// RIM accepted a file and placed it in HSM as the original of an asset whose id it minted; MAM
// creates that asset. A message MAM cannot apply (not an envelope, off its schema, an id already
// used in another channel) is THROWN — retried, then dead-lettered — never acked and lost.

import type { Broker, Message, Subscription } from '@atlas/messaging';
import type { MamService, MirrorOutcome } from './service.ts';

/** Every channel's `ingest.accepted` — `*` is the channel token. */
export const INGEST_ACCEPTED_PATTERN = 'atlas.*.ingest.accepted';

export interface IngestConsumerOptions {
  broker: Broker;
  service: MamService;
  maxAttempts?: number;
  onApplied?: (subject: string, outcome: MirrorOutcome) => void;
  onError?: (err: unknown, msg: Message) => void;
}

export function startIngestConsumer(options: IngestConsumerOptions): Subscription {
  return options.broker.subscribe(
    INGEST_ACCEPTED_PATTERN,
    async (msg) => {
      try {
        options.onApplied?.(msg.subject, await options.service.createFromIngest(msg));
      } catch (err) {
        options.onError?.(err, msg);
        throw err;
      }
    },
    { maxAttempts: options.maxAttempts ?? 5 },
  );
}
