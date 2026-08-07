// The JetStream adapter chosen in ADR-0001.
//
// Implements @atlas/messaging's `Broker` and nothing more, so a service that holds a `Broker`
// cannot tell which transport it got. Held to the shared conformance suite
// (`@atlas/messaging/conformance`), the same one the in-memory broker passes.

// The `nats` package was deprecated upstream in favour of the split @nats-io/* packages (#207).
// It is not a rename: JetStream is reached through free functions now — `jetstream(nc)` and
// `jetstreamManager(nc)` rather than methods on the connection — and the pieces live in three
// packages. The Broker interface above this file did not move, which is the point of having it.
import {
  AckPolicy,
  DeliverPolicy,
  jetstream,
  jetstreamManager,
  JetStreamApiError,
  RetentionPolicy,
  type ConsumerMessages,
  type JetStreamClient,
  type JetStreamManager,
  type JsMsg,
} from '@nats-io/jetstream';
import { headers as headersFactory, nanos, type NatsConnection } from '@nats-io/nats-core';
import { connect } from '@nats-io/transport-node';
import type { Broker, Handler, Message, SubscribeOptions, Subscription } from '@atlas/messaging';

export interface NatsBrokerOptions {
  /** e.g. `nats://localhost:4222`. */
  servers: string | string[];
  /**
   * The subscribing service's identity — `mam`, `scheduler`, `websocket`.
   *
   * This is load-bearing, not cosmetic. A JetStream durable consumer is a *shared cursor*: every
   * client attached to the same durable competes for messages. Two instances of MAM sharing one
   * durable is exactly right (work is split, each event handled once). MAM and the scheduler
   * sharing one would mean each stealing half the other's events. Durables are therefore named
   * per (service, pattern), never per pattern alone.
   */
  service: string;
  /** Stream name. One stream carries all Atlas subjects by default. */
  stream?: string;
  /** Subjects the stream captures. Must cover everything anyone publishes. */
  subjects?: string[];
  /** How long a consumer may hold a message before redelivery. Default 30s. */
  ackWaitMs?: number;
  /**
   * Publish-side dedupe window. JetStream collapses repeat `msgID`s inside it, so an outbox relay
   * that crashes between `publish()` and `markSent()` does not produce a duplicate at all.
   * Consumers still dedupe — this window is finite and is a bonus, not the guarantee.
   */
  dedupeWindowMs?: number;
  /** Connection name shown in NATS monitoring. Defaults to the service name. */
  clientName?: string;
}

const DEFAULT_STREAM = 'ATLAS';
const DEFAULT_SUBJECTS = ['atlas.>', 'user.>'];
const DLQ_STREAM = 'ATLAS_DLQ';
/** JetStream publishes this when a consumer exhausts max_deliver — see deadLetterCount(). */
const MAX_DELIVERIES_ADVISORY = '$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>';

/**
 * JetStream's API error code for "stream name already in use".
 *
 * Spelled out because `JetStreamApiCodes` names only six codes and this is not among them. It is
 * still better than matching on the message text, which is server-version-dependent prose.
 */
const STREAM_NAME_IN_USE = 10058;

export class NatsBroker implements Broker {
  private nc?: NatsConnection;
  private js?: JetStreamClient;
  private jsm?: JetStreamManager;
  private readonly open: ConsumerMessages[] = [];
  private readonly stream: string;

  private readonly options: NatsBrokerOptions;

  private constructor(options: NatsBrokerOptions) {
    this.options = options;
    this.stream = options.stream ?? DEFAULT_STREAM;
  }

  /** Connect and ensure the streams exist. Safe to call against an already-provisioned server. */
  static async connect(options: NatsBrokerOptions): Promise<NatsBroker> {
    const broker = new NatsBroker(options);
    try {
      await broker.init();
    } catch (err) {
      // The TCP connection is established BEFORE the streams are provisioned, so a failure in
      // stream setup — an overlapping subject, a config that will not converge — would otherwise
      // leave an open socket nobody holds a reference to. Node keeps the process alive for it,
      // which turns a clear startup error into a hang.
      await broker.close().catch(() => undefined);
      throw err;
    }
    return broker;
  }

  private async init(): Promise<void> {
    this.nc = await connect({
      servers: this.options.servers,
      name: this.options.clientName ?? `atlas-${this.options.service}`,
    });
    // Free functions, not connection methods — the v3 split moved JetStream out of the transport.
    this.jsm = await jetstreamManager(this.nc);
    this.js = jetstream(this.nc);

    await upsertStream(this.jsm, {
      name: this.stream,
      subjects: this.options.subjects ?? DEFAULT_SUBJECTS,
      retention: RetentionPolicy.Limits,
      duplicate_window: nanos(this.options.dedupeWindowMs ?? 120_000),
    });

    // ADR-0001 recorded this as a real gap: JetStream has no dead-letter queue. It caps
    // redelivery and emits an advisory, so the DLQ is reconstructed by capturing those advisories
    // into their own stream. Inspection and replay are EP-03.4.
    await upsertStream(this.jsm, {
      name: DLQ_STREAM,
      subjects: [MAX_DELIVERIES_ADVISORY],
      retention: RetentionPolicy.Limits,
    });
  }

