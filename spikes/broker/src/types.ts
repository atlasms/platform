import type { Broker } from '@atlas/messaging';

/**
 * What the spike needs beyond the shipping {@link Broker} surface.
 *
 * Everything extra here is lifecycle and teardown — deliberately NOT part of `Broker`, so the
 * comparison stays honest: both candidates are exercised through exactly the interface the
 * platform actually programs against.
 */
export interface SpikeBroker extends Broker {
  readonly name: string;
  connect(): Promise<void>;
  /**
   * Declare the topology a pattern needs, WITHOUT consuming.
   *
   * Exists to keep the durability test fair. RabbitMQ needs a queue bound to the exchange before
   * a message can land anywhere; in production that is a deploy-time step, not a runtime one, so
   * a durability test that skips it would be measuring the wrong thing. For NATS this is a no-op:
   * the stream captures by subject, whether or not a consumer exists.
   */
  prepare(pattern: string): Promise<void>;
  /** Remove all streams/queues/exchanges this spike created, so runs are repeatable. */
  reset(): Promise<void>;
  close(): Promise<void>;
  /** Messages the broker gave up on after `maxAttempts` — Rabbit's DLX, NATS' advisory stream. */
  deadLettered(): Promise<number>;
}

export interface SpikeMessageBody {
  seq: number;
  /** `performance.timeOrigin + performance.now()` at publish — wall-clock, sub-ms. */
  sentAt: number;
  payload: string;
}
