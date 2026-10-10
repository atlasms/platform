// Re-projecting the facets when a category changes (EP-28.6; data-model §2.9).
//
// An asset's facets are projected from its EFFECTIVE values, and a category's default is part of
// every asset below it that sets none of its own. So a category edit — a default, a move, a
// deprecation — changes facets the asset write path never touches. MAM hears its own
// `taxonomy.updated` and re-projects the category's subtree. Durable, so a restart resumes and a
// failure retries; idempotent by construction, since a projection is a function of what is stored
// when it runs — a redelivery writes the same rows, and a late one writes newer ones.

import type { Envelope, EventPayloads } from '@atlas/contracts';
import type { Broker, Message, Subscription } from '@atlas/messaging';
import type { MamService } from './service.ts';

/** Every channel's `taxonomy.updated` — `*` is the channel token. */
export const TAXONOMY_UPDATED_PATTERN = 'atlas.*.taxonomy.updated';

export interface FacetProjectorOptions {
  broker: Broker;
  service: MamService;
  maxAttempts?: number;
  onApplied?: (categoryId: string, reprojected: number) => void;
  onError?: (err: unknown, msg: Message) => void;
}

export function startFacetProjector(options: FacetProjectorOptions): Subscription {
  return options.broker.subscribe(
    TAXONOMY_UPDATED_PATTERN,
    async (msg) => {
      const envelope = msg.body as Envelope<EventPayloads['taxonomy.updated']>;
      // Only a category's change reaches the facets; a vocabulary term is projected by id, and a
      // rename or merge changes no id an asset holds.
      if (envelope.payload?.kind !== 'category') return;
      try {
        const { reprojected } = await options.service.reprojectCategory(
          envelope.channelId,
          envelope.payload.id,
        );
        options.onApplied?.(envelope.payload.id, reprojected);
      } catch (err) {
        options.onError?.(err, msg);
        throw err;
      }
    },
    { maxAttempts: options.maxAttempts ?? 5 },
  );
}
