// The read cache's cross-replica invalidation (EP-17.7).
//
// Every mutation MAM commits emits `audit.recorded` for the asset it changed — the domain event is
// optional (an internal lifecycle step, a rendition attach), the audit record is not (AGENTS.md
// §5.6). So the audit stream is the one signal that names every change, and it is what every
// replica listens to: in BROADCAST mode, because an eviction is not work to be shared but a fact
// every instance must hear, and a record published before this instance existed cannot concern a
// cache that was empty then.
//
// Nothing here throws. A message this handler cannot read is not the cache's to refuse — the sink
// consuming the same stream will — and a broadcast is not retried anyway.

import type { Envelope, EventPayloads } from '@atlas/contracts';
import type { Broker, Message, Subscription } from '@atlas/messaging';
import type { MamService } from './service.ts';

export interface CacheInvalidationOptions {
  broker: Broker;
  service: MamService;
  onEvict?: (assetId: string) => void;
}

/** Every channel's audit records — `*` is the channel token. */
export const CACHE_INVALIDATION_PATTERN = 'atlas.*.audit.recorded';

export function startCacheInvalidation(options: CacheInvalidationOptions): Subscription {
  return options.broker.subscribe(
    CACHE_INVALIDATION_PATTERN,
    async (msg: Message) => {
      const assetId = assetOf(msg);
      if (assetId === undefined) return;
      await options.service.evictCached(assetId);
      options.onEvict?.(assetId);
    },
    { broadcast: true },
  );
}

/**
 * The asset an audit record is about, when it is MAM's own record of an asset — and nothing
 * otherwise: another service's entity, or MAM's record of a FILE, names nothing this cache holds.
 */
export function assetOf(msg: Message): string | undefined {
  const body = msg.body as Partial<Envelope<Partial<EventPayloads['audit.recorded']>>> | null;
  if (!body || typeof body !== 'object' || body.type !== 'audit.recorded') return undefined;
  const payload = body.payload;
  if (!payload || payload.origin?.service !== 'mam' || payload.entityType !== 'asset') {
    return undefined;
  }
  return typeof payload.entityId === 'string' ? payload.entityId : undefined;
}

/** Every channel's configuration changes (EP-33.2). */
export const CONFIG_CHANGED_PATTERN = 'atlas.*.config.changed';

/**
 * MAM's settings cache, kept honest across replicas (EP-33.2, configuration §5 step 3): every
 * replica hears every `config.changed` and drops its settings rows when the area is MAM's. The
 * same reasoning as the read cache: BROADCAST, because each instance must hear it, not one of
 * them; not durable, because a change before this instance started cannot concern its cache; and
 * the settings cache's TTL covers what a broker outage loses.
 */
export function startSettingsInvalidation(options: {
  broker: Broker;
  service: MamService;
  onClear?: () => void;
}): Subscription {
  return options.broker.subscribe(
    CONFIG_CHANGED_PATTERN,
    async (msg: Message) => {
      if (!isMamConfigChange(msg)) return;
      options.service.onConfigChanged();
      options.onClear?.();
    },
    { broadcast: true },
  );
}

/** A `config.changed` whose area is MAM's (`mam` or `mam.<collection>`). */
export function isMamConfigChange(msg: Message): boolean {
  const body = msg.body as Partial<Envelope<Partial<EventPayloads['config.changed']>>> | null;
  if (!body || typeof body !== 'object' || body.type !== 'config.changed') return false;
  const area = body.payload?.area;
  return area === 'mam' || (typeof area === 'string' && area.startsWith('mam.'));
}
