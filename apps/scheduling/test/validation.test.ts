// The validator's edges, pure: no store, no service. The conformance suite drives the rest.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from '@atlas/contracts';
import {
  clock,
  endOf,
  parseRightsWindowInput,
  renditionKey,
  validateReel,
  type RenditionState,
  type MediaApproval,
  type ScheduleItem,
} from '../src/index.ts';

const T0 = Date.parse('2026-09-12T06:00:00.000Z');
const at = (min: number): string => new Date(T0 + min * 60_000).toISOString();
const SID = ulid();

function item(
  seq: number,
  startMin: number,
  durationMin: number,
  extra: Partial<ScheduleItem> = {},
): ScheduleItem {
  const start = at(startMin);
  return {
    id: ulid(),
    scheduleId: SID,
    seq,
    start,
    durationSec: durationMin * 60,
    end: endOf(start, durationMin * 60),
    fixed: false,
    itemType: 'filler',
    description: `item ${seq}`,
    repeat: false,
    featured: false,
    ...extra,
  };
}

const none = new Map<string, MediaApproval>();

test('an item wholly inside another is ONE overlap — the one after it is not a gap', () => {
  // 0–60, 10–20 (inside), 60–70: the reel has played to 60 when the third starts.
  const issues = validateReel([item(0, 0, 60), item(1, 10, 10), item(2, 60, 10)], none, 'UTC');
  assert.deepEqual(
    issues.map((i) => [i.kind, i.seconds]),
    [['overlap', 3000]],
  );
});

test('a tight reel with no media is clean; a gap is a warning, never critical', () => {
  assert.deepEqual(validateReel([item(0, 0, 30), item(1, 30, 30)], none, 'UTC'), []);
  const [gap] = validateReel([item(0, 0, 30), item(1, 45, 15)], none, 'UTC');
  assert.deepEqual([gap?.kind, gap?.severity, gap?.seconds], ['gap', 'warning', 900]);
  assert.equal(gap?.message, '900 s of dead air before “item 1” at 06:45:00');
});

test('a sub-schedule: siblings may not overlap, a gap inside a live item is the studio’s', () => {
  const parent = item(0, 0, 60, { itemType: 'live', description: 'studio' });
  const issues = validateReel(
    [
      parent,
      item(0, 5, 10, { parentItemId: parent.id }), //  05–15
      item(1, 10, 10, { parentItemId: parent.id }), // 10–20 overlaps its sibling
      item(2, 40, 10, { parentItemId: parent.id }), // 40–50 — a gap of 20 min, not reported
    ],
    none,
    'UTC',
  );
  assert.deepEqual(
    issues.map((i) => [i.kind, i.seconds]),
    [['overlap', 300]],
  );
});

test('expiry is judged against the item: before it airs, or before it ends — a permanent approval never lapses', () => {
  const [early, late, forever] = [ulid(), ulid(), ulid()];
  const approvals = new Map<string, MediaApproval>([
    [early, { assetId: early, channelId: 'ch', state: 'approved', expiresAt: at(0) }],
    [late, { assetId: late, channelId: 'ch', state: 'approved', expiresAt: at(35) }],
    [forever, { assetId: forever, channelId: 'ch', state: 'approved' }],
  ]);
  const issues = validateReel(
    [
      item(0, 0, 30, { itemType: 'media', mediaId: early }),
      item(1, 30, 30, { itemType: 'media', mediaId: late }),
      item(2, 60, 30, { itemType: 'media', mediaId: forever }),
    ],
    approvals,
    'UTC',
  );
  assert.deepEqual(
    issues.map((i) => i.message.replace(/^.*before /, 'before ')),
    ['before it airs', 'before it ends'],
  );
});

