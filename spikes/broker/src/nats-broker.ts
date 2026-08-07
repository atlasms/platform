// Candidate A — NATS with JetStream.
//
// JetStream (not core NATS) is the fair comparison: core NATS is fire-and-forget, which would win
// every throughput test by not offering the guarantee Atlas needs. Everything here is configured
// for at-least-once with explicit ack, matching messaging §1.2.

import {
  AckPolicy,
  DeliverPolicy,
  jetstream,
  jetstreamManager,
  RetentionPolicy,
  type Consumer,
  type ConsumerMessages,
  type JetStreamClient,
  type JetStreamManager,
} from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/nats-core';
import { connect } from '@nats-io/transport-node';
import type { Handler, Message, SubscribeOptions, Subscription } from '@atlas/messaging';
import type { SpikeBroker } from './types.ts';

const STREAM = 'ATLAS';
const DLQ_STREAM = 'ATLAS_DLQ';

export interface NatsOptions {
  servers?: string;
}

export class NatsJetStreamBroker implements SpikeBroker {
  readonly name = 'NATS JetStream';
  private nc?: NatsConnection;
  private js?: JetStreamClient;
  private jsm?: JetStreamManager;
  private readonly running: ConsumerMessages[] = [];

  private readonly options: NatsOptions;

  constructor(options: NatsOptions = {}) {
    this.options = options;
  }

  async connect(): Promise<void> {
    this.nc = await connect({ servers: this.options.servers ?? 'localhost:54222' });
    this.jsm = await jetstreamManager(this.nc);
    this.js = jetstream(this.nc);

    await this.jsm.streams.add({
      name: STREAM,
      subjects: ['atlas.>', 'user.>'],
      retention: RetentionPolicy.Limits,
      // Publish-side dedupe: a relay that crashes between publish and markSent republishes the
      // same msgID, and JetStream collapses it. This is a real advantage — the outbox's
      // at-least-once becomes effectively-once within the window, for free.
      duplicate_window: 2 * 60 * 1_000_000_000, // 2 min, in nanoseconds
    });

    // JetStream has no built-in dead-letter queue. What it has is an ADVISORY published when a
    // consumer exhausts max_deliver. Capturing those into their own stream is the idiomatic
    // reconstruction — and the fact that it must be reconstructed is itself a finding.
    await this.jsm.streams.add({
      name: DLQ_STREAM,
      subjects: ['$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>'],
      retention: RetentionPolicy.Limits,
    });
  }

  /** No-op: the stream already captures `atlas.>` regardless of consumers. */
  async prepare(): Promise<void> {}

  async publish(msg: Message): Promise<void> {
    if (!this.js) throw new Error('not connected');
    await this.js.publish(msg.subject, encode(msg.body), {
      msgID: msg.id, // <- the dedupe key
    });
  }

  subscribe(pattern: string, handler: Handler, opts: SubscribeOptions = {}): Subscription {
    const durable = durableName(pattern);
    const maxAttempts = opts.maxAttempts ?? 3;
    let messages: ConsumerMessages | undefined;
    let stopped = false;

    void (async () => {
      const jsm = this.jsm;
      const js = this.js;
      if (!jsm || !js) throw new Error('not connected');

      await jsm.consumers.add(STREAM, {
        durable_name: durable,
        filter_subject: pattern, // NATS wildcards are Atlas wildcards — no translation
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        max_deliver: maxAttempts,
        ack_wait: 5 * 1_000_000_000,
      });

      const consumer: Consumer = await js.consumers.get(STREAM, durable);
      messages = await consumer.consume();
      if (stopped) {
        messages.stop();
        return;
      }
      this.running.push(messages);

      for await (const m of messages) {
        try {
          await handler({
            id: m.headers?.get('Nats-Msg-Id') ?? String(m.seq),
            subject: m.subject,
            body: decode(m.data),
          });
          m.ack();
        } catch {
          m.nak(); // redelivered until max_deliver, then advisory -> DLQ stream
        }
      }
    })();

    return {
      unsubscribe: () => {
        stopped = true;
        messages?.stop();
      },
    };
  }

  async deadLettered(): Promise<number> {
    if (!this.jsm) return 0;
    try {
      const info = await this.jsm.streams.info(DLQ_STREAM);
      return info.state.messages;
    } catch {
      return 0;
    }
  }

  async reset(): Promise<void> {
    for (const m of this.running.splice(0)) m.stop();
    if (!this.jsm) return;
    for (const name of [STREAM, DLQ_STREAM]) {
      try {
        await this.jsm.streams.delete(name);
      } catch {
        /* absent is fine */
      }
    }
  }

  async close(): Promise<void> {
    for (const m of this.running.splice(0)) m.stop();
    await this.nc?.drain().catch(() => this.nc?.close());
  }
}

/** Durable names may not contain `.`, `*`, `>` or whitespace. */
function durableName(pattern: string): string {
  return `spike_${pattern.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const encode = (body: unknown): Uint8Array => encoder.encode(JSON.stringify(body));
const decode = (data: Uint8Array): unknown => JSON.parse(decoder.decode(data));
