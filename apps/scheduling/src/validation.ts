// On-demand validation of a reel (EP-31; scheduling.md §6.2, FR-SCH-2/3) — pure.
//
// ADVISORY by design (data-model §3.4): the write path stores overlaps and gaps without comment,
// and this is where they are named. Six validators run:
//   - overlap  (critical) an item starts before the previous one ends, or a sub-schedule item runs
//              outside its live item or into its sibling;
//   - anchor   (critical) the same, where the item run into is FIXED — a time-locked start that
//              the playout will honour by cutting the item before it;
//   - gap      (warning)  dead air between two top-level items. Not critical: a filler may take it
//              at playout, and the editor flags rather than blocks it for the same reason. A gap
//              inside a live item is the studio's, not dead air, and is not reported;
//   - approval (critical) the media is not approved in this channel;
//   - expiry   (critical) the approval lapses before the item FINISHES airing — judged at air time,
//              not now, so tomorrow's schedule is refused today for an approval that ends at noon;
//   - rights   (critical) the item is governed by rights windows (its asset's, else its category's —
//              rights.ts) and lies wholly inside none of them.
//   - availability (critical) the rendition the item airs (its `renditionKind`, else `broadcast`)
//              is not online and intact in this channel's storage — HSM's answer, asked at
//              validation time (availability.ts). When HSM could not be asked, this validator
//              does not run and the report names it in `unchecked`, never silently.

import { DEFAULT_RENDITION, renditionKey, type RenditionState } from './availability.ts';
import type { MediaApproval } from './approvals.ts';
import { covered, governingWindows, type RightsWindow } from './rights.ts';
import { inReelOrder, type ScheduleItem } from './schedule.ts';

export type IssueKind =
  'gap' | 'overlap' | 'anchor' | 'approval' | 'expiry' | 'rights' | 'availability';
export type Severity = 'info' | 'warning' | 'critical';

export interface ValidationIssue {
  kind: IssueKind;
  /** The item the issue is reported ON — for an overlap, the item that starts too early. */
  itemId?: string;
  severity: Severity;
  message: string;
  /** gap/overlap/anchor: seconds of dead air or of overrun. */
  seconds?: number;
}

/** HSM's answers for the reel's renditions, and the channel they must be in. */
export interface ReelAvailability {
  channelId: string;
  states: ReadonlyMap<string, RenditionState>;
}

/** Why a rendition will not air, in the words of the report; `undefined` when it will. */
function unavailable(state: RenditionState | undefined, channelId: string): string | undefined {
  // Another channel's file is not this channel's to air: the same as none at all.
  if (state === undefined || !state.found || state.channelId !== channelId) {
    return 'is not in storage';
  }
  if (state.status === 'quarantined') return 'failed its checksum and is quarantined';
  if (state.status === 'missing') return 'is missing from storage';
  if (state.status === 'restoring') return 'is being restored and is not online yet';
  if (state.tier !== 'online') return `is on ${state.tier} storage and must be restored before air`;
  return undefined;
}

/** Wall-clock `HH:MM:SS` in the schedule's zone — what the person reading the report plans in. */
export function clock(timezone: string): (iso: string) => string {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    // An unknown zone was stored before zones were checked: say UTC rather than fail the report.
    return (iso) => `${iso.slice(11, 19)} UTC`;
  }
  return (iso) => format.format(new Date(iso));
}

const seconds = (ms: number): number => Math.round(ms / 1000);

function label(item: ScheduleItem): string {
  const name = item.mediaTitle ?? (item.description !== '' ? item.description : item.itemType);
  return `“${name}”`;
}

type Unapproved = Exclude<MediaApproval['state'], 'approved'>;
const isApproved = (state: MediaApproval['state']): state is 'approved' => state === 'approved';

const VERDICT_TEXT: Record<Unapproved, string> = {
  unknown: 'has no approval from MAM yet',
  rejected: 'was rejected in review',
  expired: 'approval has expired and needs re-review',
  deleted: 'was deleted from MAM',
};

