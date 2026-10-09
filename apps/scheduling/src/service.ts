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
//
// v1 (EP-31) adds the on-demand validation (validation.ts) and what it reads: MAM's word on each
// asset's approval, kept here from MAM's lifecycle events (approvals.ts) by `applyAssetEvent`, the
// service's first broker consumer. A clean run moves a draft to `validated`; any edit moves it
// back.

import {
  buildEnvelope,
  delta,
  envelopeShapeErrors,
  subjectFor,
  ulid,
  validatePayload,
  type Delta,
  type Envelope,
  type EventPayloads,
} from '@atlas/contracts';
import type { Message, OutboxRecord } from '@atlas/messaging';
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
import { APPROVAL_EVENTS, applyAssetEvent, type MediaApproval } from './approvals.ts';
import { planCopy, type CopyRequest } from './copy.ts';
import type { RightsWindow, RightsWindowInput } from './rights.ts';
import type { ScheduleStore, ScheduleTx } from './store.ts';
import { UNCHECKED, validateReel, type IssueKind, type ValidationIssue } from './validation.ts';

/** What `POST /schedules/{id}/validate` answers (scheduling.yaml `ValidationReport`). */
export interface ValidationReport {
  scheduleId: string;
  version: number;
  state: Schedule['state'];
  valid: boolean;
  issues: ValidationIssue[];
  unchecked: IssueKind[];
  validatedAt: string;
}

