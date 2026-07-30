export type ScheduleState = 'draft' | 'validated' | 'sending' | 'sent' | 'failed';

export interface ScheduleItem {
  id: string;
  assetId: string;
  startAt: string;      // ISO
  durationSec: number;
  flagged?: string;     // set when the referenced asset stopped being usable (flag-not-drop)
}

export interface Schedule {
  id: string;
  channelId: string;
  state: ScheduleState;
  items: ScheduleItem[];
}

// Registry of currently-schedulable assets: present = approved; expiresAt = when it lapses.
export interface Schedulable { expiresAt?: string; }

export interface PlaylistSerializer {
  readonly format: string;
  serialize(scheduleId: string, items: ScheduleItem[]): string;
}

/** A trivial JSON serializer. The real exporter is pluggable (Cinegy MCRList first — FR-SCH-5). */
export const jsonPlaylist: PlaylistSerializer = {
  format: 'json',
  serialize: (scheduleId, items) => JSON.stringify({ scheduleId, items: items.map((i) => ({ assetId: i.assetId, startAt: i.startAt, durationSec: i.durationSec })) }),
};
