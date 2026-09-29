// The schedule store: a port with two adapters, held to one conformance suite — MAM's shape.
//
// Rows with a MATERIALIZED `start`, `duration`, `seq` and a computed `end` (data-model.md §3.6),
// indexed on (channel, broadcast day, start) and on the (start, end) range, so "what is on air at
// T" is an index hit rather than a derivation. The write path stays thin: the store persists the
// reel it is given.

import type { OutboxRecord } from '@atlas/messaging';
import type { MediaApproval } from './approvals.ts';
import type { Schedule, ScheduleItem } from './schedule.ts';

export interface ScheduleStore {
  transaction<T>(fn: (tx: ScheduleTx) => Promise<T>): Promise<T>;
  get(id: string): Promise<Schedule | undefined>;
  /** One channel's schedules, newest broadcast day first, keyset on id. */
  list(
    channelId: string,
    options: { broadcastDate?: string; after?: string; limit: number },
  ): Promise<Schedule[]>;
  byDay(channelId: string, broadcastDate: string): Promise<Schedule | undefined>;
  items(scheduleId: string): Promise<ScheduleItem[]>;
  item(scheduleId: string, itemId: string): Promise<ScheduleItem | undefined>;
  /** Items on air in a channel within a window — the control-room read (§3.6). */
  onAir(channelId: string, from: string, to: string): Promise<ScheduleItem[]>;
  /** What MAM said about these assets' approval, in this channel (EP-31). Unknown ids are absent. */
  approvals(channelId: string, assetIds: readonly string[]): Promise<MediaApproval[]>;
  close(): Promise<void>;
}

export interface ScheduleTx {
  /**
   * Write the header. With `ifVersion`, only over that version (compare-and-set): `false` means
   * someone wrote in between and nothing was written.
   */
  put(schedule: Schedule, ifVersion?: number): Promise<boolean>;
  /** Replace the schedule's whole reel. Rows are deleted and re-inserted; ids are the caller's. */
  replaceItems(scheduleId: string, items: readonly ScheduleItem[]): Promise<void>;
  putItem(item: ScheduleItem): Promise<void>;
  /** Remove one item and — if it is a live item — its sub-schedule. */
  removeItem(scheduleId: string, itemId: string): Promise<void>;
  enqueue(record: OutboxRecord): Promise<void>;
  /** The consumer's dedup mark, in the same transaction as what it applies (EP-03.3). */
  markSeen(messageId: string): Promise<boolean>;
  /** An asset's approval record, read THROUGH the transaction and locked for its update. */
  approvalForUpdate(assetId: string): Promise<MediaApproval | undefined>;
  /**
   * Write an approval record. `existed: false` inserts only — `false` back means another consumer
   * created it first, and the caller retries rather than overwrite a fact it never read.
   */
  putApproval(approval: MediaApproval, existed: boolean): Promise<boolean>;
}
