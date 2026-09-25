// EP-09.3 — the broker -> socket bridge.
//
// Written against @atlas/messaging's Broker INTERFACE, not a concrete broker. That is what lets
// this ship and be tested now while the real broker choice is still open (EP-03.0 spike): swapping
// the in-memory broker for NATS/RabbitMQ changes nothing here.

import type { Envelope, EventPayloads } from '@atlas/contracts';
import { isLiveSubject, type Broker, type Message } from '@atlas/messaging';
import type { Tracer } from '@atlas/service-kit';
import type { ConnectionRegistry } from './registry.ts';

export interface BridgeOptions {
  broker: Broker;
  registry: ConnectionRegistry;
  /**
   * Tracer (EP-13.3). Omit and the bridge behaves exactly as before.
   *
   * This is the hop that completes "gateway → service → broker → consumer": the publisher captured
   * its trace context into the message when the event was CREATED, and this continues it. Without
   * it the async half of every workflow is a separate trace that nothing links to the request that
   * caused it — and the async half is where the interesting failures live.
   */
  tracer?: Tracer;
  /** Subjects to bridge. Defaults to everything under the Atlas namespace plus private streams. */
  patterns?: string[];
  /** Called when a permissions.changed message needs a freshly compiled policy. */
  onPermissionsChanged?: (userId: string) => Promise<void> | void;
  /**
   * Called after each message is fanned out, with how many connections received it.
   *
   * The fan-out ratio and delivered-per-second that websocket.md §12 asks for are only observable
   * here: the registry knows the count and throws it away, and the bridge is the one caller. A
   * zero is worth recording too — it is the difference between "nothing is being published" and
   * "everything is being published to nobody", which look identical on a delivery-only counter.
   */
  onDelivered?: (subject: string, count: number) => void;
}

/**
 * Events, private streams, and — since EP-16.4 — PROGRESS (`live.>`): a core subscription, since no
 * stream keeps `live.`, so a replica relays what arrives while it is up and nothing else.
 */
export const DEFAULT_BRIDGE_PATTERNS = ['atlas.>', 'user.>', 'live.>'];

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
      const deliver = async (): Promise<void> => {
        // A revoked grant must stop the stream without waiting for a reconnect, so this is
        // handled ahead of ordinary fan-out.
        if (msg.subject.endsWith('.permissions.changed')) {
          // The body is the ENVELOPE; the user id is in its payload. This read `body.userId` —
          // one level too high — and its test published a bare `{ userId }` so it passed. Against
          // what IAM will actually emit through `buildEnvelope`, `userId` was `undefined` and
          // this never fired: live revocation was dead for a second reason nobody knew about.
          // The generated `EventPayloads` type is what makes the level visible here.
          const envelope = msg.body as Envelope<EventPayloads['permissions.changed']> | undefined;
          const userId = envelope?.payload?.userId;
          if (userId !== undefined) await options.onPermissionsChanged?.(userId);
        }
        const delivered = registry.publish(msg.subject, msg.body);
        options.onDelivered?.(msg.subject, delivered);
      };

      // Not a span per progress tick: a bar moving twice a second is not an operation anyone
      // traces, and it would drown the ones they do.
      if (!options.tracer || isLiveSubject(msg.subject)) return deliver();
      // The SUBJECT as the span name, not the message id — a subject is a bounded set, an id is one
      // value per message. The same cardinality rule as a route template.
      return options.tracer.consumer(`consume ${msg.subject}`, msg.headers, async (span) => {
        span.setAttribute('messaging.destination.name', msg.subject);
        try {
          await deliver();
        } catch (err) {
          span.setError(err instanceof Error ? err.message : 'handler failed');
          throw err;
        } finally {
          span.end();
        }
      });
    });
  }
}
