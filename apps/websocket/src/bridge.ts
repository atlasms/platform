// EP-09.3 — the broker -> socket bridge.
//
// Written against @atlas/messaging's Broker INTERFACE, not a concrete broker. That is what lets
// this ship and be tested now while the real broker choice is still open (EP-03.0 spike): swapping
// the in-memory broker for NATS/RabbitMQ changes nothing here.

import type { Broker, Message } from '@atlas/messaging';
import type { ConnectionRegistry } from './registry.ts';

export interface BridgeOptions {
  broker: Broker;
  registry: ConnectionRegistry;
  /** Subjects to bridge. Defaults to everything under the Atlas namespace plus private streams. */
  patterns?: string[];
  /** Called when a permissions.changed message needs a freshly compiled policy. */
  onPermissionsChanged?: (userId: string) => Promise<void> | void;
}

export const DEFAULT_BRIDGE_PATTERNS = ['atlas.>', 'user.>'];

/**
 * Subscribe the registry to the broker.
 *
 * The bridge deliberately does NO permission filtering of its own — it hands every message to
 * the registry, which re-checks eligibility per connection. One filter, in one place, is what
 * keeps the socket from disagreeing with the API.
 */
export function startBridge(options: BridgeOptions): void {
  const { broker, registry } = options;

  for (const pattern of options.patterns ?? DEFAULT_BRIDGE_PATTERNS) {
    broker.subscribe(pattern, async (msg: Message) => {
      // A revoked grant must stop the stream without waiting for a reconnect, so this is
      // handled ahead of ordinary fan-out.
      if (msg.subject.endsWith('.permissions.changed')) {
        const body = msg.body as { userId?: string } | undefined;
        if (body?.userId !== undefined) await options.onPermissionsChanged?.(body.userId);
      }
      registry.publish(msg.subject, msg.body);
    });
  }
}
