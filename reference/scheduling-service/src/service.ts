import { buildEnvelope, follow, validateMessage, ulid, type Envelope } from '../../contracts/src/index.ts';
import { idempotent, InMemorySeenStore, OutboxRelay, type Broker, type Message } from '../../messaging/src/index.ts';
import { createLogger, Conflict, Internal, NotFound, type Logger } from '../../service-kit/src/index.ts';
import { SchedulingStore } from './store.ts';
import { jsonPlaylist, type PlaylistSerializer, type Schedule, type ScheduleItem } from './schedule.ts';

export interface SendResult {
  playlist: string;
  exported: ScheduleItem[];
  blocked: { item: ScheduleItem; reason: 'not-approved' | 'expired' }[];
}

/**
 * Scheduling vertical slice. Projects MAM's asset lifecycle into a schedulable registry and enforces
 * the **approved-and-not-expired guard at serialization** — the FR-SCH-3/5a rule that lets the review
 * lifecycle actually gate air. Consumes asset.approved/expired/deleted/replaced.
 */
export class SchedulingService {
  private seen = new InMemorySeenStore();
  private relay: OutboxRelay;
  private log: Logger;

  constructor(private broker: Broker, private store: SchedulingStore, private serializer: PlaylistSerializer = jsonPlaylist) {
    this.relay = new OutboxRelay(store.outbox, broker);
    this.log = createLogger('scheduling');
  }

  start(): void {
    this.broker.subscribe('atlas.*.asset.approved', idempotent((m) => this.onApproved(m), this.seen));
    this.broker.subscribe('atlas.*.asset.expired', idempotent((m) => this.onExpired(m), this.seen));
    this.broker.subscribe('atlas.*.asset.deleted', idempotent((m) => this.onDeleted(m), this.seen));
    this.broker.subscribe('atlas.*.asset.replaced', idempotent((m) => this.onReplaced(m), this.seen));
  }
  drain(): Promise<number> { return this.relay.drain(); }
  getSchedule(id: string): Schedule | undefined { return this.store.getSchedule(id); }

  // --- lifecycle projections ---
  private async onApproved(m: Message): Promise<void> {
    const env = m.body as Envelope; const { assetId, expiresAt } = env.payload as any;
    this.store.setSchedulable(assetId, { expiresAt });               // becomes schedulable
    this.log.info('asset schedulable', { assetId, expiresAt });
  }
  private async onExpired(m: Message): Promise<void> {
    const env = m.body as Envelope; const { assetId } = env.payload as any;
    this.store.removeSchedulable(assetId);                            // no longer schedulable
    this.flagItems(assetId, 'asset-expired');                        // flag, don't drop (design)
  }
  private async onDeleted(m: Message): Promise<void> {
    const env = m.body as Envelope; const { assetId } = env.payload as any;
    this.store.removeSchedulable(assetId);
    for (const s of this.store.allSchedules()) {                      // drop references
      const items = s.items.filter((i) => i.assetId !== assetId);
      if (items.length !== s.items.length) await this.store.commit({ ...s, items }, []);
    }
  }
  private async onReplaced(m: Message): Promise<void> {
    const env = m.body as Envelope; const { oldId, newId } = env.payload as any;
    this.store.moveSchedulable(oldId, newId);                         // swap references
    for (const s of this.store.allSchedules()) {
      let changed = false;
      const items = s.items.map((i) => (i.assetId === oldId ? ((changed = true), { ...i, assetId: newId, flagged: undefined }) : i));
      if (changed) await this.store.commit({ ...s, items }, []);
    }
  }

  private flagItems(assetId: string, reason: string): void {
    for (const s of this.store.allSchedules()) {
      let changed = false;
      const items = s.items.map((i) => (i.assetId === assetId ? ((changed = true), { ...i, flagged: reason }) : i));
      if (changed) this.store.commit({ ...s, items }, []); // fire-and-forget internal update
    }
  }

  // --- API ---
  async createSchedule(channelId: string): Promise<Schedule> {
    const s: Schedule = { id: ulid(), channelId, state: 'draft', items: [] };
    await this.store.commit(s, [this.checked(buildEnvelope({ type: 'schedule.updated', channelId, payload: { scheduleId: s.id, state: 'draft', itemCount: 0 } }))]);
    return s;
  }

  /** Add an item — enforces "only approved media is schedulable" up front (FR-SCH-3). */
  async addItem(scheduleId: string, assetId: string, startAt: string, durationSec: number): Promise<Schedule> {
    const s = this.require(scheduleId);
    if (!this.store.schedulableEntry(assetId)) throw new Conflict(`asset ${assetId} is not currently schedulable (not approved)`);
    const items = [...s.items, { id: ulid(), assetId, startAt, durationSec }];
    const updated = { ...s, items };
    await this.store.commit(updated, [this.checked(buildEnvelope({ type: 'schedule.updated', channelId: s.channelId, payload: { scheduleId, state: 'draft', itemCount: items.length } }))]);
    return updated;
  }

  /**
   * Send-to-air: the guard runs **at serialization**. An item is exported only if its asset is still
   * schedulable AND not past its expiry (catches an approval lapsing between scheduling and export).
   * Blocked items are excluded and reported — never silently on air.
   */
  async sendToAir(scheduleId: string, opts: { destination?: string; now?: number } = {}): Promise<SendResult> {
    const s = this.require(scheduleId);
    const now = opts.now ?? Date.now();
    const exported: ScheduleItem[] = [];
    const blocked: SendResult['blocked'] = [];
    for (const item of s.items) {
      const entry = this.store.schedulableEntry(item.assetId);
      if (!entry) { blocked.push({ item, reason: 'not-approved' }); continue; }
      if (entry.expiresAt && Date.parse(entry.expiresAt) <= now) { blocked.push({ item, reason: 'expired' }); continue; }
      exported.push(item);
    }
    const playlist = this.serializer.serialize(scheduleId, exported);
    const events: Envelope[] = [this.checked(buildEnvelope({ type: 'schedule.updated', channelId: s.channelId, payload: { scheduleId, state: exported.length ? 'sent' : 'failed', itemCount: exported.length } }))];
    if (exported.length) events.push(this.checked(buildEnvelope({ type: 'schedule.sent-to-air', channelId: s.channelId, payload: { scheduleId, destination: opts.destination, format: this.serializer.format } })));
    await this.store.commit({ ...s, state: exported.length ? 'sent' : 'failed' }, events);
    this.log.info('send-to-air', { scheduleId, exported: exported.length, blocked: blocked.length });
    return { playlist, exported, blocked };
  }

  private checked(env: Envelope): Envelope {
    const res = validateMessage(env);
    if (!res.valid) throw new Internal(`invalid outgoing ${env.type}: ${JSON.stringify(res.errors)}`);
    return env;
  }
  private require(id: string): Schedule { const s = this.store.getSchedule(id); if (!s) throw new NotFound(`schedule ${id}`); return s; }
}
