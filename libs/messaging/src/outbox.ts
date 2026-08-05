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

export class OutboxRelay {
  private readonly store: OutboxStore;
  private readonly broker: Broker;
  private readonly now: () => number;

  constructor(store: OutboxStore, broker: Broker, now: () => number = Date.now) {
    this.store = store;
    this.broker = broker;
    this.now = now;
  }

  /** Publish all unsent records, marking each sent. Returns how many were relayed. */
  async drain(batch = 100): Promise<number> {
    const pending = await this.store.listUnsent(batch);
    for (const rec of pending) {
      await this.broker.publish(rec.message); // publish BEFORE markSent: a crash between = redelivery, which is safe
      await this.store.markSent(rec.id, this.now());
    }
    return pending.length;
  }
}
