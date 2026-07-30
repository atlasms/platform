import type { Broker, Message, Handler, SubscribeOptions, Subscription, DeadLetter } from './types.ts';
import { matchSubject } from './subject.ts';

interface Sub { pattern: string; handler: Handler; opts: Required<SubscribeOptions>; }

/**
 * In-memory broker for dev and tests. Delivery is awaited (deterministic), with per-subscription
 * retry and a dead-letter queue. Same Broker interface as a NATS/RabbitMQ adapter, so services
 * code against it and swap transports without changes.
 */
export class InMemoryBroker implements Broker {
  private subs: Sub[] = [];
  readonly deadLetters: DeadLetter[] = [];
  readonly published: Message[] = [];

  async publish(msg: Message): Promise<void> {
    this.published.push(msg);
    for (const sub of this.subs.filter((s) => matchSubject(s.pattern, msg.subject))) {
      await this.deliver(sub, msg);
    }
  }

  subscribe(pattern: string, handler: Handler, opts: SubscribeOptions = {}): Subscription {
    const sub: Sub = { pattern, handler, opts: { maxAttempts: opts.maxAttempts ?? 3 } };
    this.subs.push(sub);
    return { unsubscribe: () => { this.subs = this.subs.filter((s) => s !== sub); } };
  }

  private async deliver(sub: Sub, msg: Message): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= sub.opts.maxAttempts; attempt++) {
      try { await sub.handler(msg); return; }
      catch (e) { lastErr = e; }
    }
    this.deadLetters.push({ msg, pattern: sub.pattern, attempts: sub.opts.maxAttempts, error: String((lastErr as Error)?.message ?? lastErr) });
  }
}
