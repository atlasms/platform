// The program table per channel (EP-18 v0): create a schedule for a broadcast day, edit its header,
// and write its reel — thinly.
//
// THIN is the design (data-model.md §3.4, §3.6; FR-SCH-9). The editor maintains the reel: reflow,
// anchors, no overlaps, gaps flagged. This service persists the `start`s it computed and refuses only
// what cannot be stored as a reel at all (schedule.ts `checkReel`). Overlap and gap detection are
// v1's `POST /validate`, on demand — never a gate on save.
//
// Every write goes out through the outbox in the same transaction as the rows (AGENTS.md §5.4):
// `schedule.updated` for consumers, and `audit.recorded` with the field-level delta (§5.6) — the
// same `commitWith` shape MAM uses.

import {
  buildEnvelope,
  delta,
  subjectFor,
  ulid,
  validatePayload,
  type Delta,
  type Envelope,
  type EventPayloads,
} from '@atlas/contracts';
import type { OutboxRecord } from '@atlas/messaging';
import { canEnforce, type EffectivePolicy } from '@atlas/policy';
import { Conflict, Forbidden, NotFound, ValidationError } from '@atlas/service-kit';
import {
  checkReel,
  endOf,
  inReelOrder,
  type CreateScheduleInput,
  type Schedule,
  type ScheduleItem,
  type ScheduleItemInput,
  type UpdateScheduleInput,
} from './schedule.ts';
import type { ScheduleStore, ScheduleTx } from './store.ts';

export interface Caller {
  userId: string;
  channelId: string;
  policy: EffectivePolicy;
  correlationId?: string;
}

export interface SchedulingServiceOptions {
  store: ScheduleStore;
  now?: () => Date;
  /** Trace context captured into the event where it is created (EP-13.3). */
  traceHeaders?: () => Record<string, string> | undefined;
}

export class SchedulingService {
  private readonly store: ScheduleStore;
  private readonly now: () => Date;
  private readonly traceHeaders: () => Record<string, string> | undefined;

  constructor(options: SchedulingServiceOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.traceHeaders = options.traceHeaders ?? (() => undefined);
  }

  // --- reads ---------------------------------------------------------------------------------------------

  async get(caller: Caller, id: string): Promise<Schedule> {
    this.authorize(caller, 'schedule:read');
    const schedule = await this.store.get(id);
    // Another channel's schedule is "not found", not "forbidden": a 403 would confirm it exists.
    if (!schedule || schedule.channelId !== caller.channelId) throw new NotFound(`schedule ${id}`);
    return schedule;
  }

  async list(
    caller: Caller,
    options: { broadcastDate?: string; after?: string; limit?: number } = {},
  ): Promise<{ items: Schedule[]; nextCursor?: string }> {
    this.authorize(caller, 'schedule:read');
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const page = await this.store.list(caller.channelId, {
      ...(options.broadcastDate !== undefined ? { broadcastDate: options.broadcastDate } : {}),
      ...(options.after !== undefined ? { after: options.after } : {}),
      limit,
    });
    const last = page[page.length - 1];
    return { items: page, ...(page.length === limit && last ? { nextCursor: last.id } : {}) };
  }

  async items(caller: Caller, scheduleId: string): Promise<ScheduleItem[]> {
    await this.get(caller, scheduleId);
    return inReelOrder(await this.store.items(scheduleId));
  }

  // --- writes ---------------------------------------------------------------------------------------------

  async create(caller: Caller, input: CreateScheduleInput): Promise<Schedule> {
    this.authorize(caller, 'schedule:write');
    // One program table per channel per broadcast day (§3.1) — the UNIQUE constraint says the same,
    // but a clear 409 beats a driver error, and the check here names the day.
    if (await this.store.byDay(caller.channelId, input.broadcastDate)) {
      throw new Conflict(`a schedule for ${input.broadcastDate} already exists in this channel`);
    }
    const at = this.now().toISOString();
    const schedule: Schedule = {
      id: ulid(),
      channelId: caller.channelId,
      broadcastDate: input.broadcastDate,
      timezone: input.timezone,
      state: 'draft',
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      version: 1,
      createdBy: caller.userId,
      createdAt: at,
      updatedAt: at,
    };
    await this.commit(caller, schedule, undefined, { itemCount: 0 });
    return schedule;
  }

  async update(caller: Caller, id: string, input: UpdateScheduleInput): Promise<Schedule> {
    const existing = await this.get(caller, id);
    this.authorize(caller, 'schedule:write');
    const updated: Schedule = {
      ...existing,
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    };
    // A no-op PATCH — UIs submit whole forms — changes nothing and emits nothing.
    const changes = delta(
      existing as unknown as Record<string, unknown>,
      updated as unknown as Record<string, unknown>,
    );
    if (Object.keys(changes).length === 0) return existing;
    const next = this.bump(updated);
    await this.commit(caller, next, existing, { itemCount: (await this.store.items(id)).length });
    return next;
  }

  /**
   * The editor's save: replace the whole reel, as given.
   *
   * Ids the editor sends are kept, so an item's history survives a save; absent ids are minted.
   * `end` is computed here. The reel-level invariants are checked over the whole reel; overlap and
   * gap are not — they are the editor's, and v1's /validate.
   */
  async replaceItems(
    caller: Caller,
    scheduleId: string,
    inputs: readonly ScheduleItemInput[],
  ): Promise<ScheduleItem[]> {
    const schedule = await this.get(caller, scheduleId);
    this.authorize(caller, 'schedule:write');
    const items = inputs.map((i) => this.materialize(scheduleId, i));
    checkReel(items);
    const before = await this.store.items(scheduleId);
    const next = this.bump(schedule);
    await this.commit(
      caller,
      next,
      schedule,
      { itemCount: items.length },
      async (tx) => tx.replaceItems(scheduleId, items),
      { items: { before: inReelOrder(before), after: inReelOrder(items) } },
    );
    return inReelOrder(items);
  }

