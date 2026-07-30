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

export interface Subscription { unsubscribe(): void; }

export interface Broker {
  publish(msg: Message): Promise<void>;
  subscribe(pattern: string, handler: Handler, opts?: SubscribeOptions): Subscription;
}

export interface DeadLetter { msg: Message; pattern: string; attempts: number; error: string; }