export function validateReel(
  items: readonly ScheduleItem[],
  approvals: ReadonlyMap<string, MediaApproval>,
  timezone: string,
  rights: readonly RightsWindow[] = [],
  availability?: ReelAvailability,
): ValidationIssue[] {
  const t = clock(timezone);
  const issues: ValidationIssue[] = [];
  const reel = inReelOrder(items);
  const top = reel.filter((i) => i.parentItemId === undefined);

  // --- the top-level sequence ---------------------------------------------------------------------
  // `reach` is how far the reel has played so far — the LATEST end, not the previous item's: an
  // item wholly inside another is an overlap, and must not make the next one look like a gap.
  let reach: { end: number; item: ScheduleItem } | undefined;
  for (const item of top) {
    const start = Date.parse(item.start);
    if (reach !== undefined) {
      if (start < reach.end) {
        const over = seconds(reach.end - start);
        issues.push(
          item.fixed
            ? {
                kind: 'anchor',
                itemId: item.id,
                severity: 'critical',
                message: `${label(reach.item)} runs ${over} s into the fixed start of ${label(item)} at ${t(item.start)}`,
                seconds: over,
              }
            : {
                kind: 'overlap',
                itemId: item.id,
                severity: 'critical',
                message: `${label(item)} starts at ${t(item.start)}, ${over} s before ${label(reach.item)} ends`,
                seconds: over,
              },
        );
      } else if (start > reach.end) {
        const dead = seconds(start - reach.end);
        issues.push({
          kind: 'gap',
          itemId: item.id,
          severity: 'warning',
          message: `${dead} s of dead air before ${label(item)} at ${t(item.start)}`,
          seconds: dead,
        });
      }
    }
    const end = Date.parse(item.end);
    if (reach === undefined || end > reach.end) reach = { end, item };
  }

  // --- each live item's sub-schedule: inside its parent, and not over itself ----------------------
  for (const parent of top) {
    const children = reel.filter((i) => i.parentItemId === parent.id);
    let prev: ScheduleItem | undefined;
    for (const child of children) {
      if (
        Date.parse(child.start) < Date.parse(parent.start) ||
        Date.parse(child.end) > Date.parse(parent.end)
      ) {
        issues.push({
          kind: 'overlap',
          itemId: child.id,
          severity: 'critical',
          message: `${label(child)} runs outside its live item ${label(parent)} (${t(parent.start)}–${t(parent.end)})`,
        });
      }
      if (prev !== undefined && Date.parse(child.start) < Date.parse(prev.end)) {
        const over = seconds(Date.parse(prev.end) - Date.parse(child.start));
        issues.push({
          kind: 'overlap',
          itemId: child.id,
          severity: 'critical',
          message: `${label(child)} starts ${over} s before ${label(prev)} ends, inside ${label(parent)}`,
          seconds: over,
        });
      }
      prev = child;
    }
  }

  // --- the media: approved in this channel, and still approved when the item finishes ------------
  for (const item of reel) {
    if (item.mediaId === undefined) continue;
    // Rights first: an unlicensed slot is wrong whatever the review said about the media.
    const governed = governingWindows(item, rights);
    if (governed !== undefined && !covered(item.start, item.end, governed.windows)) {
      const spans = governed.windows
        .map((w) => `${w.validFrom.slice(0, 16)}–${w.validTo.slice(0, 16)}Z`)
        .join(', ');
      issues.push({
        kind: 'rights',
        itemId: item.id,
        severity: 'critical',
        message: `${label(item)} at ${t(item.start)}: outside the ${governed.by === 'asset' ? "media's" : "category's"} rights windows (${spans})`,
      });
    }
    if (availability !== undefined) {
      const kind = item.renditionKind ?? DEFAULT_RENDITION;
      const why = unavailable(
        availability.states.get(renditionKey(item.mediaId, kind)),
        availability.channelId,
      );
      if (why !== undefined) {
        issues.push({
          kind: 'availability',
          itemId: item.id,
          severity: 'critical',
          message: `${label(item)} at ${t(item.start)}: the ${kind} rendition of ${item.mediaId} ${why}`,
        });
      }
    }
    const approval = approvals.get(item.mediaId);
    const state = approval?.state ?? 'unknown';
    if (!isApproved(state)) {
      issues.push({
        kind: 'approval',
        itemId: item.id,
        severity: 'critical',
        message: `${label(item)} at ${t(item.start)}: media ${item.mediaId} ${VERDICT_TEXT[state]}`,
      });
      continue;
    }
    const expiresAt = approval?.expiresAt;
    if (expiresAt !== undefined && Date.parse(expiresAt) < Date.parse(item.end)) {
      const before = Date.parse(expiresAt) <= Date.parse(item.start) ? 'it airs' : 'it ends';
      issues.push({
        kind: 'expiry',
        itemId: item.id,
        severity: 'critical',
        message: `${label(item)} at ${t(item.start)}: the approval expires at ${expiresAt}, before ${before}`,
      });
    }
  }

  return issues;
}
