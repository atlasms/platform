import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSET_STATES,
  canTransition,
  eventFor,
  hasLapsed,
  isPurgeable,
  isSchedulable,
  missingMandatory,
  type AssetState,
  type LifecycleAction,
  type LifecycleContext,
} from '../src/lifecycle.ts';

const ctx = (over: Partial<LifecycleContext> = {}): LifecycleContext => ({
  state: 'created',
  hasRenditions: true,
  mandatoryFields: [],
  presentFields: [],
  ...over,
});

const ACTIONS: readonly LifecycleAction[] = [
  'startProcessing',
  'markReady',
  'approve',
  'reject',
  'expire',
  'purge',
];

/** Every edge the design permits, as (from, action, to). Everything else must be refused. */
const LEGAL: readonly [AssetState, LifecycleAction, AssetState][] = [
  ['created', 'startProcessing', 'processing'],
  ['processing', 'markReady', 'ready'],
  ['ready', 'approve', 'approved'],
  ['ready', 'reject', 'rejected'],
  ['approved', 'expire', 'expired'],
  ['expired', 'approve', 'approved'],
  ['expired', 'reject', 'rejected'],
  ['rejected', 'purge', 'rejected'],
];

// =============================================================================
// The transition table
// =============================================================================

test('every legal transition is permitted and lands in the right state', () => {
  for (const [from, action, to] of LEGAL) {
    const result = canTransition(ctx({ state: from }), action);
    assert.equal(result.allowed, true, `${from} --${action}--> should be legal: ${result.reason}`);
    assert.equal(result.next, to, `${from} --${action}--> expected ${to}`);
  }
});

test('SAFETY: every transition NOT in the table is refused', () => {
  // The exhaustive half, and the one that matters. A lifecycle bug is usually a missing refusal,
  // not a broken success path — and an asset that reaches `approved` without review is an asset
  // that can reach air without review.
  const legal = new Set(LEGAL.map(([from, action]) => `${from}:${action}`));

  for (const state of ASSET_STATES) {
    for (const action of ACTIONS) {
      if (legal.has(`${state}:${action}`)) continue;
      const result = canTransition(ctx({ state }), action);
      assert.equal(result.allowed, false, `${state} --${action}--> must be refused`);
      assert.match(result.reason ?? '', new RegExp(`cannot ${action}`));
    }
  }
});

test('SAFETY: an asset cannot skip review — created never reaches approved directly', () => {
  for (const action of ACTIONS) {
    const result = canTransition(ctx({ state: 'created' }), action);
    if (result.allowed) assert.equal(result.next, 'processing');
  }
});

test('a rejected asset cannot be resurrected by approving it', () => {
  // Rejected is terminal but for purging: a corrected version is a NEW asset with replacesId,
  // never the same record quietly flipping back to approved.
  const result = canTransition(ctx({ state: 'rejected' }), 'approve');
  assert.equal(result.allowed, false);
});

// =============================================================================
// EP-17.5 — the mandatory-metadata gate
// =============================================================================

test('markReady is refused while renditions are missing', () => {
  const result = canTransition(ctx({ state: 'processing', hasRenditions: false }), 'markReady');
  assert.equal(result.allowed, false);
  assert.match(result.reason ?? '', /renditions/);
});

test('markReady is refused while mandatory metadata is missing, and names what is missing', () => {
  const result = canTransition(
    ctx({
      state: 'processing',
      mandatoryFields: ['title', 'categoryId', 'durationSec'],
      presentFields: ['title'],
    }),
    'markReady',
  );

  assert.equal(result.allowed, false);
  // Naming the fields is the difference between an operator fixing it and filing a bug.
  assert.deepEqual(result.missing, ['categoryId', 'durationSec']);
  assert.match(result.reason ?? '', /categoryId, durationSec/);
});

test('markReady succeeds once every mandatory field is present', () => {
  const result = canTransition(
    ctx({
      state: 'processing',
      mandatoryFields: ['title', 'categoryId'],
      presentFields: ['title', 'categoryId', 'description'],
    }),
    'markReady',
  );
  assert.equal(result.allowed, true);
  assert.equal(result.next, 'ready');
});

