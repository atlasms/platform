import { InMemoryOutboxStore, type OutboxStore } from '../../messaging/src/index.ts';
import { subjectFor, type Envelope } from '../../contracts/src/index.ts';
import type { Asset } from './asset.ts';

// A tiny "unit of work": persist the asset change AND enqueue outgoing events to the outbox in one
// step — the transactional-outbox pattern (a real repo does this in one DB tx). A relay drains the
// outbox to the broker, so there is no dual-write between the DB and the broker.
export class AssetStore {
  private assets = new Map<string, Asset>();
  readonly outbox: OutboxStore = new InMemoryOutboxStore();

  get(id: string): Asset | undefined { return this.assets.get(id); }
  all(): Asset[] { return [...this.assets.values()]; }

  /** Atomically: upsert the asset and append its emitted events to the outbox. */
  async commit(asset: Asset, events: Envelope[]): Promise<void> {
    this.assets.set(asset.id, { ...asset });
    for (const env of events) {
      await this.outbox.add({
        id: env.messageId,
        message: { id: env.messageId, subject: subjectFor(asset.channelId, env.type), body: env },
      });
    }
  }
}