  async addItem(
    caller: Caller,
    scheduleId: string,
    input: ScheduleItemInput,
  ): Promise<ScheduleItem> {
    const schedule = await this.get(caller, scheduleId);
    this.authorize(caller, 'schedule:write');
    const item = this.materialize(scheduleId, input);
    const existing = await this.store.items(scheduleId);
    if (existing.some((e) => e.id === item.id))
      throw new Conflict(`item ${item.id} already exists`);
    checkReel([...existing, item]);
    const next = this.bump(schedule);
    await this.commit(
      caller,
      next,
      schedule,
      { itemCount: existing.length + 1 },
      async (tx) => tx.putItem(item),
      { [`items.${item.id}`]: { after: item } },
    );
    return item;
  }

  async updateItem(
    caller: Caller,
    scheduleId: string,
    itemId: string,
    patch: Partial<Omit<ScheduleItemInput, 'id'>>,
  ): Promise<ScheduleItem> {
    const schedule = await this.get(caller, scheduleId);
    this.authorize(caller, 'schedule:write');
    const current = await this.store.item(scheduleId, itemId);
    if (!current) throw new NotFound(`item ${itemId}`);
    const merged: ScheduleItem = {
      ...current,
      ...patch,
      id: current.id,
      scheduleId,
      end: endOf(patch.start ?? current.start, patch.durationSec ?? current.durationSec),
    };
    const others = (await this.store.items(scheduleId)).filter((i) => i.id !== itemId);
    checkReel([...others, merged]);
    const next = this.bump(schedule);
    await this.commit(
      caller,
      next,
      schedule,
      { itemCount: others.length + 1 },
      async (tx) => tx.putItem(merged),
      { [`items.${itemId}`]: { before: current, after: merged } },
    );
    return merged;
  }

  async removeItem(caller: Caller, scheduleId: string, itemId: string): Promise<void> {
    const schedule = await this.get(caller, scheduleId);
    this.authorize(caller, 'schedule:write');
    const current = await this.store.item(scheduleId, itemId);
    if (!current) throw new NotFound(`item ${itemId}`);
    const all = await this.store.items(scheduleId);
    const removed = all.filter((i) => i.id === itemId || i.parentItemId === itemId);
    const next = this.bump(schedule);
    await this.commit(
      caller,
      next,
      schedule,
      { itemCount: all.length - removed.length },
      async (tx) => tx.removeItem(scheduleId, itemId),
      Object.fromEntries(removed.map((r) => [`items.${r.id}`, { before: r }])),
    );
  }

  // --- the unit of work --------------------------------------------------------------------------------

  private authorize(caller: Caller, permission: string): void {
    const decision = canEnforce(caller.policy, permission, { channelId: caller.channelId });
    if (!decision.allowed) throw new Forbidden(decision.reason ?? `missing ${permission}`);
  }

  private bump(schedule: Schedule): Schedule {
    return { ...schedule, version: schedule.version + 1, updatedAt: this.now().toISOString() };
  }

  private materialize(scheduleId: string, input: ScheduleItemInput): ScheduleItem {
    const { id, ...rest } = input;
    return { id: id ?? ulid(), scheduleId, ...rest, end: endOf(input.start, input.durationSec) };
  }

  /**
   * The header row, the reel change, the domain event and the audit record: ONE transaction.
   *
   * `schedule.updated` carries the header's state and the item count — what an EPG feed or a panel
   * needs to know something changed. The audit record carries the DELTA: the header's field diff,
   * plus whatever the reel change was (`sideTables`), supplied by the caller because the rows are
   * not on the header.
   */
  private async commit(
    caller: Caller,
    schedule: Schedule,
    before: Schedule | undefined,
    event: { itemCount: number },
    also?: (tx: ScheduleTx) => Promise<void>,
    sideTables: Delta = {},
  ): Promise<void> {
    const updated = this.record(caller, schedule.channelId, 'schedule.updated', {
      scheduleId: schedule.id,
      state: schedule.state,
      itemCount: event.itemCount,
    } satisfies EventPayloads['schedule.updated']);
    const audit = this.record(caller, schedule.channelId, 'audit.recorded', {
      entityType: 'schedule',
      entityId: schedule.id,
      revision: schedule.version,
      action: before === undefined ? 'schedule.created' : 'schedule.updated',
      origin: { service: 'scheduling' },
      delta: {
        ...delta(
          before as unknown as Record<string, unknown> | undefined,
          schedule as unknown as Record<string, unknown>,
        ),
        ...sideTables,
      },
    } satisfies EventPayloads['audit.recorded']);

    await this.store.transaction(async (tx) => {
      await tx.put(schedule);
      await also?.(tx);
      await tx.enqueue(updated);
      await tx.enqueue(audit);
    });
  }

  private record(caller: Caller, channelId: string, type: string, payload: object): OutboxRecord {
    const check = validatePayload(type, payload);
    if (!check.valid) {
      throw new ValidationError(
        `${type} payload does not match its schema: ${check.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
      );
    }
    const envelope: Envelope = buildEnvelope({
      type,
      channelId,
      payload: payload as Record<string, unknown>,
      actor: { kind: 'user', id: caller.userId },
      ...(caller.correlationId !== undefined ? { correlationId: caller.correlationId } : {}),
    });
    const headers = this.traceHeaders();
    return {
      id: envelope.messageId,
      message: {
        id: envelope.messageId,
        subject: subjectFor(channelId, type),
        body: envelope,
        ...(headers !== undefined ? { headers } : {}),
      },
    };
  }
}