test('every verdict that is not an approval is critical, and says which', () => {
  const states = ['rejected', 'expired', 'deleted', 'unknown'] as const;
  const ids = states.map(() => ulid());
  const approvals = new Map<string, MediaApproval>(
    states.map((state, i) => [ids[i]!, { assetId: ids[i]!, channelId: 'ch', state }]),
  );
  const issues = validateReel(
    ids.map((mediaId, i) => item(i, i * 10, 10, { itemType: 'media', mediaId })),
    approvals,
    'UTC',
  );
  assert.deepEqual(
    issues.map((i) => [i.kind, i.severity]),
    states.map(() => ['approval', 'critical']),
  );
  assert.deepEqual(
    issues.map((i) => i.message.replace(/^.*: media \w+ /, '')),
    [
      'was rejected in review',
      'approval has expired and needs re-review',
      'was deleted from MAM',
      'has no approval from MAM yet',
    ],
  );
});

test('times are said in the schedule’s zone; a zone the runtime does not know says UTC', () => {
  assert.equal(clock('Asia/Tehran')('2026-09-12T06:00:00.000Z'), '09:30:00');
  assert.equal(clock('Not/AZone')('2026-09-12T06:00:00.000Z'), '06:00:00 UTC');
});

test('a rights window names one subject, a real interval and nothing it does not know', () => {
  const ok = parseRightsWindowInput({ categoryId: ' films ', validFrom: at(0), validTo: at(60) });
  assert.deepEqual(ok, { categoryId: 'films', validFrom: at(0), validTo: at(60) });
  for (const [body, reason] of [
    [{ validFrom: at(0), validTo: at(60) }, /exactly one of assetId or categoryId/],
    [{ assetId: 'not-a-ulid', validFrom: at(0), validTo: at(60) }, /assetId must be a ULID/],
    [
      { categoryId: 'films', validFrom: at(60), validTo: at(60) },
      /validTo must be after validFrom/,
    ],
    [{ categoryId: 'films', validFrom: 'soon', validTo: at(60) }, /validFrom is required/],
    [{ categoryId: 'films', validFrom: at(0), validTo: at(60), maxRuns: 3 }, /maxRuns is not/],
  ] as const) {
    assert.throws(() => parseRightsWindowInput(body), reason);
  }
});

test('availability: the rendition an item airs must be online, intact and this channel’s', () => {
  const ids = Array.from({ length: 8 }, () => ulid());
  const approvals = new Map<string, MediaApproval>(
    ids.map((id) => [id, { assetId: id, channelId: 'ch', state: 'approved' }]),
  );
  const state = (
    i: number,
    kind: string,
    over: Partial<RenditionState> = {},
  ): [string, RenditionState] => [
    renditionKey(ids[i]!, kind),
    {
      assetId: ids[i]!,
      kind,
      found: true,
      channelId: 'ch',
      tier: 'online',
      status: 'available',
      ...over,
    },
  ];
  const states = new Map<string, RenditionState>([
    state(0, 'broadcast'), // fine
    state(1, 'broadcast', { tier: 'near-line' }),
    state(2, 'broadcast', { status: 'quarantined' }),
    state(3, 'broadcast', { status: 'restoring' }),
    state(4, 'broadcast', { channelId: 'other' }), // another channel's file is not ours
    state(5, 'proxy'), // the item asks for the proxy, and it is there
    state(6, 'proxy'), // only a proxy: the default (broadcast) is not
    // 7: nothing at all
  ]);
  const reel = ids.map((id, i) =>
    item(i, i * 10, 10, {
      itemType: 'media',
      mediaId: id,
      ...(i === 5 ? { renditionKind: 'proxy' } : {}),
    }),
  );
  const issues = validateReel(reel, approvals, 'UTC', [], { channelId: 'ch', states });
  assert.ok(issues.every((i) => i.kind === 'availability' && i.severity === 'critical'));
  assert.deepEqual(
    issues.map((i) => [
      reel.findIndex((r) => r.id === i.itemId),
      i.message.replace(/^.* rendition of \S+ /, ''),
    ]),
    [
      [1, 'is on near-line storage and must be restored before air'],
      [2, 'failed its checksum and is quarantined'],
      [3, 'is being restored and is not online yet'],
      [4, 'is not in storage'],
      [6, 'is not in storage'],
      [7, 'is not in storage'],
    ],
  );
  // Not asked (HSM away or not configured): the validator does not run at all.
  assert.deepEqual(validateReel(reel, approvals, 'UTC'), []);
});
