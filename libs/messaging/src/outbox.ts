import type { Broker, Message } from './types.ts';

// Transactional outbox: a service writes its state change AND the outgoing message to the outbox in
// ONE db transaction, then a relay drains the outbox to the broker. This avoids dual-write drift
// (design: messaging §4.2). Delivery is at-least-once; consumers dedupe via idempotency.
export interface OutboxRecord {
  id: string;
  message: Message;
  sentAt?: number;
}

export interface OutboxStore {
  add(record: OutboxRecord): Promise<void>;
  listUnsent(limit: number): Promise<OutboxRecord[]>;
  markSent(id: string, at: number): Promise<void>;
}

export class InMemoryOutboxStore implements OutboxStore {
  private records: OutboxRecord[] = [];
  async add(record: OutboxRecord): Promise<void> {
    this.records.push({ ...record });
  }
  async listUnsent(limit: number): Promise<OutboxRecord[]> {
    return this.records.filter((r) => !r.sentAt).slice(0, limit);
  }
  async markSent(id: string, at: number): Promise<void> {
    const r = this.records.find((r) => r.id === id);
    if (r) r.sentAt = at;
  }
  all(): OutboxRecord[] {
    return this.records;
  }
}

/**
 * How many publishes may be in flight at once (EP-03.7).
 *
 * ADR-0001 measured the gap this closes: sequential publishing tops out around 123 msg/s while the
 * same broker with 100 confirms in flight reaches 1216 — ~10×, entirely client-side. The relay, not
 * the broker, was the ceiling.
 *
 * BOUNDED, not unlimited. The bound is what keeps a backlog from turning into a burst: an outbox
 * that has accumulated ten thousand events during a broker outage would otherwise try to publish
 * ten thousand at once the moment it returns, which is a thundering herd aimed at the component
 * that just came back.
 */
const DEFAULT_CONCURRENCY = 32;

export interface OutboxRelayOptions {
  now?: () => number;
  /** Maximum publishes in flight. See {@link DEFAULT_CONCURRENCY}. */
  concurrency?: number;
}

/**
 * Raised when some of a batch failed to publish.
 *
 * Everything that DID publish is marked sent before this is thrown, so a retry does not republish
 * it. The throw is what makes the failure visible to the caller's log; the marking is what stops
 * the failure from costing anything already achieved.
 */
export class RelayPartialFailure extends Error {
  readonly relayed: number;
  readonly failed: number;
  constructor(relayed: number, failed: number, cause: unknown) {
    super(`relayed ${relayed}, failed ${failed}: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = 'RelayPartialFailure';
    this.relayed = relayed;
    this.failed = failed;
  }
}

export class OutboxRelay {
  private readonly store: OutboxStore;
  private readonly broker: Broker;
  private readonly now: () => number;
  private readonly concurrency: number;

  constructor(
    store: OutboxStore,
    broker: Broker,
    options: OutboxRelayOptions | (() => number) = {},
  ) {
    this.store = store;
    this.broker = broker;
    // The third argument used to be the clock. Accepting either keeps every existing call site
    // working rather than making a performance change into a breaking one.
    const opts = typeof options === 'function' ? { now: options } : options;
    this.now = opts.now ?? Date.now;
    this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  }

  /**
   * Publish all unsent records, marking each sent. Returns how many were relayed.
   *
   * PIPELINED, but only across SUBJECTS. The serial loop this replaces gave per-subject ordering by
   * accident, and that accident was load-bearing: `asset.created` must reach a consumer before the
   * `asset.approved` that follows it, or the consumer sees an approval for something it has never
   * heard of. So each subject is a queue processed strictly in order, and the parallelism is in how
   * many subjects are in flight at once.
   *
   * A failure stops ITS subject for this drain and leaves the rest of that subject unsent — because
   * publishing message 3 after message 2 failed would deliver them out of order, which is precisely
   * what the ordering guarantee exists to prevent. Other subjects are unaffected.
   */
  async drain(batch = 100): Promise<number> {
    const pending = await this.store.listUnsent(batch);
    if (pending.length === 0) return 0;

    // Grouped in arrival order. `Map` preserves insertion order and `push` preserves it within a
    // subject, so each queue comes out in exactly the order the outbox recorded.
    const queues = new Map<string, OutboxRecord[]>();
    for (const rec of pending) {
      const queue = queues.get(rec.message.subject);
      if (queue) queue.push(rec);
      else queues.set(rec.message.subject, [rec]);
    }

    const subjects = [...queues.values()];
    let next = 0;
    let relayed = 0;
    let firstError: unknown;
    let failed = 0;

    // A worker pool over SUBJECT QUEUES rather than over records. One subject is only ever claimed
    // by one worker, which is what makes ordering hold without any locking.
    const worker = async (): Promise<void> => {
      for (;;) {
        const queue = subjects[next++];
        if (!queue) return;

        for (const rec of queue) {
          try {
            // publish BEFORE markSent: a crash between the two means a redelivery, which is safe,
            // where the other order would mean a lost event, which is not.
            await this.broker.publish(rec.message);
            await this.store.markSent(rec.id, this.now());
            relayed += 1;
          } catch (err) {
            firstError ??= err;
            // The REST of this subject is abandoned for this drain, deliberately. The next drain
            // picks it up from the failed record, still in order.
            failed += queue.length - queue.indexOf(rec);
            break;
          }
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, subjects.length) }, () => worker()),
    );

    if (firstError !== undefined) throw new RelayPartialFailure(relayed, failed, firstError);
    return relayed;
  }
}