test('the renditions gate is reported before the metadata gate, not merged', () => {
  // Telling someone "metadata missing" when the real blocker is a transcode still running sends
  // them to fix the wrong thing.
  const result = canTransition(
    ctx({ state: 'processing', hasRenditions: false, mandatoryFields: ['x'], presentFields: [] }),
    'markReady',
  );
  assert.match(result.reason ?? '', /renditions/);
  assert.equal(result.missing, undefined);
});

test('missingMandatory reports only what is absent', () => {
  assert.deepEqual(missingMandatory(ctx({ mandatoryFields: [], presentFields: [] })), []);
  assert.deepEqual(missingMandatory(ctx({ mandatoryFields: ['a', 'b'], presentFields: ['b'] })), [
    'a',
  ]);
});

// =============================================================================
// Time-bounded validity — the rule that keeps lapsed media off air
// =============================================================================

const NOW = new Date('2026-08-05T12:00:00.000Z');
const PAST = '2026-08-01T00:00:00.000Z';
const FUTURE = '2026-12-01T00:00:00.000Z';

test('SAFETY: an approved asset past its expiry is NOT schedulable, whatever the stored state says', () => {
  // The window between expiry and the scheduler's sweep is real. Trusting `state === approved`
  // alone would let lapsed media reach air during it.
  const lapsed = ctx({ state: 'approved', expiresAt: PAST });
  assert.equal(lapsed.state, 'approved');
  assert.equal(isSchedulable(lapsed, NOW), false);
});

test('an approved asset within its window, or with no expiry, is schedulable', () => {
  assert.equal(isSchedulable(ctx({ state: 'approved', expiresAt: FUTURE }), NOW), true);
  assert.equal(isSchedulable(ctx({ state: 'approved' }), NOW), true, 'no expiry ⇒ permanent');
});

test('SAFETY: no state other than approved is ever schedulable', () => {
  for (const state of ASSET_STATES) {
    if (state === 'approved') continue;
    assert.equal(
      isSchedulable(ctx({ state, expiresAt: FUTURE }), NOW),
      false,
      `${state} must not be schedulable`,
    );
  }
});

test('hasLapsed drives the expiry sweep, and only for approved assets', () => {
  assert.equal(hasLapsed(ctx({ state: 'approved', expiresAt: PAST }), NOW), true);
  assert.equal(hasLapsed(ctx({ state: 'approved', expiresAt: FUTURE }), NOW), false);
  assert.equal(hasLapsed(ctx({ state: 'approved' }), NOW), false, 'permanent assets never lapse');
  assert.equal(hasLapsed(ctx({ state: 'ready', expiresAt: PAST }), NOW), false);
});

test('an expired asset can be re-reviewed either way', () => {
  assert.equal(canTransition(ctx({ state: 'expired' }), 'approve').allowed, true);
  assert.equal(canTransition(ctx({ state: 'expired' }), 'reject').allowed, true);
});

test('isPurgeable fires only for rejected assets past retainUntil', () => {
  assert.equal(isPurgeable(ctx({ state: 'rejected', retainUntil: PAST }), NOW), true);
  assert.equal(isPurgeable(ctx({ state: 'rejected', retainUntil: FUTURE }), NOW), false);
  assert.equal(isPurgeable(ctx({ state: 'rejected' }), NOW), false, 'no retainUntil ⇒ keep');
  assert.equal(isPurgeable(ctx({ state: 'approved', retainUntil: PAST }), NOW), false);
});

// =============================================================================
// Events
// =============================================================================

test('each transition maps to its contract event', () => {
  assert.equal(eventFor('markReady'), 'asset.ready');
  assert.equal(eventFor('approve'), 'asset.approved');
  assert.equal(eventFor('reject'), 'asset.rejected');
  assert.equal(eventFor('expire'), 'asset.expired');
  assert.equal(eventFor('purge'), 'asset.deleted');
});

test('startProcessing emits nothing, deliberately', () => {
  // Nothing outside MAM acts on "renditions are being made"; an event nobody consumes is a
  // contract we would have to keep.
  assert.equal(eventFor('startProcessing'), undefined);
});