  async publish(msg: Message): Promise<void> {
    const js = this.js;
    if (!js) throw new Error('NatsBroker: not connected');
    await js.publish(msg.subject, encode(msg.body), {
      msgID: msg.id,
      ...(msg.headers ? { headers: toHeaders(msg.headers) } : {}),
    });
  }

  subscribe(pattern: string, handler: Handler, opts: SubscribeOptions = {}): Subscription {
    const maxAttempts = opts.maxAttempts ?? 3;
    const durable = durableName(this.options.service, pattern);
    let messages: ConsumerMessages | undefined;
    let stopped = false;

    // subscribe() is synchronous in the Broker interface, but attaching a durable consumer is not.
    // The pump is started in the background; messages published before it attaches are NOT lost —
    // the stream retains them and DeliverPolicy.All replays from the beginning of the consumer.
    void (async () => {
      const jsm = this.jsm;
      const js = this.js;
      if (!jsm || !js) throw new Error('NatsBroker: not connected');

      await jsm.consumers.add(this.stream, {
        durable_name: durable,
        filter_subject: pattern, // NATS wildcards ARE Atlas wildcards — no translation (ADR-0001 T1)
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        max_deliver: maxAttempts,
        ack_wait: nanos(this.options.ackWaitMs ?? 30_000),
      });

      const consumer = await js.consumers.get(this.stream, durable);
      const pump = await consumer.consume();
      if (stopped) {
        pump.stop();
        return;
      }
      messages = pump;
      this.open.push(pump);

      for await (const m of pump) {
        await this.dispatch(m, handler, maxAttempts);
      }
    })();

    return {
      unsubscribe: () => {
        stopped = true;
        messages?.stop();
      },
    };
  }

  private async dispatch(m: JsMsg, handler: Handler, maxAttempts: number): Promise<void> {
    try {
      const headers = headersOf(m);
      await handler({
        id: m.headers?.get('Nats-Msg-Id') || String(m.seq),
        subject: m.subject,
        body: decode(m.data),
        ...(headers !== undefined ? { headers } : {}),
      });
      m.ack();
    } catch {
      // Backoff between attempts. On the final failure NAK anyway: that is what drives the
      // delivery count past max_deliver and produces the advisory the DLQ stream captures.
      //
      // `deliveryCount` was `redeliveryCount` before the @nats-io split (#207) — a rename carrying
      // the same meaning (deliveries so far, 1 on the first). It is the one field in this migration
      // where an off-by-one would be silent: the backoff would merely look wrong, but the
      // `>= maxAttempts` comparison decides whether a message reaches the DLQ at all. The
      // conformance suite's dead-letter case is what pins it against a real server.
      const attempt = m.info.deliveryCount;
      m.nak(attempt >= maxAttempts ? 0 : Math.min(2 ** attempt * 100, 30_000));
    }
  }

  /** How many messages the broker has given up on. Backs EP-03.4's inspection tool. */
  async deadLetterCount(): Promise<number> {
    if (!this.jsm) return 0;
    try {
      const info = await this.jsm.streams.info(DLQ_STREAM);
      return info.state.messages;
    } catch {
      return 0;
    }
  }

  async close(): Promise<void> {
    for (const pump of this.open.splice(0)) pump.stop();
    const nc = this.nc;
    if (!nc) return;
    // drain() flushes in-flight publishes and lets consumers finish; close() would cut them off.
    await nc.drain().catch(() => nc.close());
  }
}

/**
 * Durable names may not contain `.`, `*`, `>` or whitespace, and must be stable across restarts —
 * a changed name is a NEW cursor that replays the whole stream.
 */
export function durableName(service: string, pattern: string): string {
  return `${slug(service)}__${slug(pattern)}`;
}

const slug = (s: string): string => s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '');

/** Create the stream, or update it if the config drifted. Idempotent across restarts. */
async function upsertStream(
  jsm: JetStreamManager,
  config: Parameters<JetStreamManager['streams']['add']>[0],
): Promise<void> {
  try {
    await jsm.streams.add(config);
  } catch (err) {
    // Already exists with a different config — converge it rather than failing to boot. Matched on
    // the API error CODE now that v3 exposes one; the previous string match against the message
    // text would quietly stop working on a server that reworded it, and the failure mode is a
    // service that cannot boot.
    if (err instanceof JetStreamApiError && err.code === STREAM_NAME_IN_USE) {
      await jsm.streams.update(config.name, config).catch(() => undefined);
      return;
    }
    throw err;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const encode = (body: unknown): Uint8Array => encoder.encode(JSON.stringify(body));
const decode = (data: Uint8Array): unknown => JSON.parse(decoder.decode(data));

function toHeaders(headers: Record<string, string>): ReturnType<typeof headersFactory> {
  const h = headersFactory();
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return h;
}

function headersOf(m: JsMsg): Record<string, string> | undefined {
  if (!m.headers) return undefined;
  const out: Record<string, string> = {};
  for (const key of m.headers.keys()) {
    if (key.startsWith('Nats-')) continue; // transport bookkeeping, not the caller's headers
    const value = m.headers.get(key);
    if (value) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
