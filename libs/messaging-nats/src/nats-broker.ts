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
import {
  headers as headersFactory,
  nanos,
  type MsgHdrs,
  type NatsConnection,
} from '@nats-io/nats-core';
import { connect } from '@nats-io/transport-node';
import type {
  Broker,
  DeadLetterEntry,
  DeadLetterQueue,
  Handler,
  Message,
  ReplayResult,
  SubscribeOptions,
  Subscription,
} from '@atlas/messaging';

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

export class NatsBroker implements Broker, DeadLetterQueue {
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

  // --- DeadLetterQueue (EP-03.4) ---------------------------------------------------------------
  //
  // JetStream has no dead-letter queue. What it has is an ADVISORY published when a consumer
  // exhausts max_deliver, and ADR-0001 recorded the reconstruction as a real cost of choosing it.
  //
  // The consequence lands here: the DLQ stream holds advisories, NOT messages. An advisory names
  // the stream, the consumer and the sequence, and carries none of the payload — so inspection is
  // a two-step read, and the original may have aged out of the source stream in the meantime.

  /** How many messages the broker has given up on. */
  async deadLetterCount(): Promise<number> {
    if (!this.jsm) return 0;
    try {
      const info = await this.jsm.streams.info(DLQ_STREAM);
      return info.state.messages;
    } catch {
      return 0;
    }
  }

  /** Dead letters, newest first, each resolved back to its original message where possible. */
  async listDeadLetters(limit = 50): Promise<DeadLetterEntry[]> {
    const jsm = this.jsm;
    if (!jsm) return [];

    let state;
    try {
      state = (await jsm.streams.info(DLQ_STREAM)).state;
    } catch {
      return []; // no DLQ stream yet means nothing has ever failed
    }

    const entries: DeadLetterEntry[] = [];
    // Downward from the newest: an operator opening this is looking at what just broke. Reading
    // upward and reversing would fetch the whole history to show the last ten of it.
    for (let seq = state.last_seq; seq >= state.first_seq && entries.length < limit; seq -= 1) {
      const advisory = await readAdvisory(jsm, seq);
      if (!advisory) continue; // a gap: the advisory aged out or was purged between calls

      const original = await readOriginal(jsm, advisory.stream, advisory.stream_seq);
      entries.push({
        // The ORIGINAL message id, not the advisory's — the advisory id means nothing to anyone
        // grepping logs for the event that failed.
        id: original?.id ?? `${advisory.stream}:${advisory.stream_seq}`,
        subject: original?.subject ?? '(original no longer in the stream)',
        attempts: advisory.deliveries,
        failedAt: advisory.timestamp,
        consumer: advisory.consumer,
        // `error` is deliberately absent: the advisory says the consumer gave up, never why the
        // handler threw. That lives in the consumer's logs, found by this id.
        ...(original !== undefined ? { message: original } : {}),
      });
    }
    return entries;
  }

  async replay(id: string): Promise<ReplayResult> {
    const js = this.js;
    if (!js) return { id, replayed: false, reason: 'not connected' };

    const found = (await this.listDeadLetters(MAX_REPLAY_SCAN)).find((e) => e.id === id);
    if (!found) return { id, replayed: false, reason: 'no dead letter with that id' };
    if (!found.message) {
      return { id, replayed: false, reason: 'the original message is no longer in the stream' };
    }

    // A FRESH broker-level dedupe id, and this is the trap the whole method turns on. JetStream
    // deduplicates on msgID across the entire stream for the length of the dedupe window, so
    // republishing under the original id inside that window would resolve successfully and be
    // SILENTLY DISCARDED — a replay that reports success and delivers nothing.
    //
    // The payload is byte-identical, so `envelope.messageId` is unchanged and consumer idempotency
    // still recognises it. That is the layer replay safety actually comes from.
    await js.publish(found.message.subject, encode(found.message.body), {
      msgID: `replay-${crypto.randomUUID()}`,
      ...(found.message.headers ? { headers: toHeaders(found.message.headers) } : {}),
    });
    return { id, replayed: true };
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

/** How far back `replay` will look for an id before giving up. */
const MAX_REPLAY_SCAN = 500;

/**
 * The JetStream MAX_DELIVERIES advisory, as much of it as matters here.
 *
 * `stream_seq` is the load-bearing field: it points at the original message in the SOURCE stream,
 * which is the only way back to a payload the advisory does not contain.
 */
interface MaxDeliveriesAdvisory {
  stream: string;
  consumer: string;
  stream_seq: number;
  deliveries: number;
  timestamp: string;
}

async function readAdvisory(
  jsm: JetStreamManager,
  seq: number,
): Promise<MaxDeliveriesAdvisory | undefined> {
  try {
    const stored = await jsm.streams.getMessage(DLQ_STREAM, { seq });
    if (!stored) return undefined;
    const parsed = JSON.parse(decoder.decode(stored.data)) as Partial<MaxDeliveriesAdvisory>;
    if (typeof parsed.stream !== 'string' || typeof parsed.stream_seq !== 'number') {
      return undefined; // not an advisory shape we understand — skip rather than throw
    }
    return {
      stream: parsed.stream,
      consumer: parsed.consumer ?? '(unknown)',
      stream_seq: parsed.stream_seq,
      deliveries: parsed.deliveries ?? 0,
      timestamp: parsed.timestamp ?? stored.time.toISOString(),
    };
  } catch {
    return undefined;
  }
}

/** Fetch the original message an advisory points at, if the stream still holds it. */
async function readOriginal(
  jsm: JetStreamManager,
  stream: string,
  seq: number,
): Promise<Message | undefined> {
  try {
    const stored = await jsm.streams.getMessage(stream, { seq });
    if (!stored) return undefined;
    const headers = storedHeaders(stored.header);
    return {
      id: stored.header?.get('Nats-Msg-Id') || String(stored.seq),
      subject: stored.subject,
      body: decode(stored.data),
      ...(headers !== undefined ? { headers } : {}),
    };
  } catch {
    // Aged out, purged, or the stream is gone. Absent rather than fabricated: an operator must be
    // able to tell "here it is" from "it existed and is now unrecoverable".
    return undefined;
  }
}

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

const headersOf = (m: JsMsg): Record<string, string> | undefined => pickHeaders(m.headers);
const storedHeaders = (h: MsgHdrs | undefined): Record<string, string> | undefined =>
  pickHeaders(h);

/**
 * The caller's headers, minus the transport's own.
 *
 * Shared by the delivery path and the dead-letter reader so the `Nats-` filtering rule lives in one
 * place — a dead letter must present exactly the headers its live delivery would have, or a replay
 * is not a replay of the same message.
 */
function pickHeaders(hdrs: MsgHdrs | undefined): Record<string, string> | undefined {
  if (!hdrs) return undefined;
  const out: Record<string, string> = {};
  for (const key of hdrs.keys()) {
    if (key.startsWith('Nats-')) continue; // transport bookkeeping, not the caller's headers
    const value = hdrs.get(key);
    if (value) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
