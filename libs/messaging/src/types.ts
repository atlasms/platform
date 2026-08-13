// Transport-level message. The domain envelope (from @atlas/contracts) travels as `body`, with
// `id` = envelope.messageId and `subject` = subjectFor(channelId, type). Messaging stays
// broker-agnostic and schema-agnostic — see README for the composition with @atlas/contracts.
export interface Message<B = unknown> {
  id: string;
  subject: string;
  headers?: Record<string, string>;
  body: B;
}

export type Handler = (msg: Message) => Promise<void> | void;

export interface SubscribeOptions {
  /** delivery attempts before dead-lettering (default 3). */
  maxAttempts?: number;
}

export interface Subscription {
  unsubscribe(): void;
}

export interface Broker {
  publish(msg: Message): Promise<void>;
  subscribe(pattern: string, handler: Handler, opts?: SubscribeOptions): Subscription;
}

export interface DeadLetter {
  msg: Message;
  pattern: string;
  attempts: number;
  error: string;
}

/**
 * One message the broker gave up on, as an operator needs to see it (EP-03.4).
 *
 * Deliberately not {@link DeadLetter}: that is the in-memory broker's own record and carries a
 * handler error string, which a real broker does not have. JetStream's dead-letter signal is an
 * ADVISORY — it names the stream, the consumer and the sequence, and says nothing about why the
 * handler threw. Promising `error` here would be promising something only the double can deliver.
 */
export interface DeadLetterEntry {
  /** The original message id. What an operator greps the logs for. */
  id: string;
  subject: string;
  /** Delivery attempts made before the broker gave up. */
  attempts: number;
  /** ISO timestamp of the give-up, when the broker records one. */
  failedAt?: string;
  /** The durable consumer that gave up — several may subscribe to one subject. */
  consumer?: string;
  /** Why the handler failed, when the broker knows. Absent on JetStream: see above. */
  error?: string;
  /**
   * The original message, when it can still be recovered.
   *
   * Absent rather than fabricated if the source stream has since aged it out — a dead letter can
   * outlive the message it refers to, and an operator must be able to tell "here it is" from
   * "it existed and is now gone".
   */
  message?: Message;
}

export interface ReplayResult {
  id: string;
  replayed: boolean;
  /** Why not, when `replayed` is false. */
  reason?: string;
}

/**
 * Inspection and replay of dead letters (EP-03.4).
 *
 * Separate from {@link Broker} on purpose: every service publishes and subscribes, and none of them
 * should be able to replay. This is an operator capability, so it is a capability a broker MAY
 * implement and a tool asks for by name.
 */
export interface DeadLetterQueue {
  /** How many messages the broker has given up on. */
  deadLetterCount(): Promise<number>;
  /**
   * The dead letters themselves, newest first.
   *
   * `listDeadLetters` rather than `deadLetters` because the in-memory broker already exposes a
   * `deadLetters` ARRAY that tests read directly, and a method of the same name would shadow it.
   * It also matches `listUnsent` on the outbox store.
   */
  listDeadLetters(limit?: number): Promise<DeadLetterEntry[]>;
  /**
   * Publish a dead letter back onto its original subject.
   *
   * **Replay is at-least-once, not exactly-once, and it is not a rollback.** It re-delivers; it
   * cannot undo whatever partial work the failed attempt left behind. Consumer idempotency is what
   * makes it safe, which is why the envelope — and its `messageId` — is republished UNCHANGED.
   */
  replay(id: string): Promise<ReplayResult>;
}

/** Does this broker support dead-letter inspection? */
export function isDeadLetterQueue(broker: unknown): broker is Broker & DeadLetterQueue {
  const candidate = broker as Partial<DeadLetterQueue>;
  return (
    typeof candidate?.deadLetterCount === 'function' &&
    typeof candidate?.listDeadLetters === 'function' &&
    typeof candidate?.replay === 'function'
  );
}
