import type {
  Broker,
  Message,
  Handler,
  SubscribeOptions,
  Subscription,
  DeadLetter,
  DeadLetterEntry,
  DeadLetterQueue,
  ReplayResult,
} from './types.ts';
import { matchSubject } from './subject.ts';

interface Sub {
  pattern: string;
  handler: Handler;
  opts: Required<SubscribeOptions>;
}

/**
 * In-memory broker for dev and tests. Delivery is awaited (deterministic), with per-subscription
 * retry and a dead-letter queue. Same Broker interface as a NATS/RabbitMQ adapter, so services
 * code against it and swap transports without changes.
 */
export class InMemoryBroker implements Broker, DeadLetterQueue {
  private subs: Sub[] = [];
  readonly deadLetters: DeadLetter[] = [];
  readonly published: Message[] = [];
  /** When each dead letter was given up on, parallel to `deadLetters`. */
  private readonly failedAt: string[] = [];
  private readonly clock: () => number;

  constructor(now: () => number = Date.now) {
    this.clock = now;
  }

  async publish(msg: Message): Promise<void> {
    this.published.push(msg);
    for (const sub of this.subs.filter((s) => matchSubject(s.pattern, msg.subject))) {
      await this.deliver(sub, msg);
    }
  }

  subscribe(pattern: string, handler: Handler, opts: SubscribeOptions = {}): Subscription {
    const broadcast = opts.broadcast ?? false;
    const sub: Sub = {
      pattern,
      handler,
      // A broadcast is tried once and never dead-lettered — the same promise the JetStream
      // adapter's ephemeral consumer makes, so a test against this double cannot lean on a retry
      // the real transport would not give it.
      opts: { maxAttempts: broadcast ? 1 : (opts.maxAttempts ?? 3), broadcast },
    };
    this.subs.push(sub);
    return {
      unsubscribe: () => {
        this.subs = this.subs.filter((s) => s !== sub);
      },
    };
  }

  private async deliver(sub: Sub, msg: Message): Promise<void> {
    if (sub.opts.broadcast) {
      await Promise.resolve()
        .then(() => sub.handler(msg))
        .catch(() => undefined);
      return;
    }
    let lastErr: unknown;
    for (let attempt = 1; attempt <= sub.opts.maxAttempts; attempt++) {
      try {
        await sub.handler(msg);
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    this.deadLetters.push({
      msg,
      pattern: sub.pattern,
      attempts: sub.opts.maxAttempts,
      error: String((lastErr as Error)?.message ?? lastErr),
    });
    this.failedAt.push(new Date(this.clock()).toISOString());
  }

  // --- DeadLetterQueue (EP-03.4) ---------------------------------------------------------------

  async deadLetterCount(): Promise<number> {
    return this.deadLetters.length;
  }

  async listDeadLetters(limit?: number): Promise<DeadLetterEntry[]> {
    // Newest first: an operator opening this is looking at what just broke, not at what broke last
    // Tuesday. `slice` before `reverse` would take the OLDEST n and then flip them.
    const entries = this.deadLetters.map((dl, i) => ({
      id: dl.msg.id,
      subject: dl.msg.subject,
      attempts: dl.attempts,
      error: dl.error,
      consumer: dl.pattern,
      ...(this.failedAt[i] !== undefined ? { failedAt: this.failedAt[i] } : {}),
      message: dl.msg,
    }));
    entries.reverse();
    return limit === undefined ? entries : entries.slice(0, limit);
  }

  async replay(id: string): Promise<ReplayResult> {
    const found = this.deadLetters.find((dl) => dl.msg.id === id);
    if (!found) return { id, replayed: false, reason: 'no dead letter with that id' };

    // Republished UNCHANGED, envelope and message id included. Consumer idempotency is what makes
    // replay safe, and it keys on the envelope — rewriting the id here would defeat it and turn a
    // replay into a duplicate the consumer cannot recognise.
    await this.publish(found.msg);
    return { id, replayed: true };
  }
}