/** What the consumer did with one asset event. */
export type ApprovalOutcome = 'applied' | 'unchanged' | 'duplicate' | 'ignored';

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

  // --- validation (EP-31) ------------------------------------------------------------------------------

  /**
   * Validate the reel as stored — advisory, never a gate on save (§3.4).
   *
   * A run with no critical issue moves a `draft` to `validated`; one with a critical issue moves a
   * `validated` schedule back to `draft` (an approval can lapse with no edit at all). A state change
   * is a write — version, `schedule.updated`, the audit delta — and is made only over the version
   * that was validated: an edit in between is a 409, since the report would describe a reel that
   * no longer exists. Every run emits `schedule.validated`, which the editor and Logging read.
   */
  async validate(caller: Caller, id: string): Promise<ValidationReport> {
    const schedule = await this.get(caller, id);
    this.authorize(caller, 'schedule:write');
    const items = await this.store.items(id);
    const mediaIds = [
      ...new Set(items.flatMap((i) => (i.mediaId !== undefined ? [i.mediaId] : []))),
    ];
    const approvals = new Map(
      (await this.store.approvals(schedule.channelId, mediaIds)).map((a) => [a.assetId, a]),
    );
    const categoryIds = [
      ...new Set(items.flatMap((i) => (i.categoryId !== undefined ? [i.categoryId] : []))),
    ];
    const rights = await this.store.rightsWindows(schedule.channelId, {
      assetIds: mediaIds,
      categoryIds,
    });
    const issues = validateReel(items, approvals, schedule.timezone, rights);
    const valid = !issues.some((i) => i.severity === 'critical');
    const validatedAt = this.now().toISOString();

    const state =
      valid && schedule.state === 'draft'
        ? 'validated'
        : !valid && schedule.state === 'validated'
          ? 'draft'
          : schedule.state;
    const next: Schedule =
      state === schedule.state
        ? schedule
        : { ...schedule, state, version: schedule.version + 1, updatedAt: validatedAt };

    const validated = this.record(caller, schedule.channelId, 'schedule.validated', {
      scheduleId: id,
      valid,
      issues,
      validatedAt,
      version: next.version,
    } satisfies EventPayloads['schedule.validated']);

    if (next === schedule) {
      await this.store.transaction((tx) => tx.enqueue(validated));
    } else {
      await this.commit(
        caller,
        next,
        schedule,
        { itemCount: items.length },
        undefined,
        {},
        {
          action: 'schedule.validated',
          ifVersion: schedule.version,
          also: [validated],
        },
      );
    }
    return {
      scheduleId: id,
      version: next.version,
      state: next.state,
      valid,
      issues,
      unchecked: [...UNCHECKED],
      validatedAt,
    };
  }

  /**
   * One MAM lifecycle event into the approval record — the consumer of `atlas.*.asset.*`.
   *
   * The seen-mark and the record commit together (EP-03.3), so a redelivery is a duplicate and a
   * crash a retry. The record is read THROUGH the transaction and locked, so two replicas taking
   * two events of one asset cannot each apply theirs over the same old record. A message that is
   * not a well-formed envelope is thrown — retried, then dead-lettered — never skipped.
   */
  async applyAssetEvent(msg: Message): Promise<ApprovalOutcome> {
    const shape = envelopeShapeErrors(msg.body);
    if (!shape.valid) {
      throw new ValidationError(
        `message ${msg.id} on ${msg.subject} is not an envelope: ${shape.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
      );
    }
    const envelope = msg.body as Envelope;
    // Every other asset.* (created, ready, replaced, …) says nothing about approval.
    if (!(APPROVAL_EVENTS as readonly string[]).includes(envelope.type)) return 'ignored';
    const check = validatePayload(envelope.type, envelope.payload);
    if (!check.valid) {
      throw new ValidationError(
        `${envelope.type} ${msg.id} does not match its schema: ${check.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
      );
    }

    let outcome: ApprovalOutcome = 'unchanged';
    await this.store.transaction(async (tx) => {
      if (!(await tx.markSeen(msg.id))) {
        outcome = 'duplicate';
        return;
      }
      const assetId = (envelope.payload as { assetId: string }).assetId;
      const current = await tx.approvalForUpdate(assetId);
      // An asset id is global, but a record is the channel's that announced it first; another
      // channel claiming the same id is not a fact about this record.
      if (current !== undefined && current.channelId !== envelope.channelId) {
        throw new Conflict(
          `asset ${assetId} is recorded in channel ${current.channelId}, not ${envelope.channelId}`,
        );
      }
      const next: MediaApproval | undefined = applyAssetEvent(current, envelope);
      if (next === undefined) return;
      if (!(await tx.putApproval(next, current !== undefined))) {
        // Another consumer created the record between our read and our insert: roll back (the
        // seen-mark with it) and let the broker redeliver, which reads the record it made.
        throw new Conflict(`approval record for ${assetId} was created concurrently; retry`);
      }
      outcome = 'applied';
    });
    return outcome;
  }

  // --- rights windows (EP-31; rights.ts) -------------------------------------------------------------
  //
  // An asset's rights are the MAM `rights` field group's business (authorization-model.md §9: the
  // Librarian holds `asset:write` on `files` and `rights`), so a window — when a channel may air
  // an asset or a category — is read and written under the same grants, strictly: `asset:read` /
  // `asset:write` with `fieldGroup: 'rights'`. A writer narrowed to a category subtree is refused,
  // as in MTS: Scheduling knows a category id, not its path, and strict evaluation denies what it
  // cannot check. Every write is audited (`rights-window`), in the transaction of the change.

  async listRightsWindows(
    caller: Caller,
    filter: { assetId?: string; categoryId?: string } = {},
  ): Promise<RightsWindow[]> {
    this.authorizeRights(caller, 'asset:read');
    if (filter.assetId === undefined && filter.categoryId === undefined) {
      return this.store.rightsWindows(caller.channelId);
    }
    return this.store.rightsWindows(caller.channelId, {
      ...(filter.assetId !== undefined ? { assetIds: [filter.assetId] } : {}),
      ...(filter.categoryId !== undefined ? { categoryIds: [filter.categoryId] } : {}),
    });
  }

  async getRightsWindow(caller: Caller, id: string): Promise<RightsWindow> {
    this.authorizeRights(caller, 'asset:read');
    return this.rightsWindowIn(caller, id);
  }

  async createRightsWindow(caller: Caller, input: RightsWindowInput): Promise<RightsWindow> {
    this.authorizeRights(caller, 'asset:write');
    const at = this.now().toISOString();
    const window: RightsWindow = {
      id: ulid(),
      channelId: caller.channelId,
      ...input,
      version: 1,
      createdBy: caller.userId,
      createdAt: at,
      updatedAt: at,
    };
    await this.store.transaction(async (tx) => {
      await tx.putRightsWindow(window);
      await tx.enqueue(this.rightsAudit(caller, 'rights-window.created', window, undefined));
    });
    return window;
  }

  /** Replace a window's terms, over the version the caller read (409 if it moved). */
  async updateRightsWindow(
    caller: Caller,
    id: string,
    version: number,
    input: RightsWindowInput,
  ): Promise<RightsWindow> {
    this.authorizeRights(caller, 'asset:write');
    const current = await this.rightsWindowIn(caller, id);
    const { assetId: _a, categoryId: _c, territory: _t, notes: _n, ...kept } = current;
    void _a;
    void _c;
    void _t;
    void _n;
    const next: RightsWindow = {
      ...kept,
      ...input,
      version: version + 1,
      updatedAt: this.now().toISOString(),
    };
    await this.store.transaction(async (tx) => {
      if (!(await tx.putRightsWindow(next, version))) {
        throw new Conflict(`rights window ${id} is not at version ${version}; reload it`);
      }
      await tx.enqueue(this.rightsAudit(caller, 'rights-window.updated', next, current));
    });
    return next;
  }

  async deleteRightsWindow(caller: Caller, id: string, version: number): Promise<void> {
    this.authorizeRights(caller, 'asset:write');
    const current = await this.rightsWindowIn(caller, id);
    await this.store.transaction(async (tx) => {
      if (!(await tx.deleteRightsWindow(id, version))) {
        throw new Conflict(`rights window ${id} is not at version ${version}; reload it`);
      }
      await tx.enqueue(
        this.rightsAudit(
          caller,
          'rights-window.deleted',
          { ...current, version: current.version + 1 },
          current,
          true,
        ),
      );
    });
  }

  private async rightsWindowIn(caller: Caller, id: string): Promise<RightsWindow> {
    const window = await this.store.rightsWindow(id);
    // Another channel's window is not found, not forbidden: a 403 would confirm it exists.
    if (!window || window.channelId !== caller.channelId) {
      throw new NotFound(`rights window ${id}`);
    }
    return window;
  }

  private authorizeRights(caller: Caller, permission: 'asset:read' | 'asset:write'): void {
    const decision = canEnforce(caller.policy, permission, {
      type: 'asset',
      channelId: caller.channelId,
      fieldGroup: 'rights',
    });
    if (!decision.allowed) {
      throw new Forbidden(decision.reason ?? `${permission} on the rights field group required`);
    }
  }

  private rightsAudit(
    caller: Caller,
    action: string,
    after: RightsWindow,
    before: RightsWindow | undefined,
    deleted = false,
  ): OutboxRecord {
    return this.record(caller, after.channelId, 'audit.recorded', {
      entityType: 'rights-window',
      entityId: after.id,
      revision: after.version,
      action,
      origin: { service: 'scheduling' },
      delta: deleted
        ? delta(before as unknown as Record<string, unknown>, {}) // every field: before, no after
        : delta(
            before as unknown as Record<string, unknown> | undefined,
            after as unknown as Record<string, unknown>,
          ),
    } satisfies EventPayloads['audit.recorded']);
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

  /**
   * Copy a range of one reel onto another (§3.7, FR-SCH-13; copy.ts plans it). The source is read
   * under `schedule:read`, the target written under `schedule:write` — both this caller's channel —
   * and the write is a compare-and-set on the version the caller read of the TARGET: an overwrite
   * over a reel someone else has since edited would remove items they never saw. One write: the
   * target's whole reel, its `schedule.updated` and an `audit.recorded` (action `schedule.copied`)
   * whose delta is the reel before and after plus where it came from.
   */
  async copy(
    caller: Caller,
    sourceId: string,
    request: CopyRequest,
  ): Promise<{ schedule: Schedule; items: ScheduleItem[]; copied: number; removed: number }> {
    await this.get(caller, sourceId);
    const target = await this.get(caller, request.targetScheduleId);
    this.authorize(caller, 'schedule:write');
    if (target.version !== request.targetVersion) {
      throw new Conflict(
        `schedule ${target.id} is at version ${target.version}, not ${request.targetVersion}: reload it`,
      );
    }
    const source = await this.store.items(sourceId);
    const before = sourceId === target.id ? source : await this.store.items(target.id);
    const plan = planCopy(source, before, target.id, request);
    checkReel(plan.items);
    const next = this.bump(target);
    await this.commit(
      caller,
      next,
      target,
      { itemCount: plan.items.length },
      async (tx) => tx.replaceItems(target.id, plan.items),
      {
        items: { before: inReelOrder(before), after: inReelOrder(plan.items) },
        copiedFrom: {
          after: {
            scheduleId: sourceId,
            ...(request.from !== undefined ? { from: request.from, to: request.to } : {}),
            at: request.at,
            mode: request.mode,
          },
        },
      },
      { action: 'schedule.copied', ifVersion: target.version },
    );
    return {
      schedule: next,
      items: inReelOrder(plan.items),
      copied: plan.copied,
      removed: plan.removed,
    };
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

  /** Every edit: a new version, and a validated schedule is a draft again (§3.1 Validated → Draft). */
  private bump(schedule: Schedule): Schedule {
    return {
      ...schedule,
      ...(schedule.state === 'validated' ? { state: 'draft' as const } : {}),
      version: schedule.version + 1,
      updatedAt: this.now().toISOString(),
    };
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
    options: { action?: string; ifVersion?: number; also?: OutboxRecord[] } = {},
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
      action: options.action ?? (before === undefined ? 'schedule.created' : 'schedule.updated'),
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
      if (!(await tx.put(schedule, options.ifVersion))) {
        throw new Conflict(
          options.action === 'schedule.validated'
            ? `schedule ${schedule.id} changed while it was being validated; validate it again`
            : `schedule ${schedule.id} changed under this write; reload it and try again`,
        );
      }
      await also?.(tx);
      await tx.enqueue(updated);
      await tx.enqueue(audit);
      for (const record of options.also ?? []) await tx.enqueue(record);
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
