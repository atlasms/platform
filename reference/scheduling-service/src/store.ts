import { InMemoryOutboxStore, type OutboxStore } from '../../messaging/src/index.ts';
import { subjectFor, type Envelope } from '../../contracts/src/index.ts';
import type { Schedule, Schedulable } from './schedule.ts';

export class SchedulingStore {
  private schedules = new Map<string, Schedule>();
  private schedulable = new Map<string, Schedulable>(); // assetId -> {expiresAt?}
  readonly outbox: OutboxStore = new InMemoryOutboxStore();

  getSchedule(id: string): Schedule | undefined { return this.schedules.get(id); }
  allSchedules(): Schedule[] { return [...this.schedules.values()]; }

  async commit(schedule: Schedule, events: Envelope[]): Promise<void> {
    this.schedules.set(schedule.id, { ...schedule, items: schedule.items.map((i) => ({ ...i })) });
    for (const env of events) {
      await this.outbox.add({ id: env.messageId, message: { id: env.messageId, subject: subjectFor(schedule.channelId, env.type), body: env } });
    }
  }

  // --- schedulable registry (internal projection from asset lifecycle events) ---
  setSchedulable(assetId: string, entry: Schedulable): void { this.schedulable.set(assetId, entry); }
  removeSchedulable(assetId: string): void { this.schedulable.delete(assetId); }
  moveSchedulable(oldId: string, newId: string): void {
    const e = this.schedulable.get(oldId);
    if (e) { this.schedulable.set(newId, e); this.schedulable.delete(oldId); }
  }
  schedulableEntry(assetId: string): Schedulable | undefined { return this.schedulable.get(assetId); }
}
