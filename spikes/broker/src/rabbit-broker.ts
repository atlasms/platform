// Candidate B — RabbitMQ, topic exchange + durable queues.
//
// FAIRNESS NOTE: this uses a *confirm* channel and awaits the broker ack on every publish.
// JetStream's `publish()` awaits a server ack by definition, so a plain amqplib channel would
// "win" throughput purely by not waiting for the guarantee Atlas requires. Same promise, same
// measurement.

import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';
import type { Handler, Message, SubscribeOptions, Subscription } from '@atlas/messaging';
import type { SpikeBroker } from './types.ts';

const EXCHANGE = 'atlas';
const DLX = 'atlas.dlx';
const DLQ = 'atlas.dlq';

export interface RabbitOptions {
  url?: string;
}

export class RabbitMqBroker implements SpikeBroker {
  readonly name = 'RabbitMQ';
  private conn?: ChannelModel;
  private ch?: ConfirmChannel;
  private readonly queues: string[] = [];

  private readonly options: RabbitOptions;

  constructor(options: RabbitOptions = {}) {
    this.options = options;
  }

  async connect(): Promise<void> {
    this.conn = await amqp.connect(this.options.url ?? 'amqp://atlas:atlas@localhost:55672');
    this.ch = await this.conn.createConfirmChannel();
    await this.ch.assertExchange(EXCHANGE, 'topic', { durable: true });
    // Rabbit's DLQ is first-class: a queue argument, and the broker routes there itself.
    await this.ch.assertExchange(DLX, 'topic', { durable: true });
    await this.ch.assertQueue(DLQ, { durable: true });
    await this.ch.bindQueue(DLQ, DLX, '#');
  }

  /** Declare + bind the queue for `pattern` without consuming from it. */
  async prepare(pattern: string): Promise<void> {
    const ch = this.ch;
    if (!ch) throw new Error('not connected');
    const queue = queueName(pattern);
    await ch.assertQueue(queue, { durable: true, arguments: { 'x-dead-letter-exchange': DLX } });
    await ch.bindQueue(queue, EXCHANGE, toRoutingPattern(pattern));
    if (!this.queues.includes(queue)) this.queues.push(queue);
  }

  async publish(msg: Message): Promise<void> {
    const ch = this.ch;
    if (!ch) throw new Error('not connected');
    await new Promise<void>((resolve, reject) => {
      ch.publish(EXCHANGE, msg.subject, Buffer.from(JSON.stringify(msg.body)), {
        persistent: true, // written to disk before the confirm
        messageId: msg.id,
        contentType: 'application/json',
      });
      ch.waitForConfirms().then(() => resolve(), reject);
    });
  }

  subscribe(pattern: string, handler: Handler, opts: SubscribeOptions = {}): Subscription {
    const maxAttempts = opts.maxAttempts ?? 3;
    const queue = queueName(pattern);
    let tag: string | undefined;
    let cancelled = false;

    void (async () => {
      const ch = this.ch;
      if (!ch) throw new Error('not connected');

      await this.prepare(pattern);
      await ch.prefetch(64);

      // Rabbit has no server-side delivery counter that survives a nack-with-requeue, so the
      // attempt count is tracked here. That is the honest shape of the feature: JetStream counts
      // for you; with Rabbit you either count client-side or add a quorum queue's delivery-limit.
      const attempts = new Map<string, number>();

      const res = await ch.consume(queue, (raw) => {
        if (!raw) return;
        const key = raw.properties.messageId ?? String(raw.fields.deliveryTag);
        void (async () => {
          try {
            await handler({
              id: key,
              subject: raw.fields.routingKey,
              body: JSON.parse(raw.content.toString()),
            });
            attempts.delete(key);
            ch.ack(raw);
          } catch {
            const n = (attempts.get(key) ?? 0) + 1;
            attempts.set(key, n);
            if (n >= maxAttempts) {
              attempts.delete(key);
              ch.nack(raw, false, false); // no requeue -> DLX
            } else {
              ch.nack(raw, false, true); // requeue -> retry
            }
          }
        })();
      });
      tag = res.consumerTag;
      if (cancelled) await ch.cancel(tag);
    })();

    return {
      unsubscribe: () => {
        cancelled = true;
        if (tag) void this.ch?.cancel(tag);
      },
    };
  }

  async deadLettered(): Promise<number> {
    if (!this.ch) return 0;
    const q = await this.ch.checkQueue(DLQ);
    return q.messageCount;
  }

  async reset(): Promise<void> {
    const ch = this.ch;
    if (!ch) return;
    for (const q of this.queues.splice(0)) {
      await ch.deleteQueue(q).catch(() => undefined);
    }
    await ch.purgeQueue(DLQ).catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.ch?.close().catch(() => undefined);
    await this.conn?.close().catch(() => undefined);
  }
}

/**
 * Translate an Atlas subject pattern to an AMQP topic binding key.
 *
 * `*` is the same in both (exactly one word). `>` becomes `#` — and that is NOT an exact
 * translation: Atlas' `>` matches ONE-or-more trailing tokens, AMQP's `#` matches ZERO-or-more.
 * So `atlas.ch12.>` must not match `atlas.ch12`, but `atlas.ch12.#` does. The spike measures
 * whether this divergence is reachable in practice (see scenario T1).
 */
function queueName(pattern: string): string {
  return `spike.${pattern.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

export function toRoutingPattern(pattern: string): string {
  return pattern
    .split('.')
    .map((t) => (t === '>' ? '#' : t))
    .join('.');
}
