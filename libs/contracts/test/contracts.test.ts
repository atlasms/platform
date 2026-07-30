import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ulid,
  isUlid,
  EVENT_TYPES,
  isEventType,
  validatePayload,
  buildEnvelope,
  follow,
  validateMessage,
  subjectFor,
  type Envelope,
} from '../src/index.ts';

test('every event payload schema loads and is keyed by type', () => {
  assert.ok(EVENT_TYPES.length >= 20, `found ${EVENT_TYPES.length} event types`);
  assert.ok(EVENT_TYPES.includes('asset.approved'));
  assert.ok(EVENT_TYPES.includes('transcode.completed'));
  assert.ok(isEventType('asset.rejected'));
  assert.equal(isEventType('nope.nope'), false);
});

test('ulid generates schema-valid ids', () => {
  for (let i = 0; i < 100; i++) assert.ok(isUlid(ulid()), 'ulid should match the schema pattern');
});

test('buildEnvelope + validateMessage round-trip for a real event', () => {
  const msg = buildEnvelope({
    type: 'asset.approved',
    channelId: 'ch12',
    payload: {
      assetId: ulid(),
      approver: 'user-1',
      approvedAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
    },
  });
  const res = validateMessage(msg as Envelope);
  assert.deepEqual(res.errors, []);
  assert.equal(res.valid, true);
  assert.match(msg.messageId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('validateMessage rejects a payload missing a required field', () => {
  const msg = buildEnvelope({
    type: 'asset.approved',
    channelId: 'ch12',
    payload: { approver: 'user-1' },
  }); // no assetId
  const res = validateMessage(msg as Envelope);
  assert.equal(res.valid, false);
  assert.ok(res.errors.length > 0);
});

test('validateMessage rejects an unknown event type', () => {
  const msg = buildEnvelope({ type: 'made.up', channelId: 'ch12', payload: {} });
  // envelope shape is fine (type pattern allows it); payload check fails on unknown type
  const res = validateMessage(msg as Envelope);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /unknown event type/.test(e.message)));
});

test('validatePayload validates a payload directly', () => {
  assert.equal(
    validatePayload('asset.rejected', { assetId: ulid(), reason: 'blurry' }).valid,
    true,
  );
  assert.equal(validatePayload('asset.rejected', { reason: 'blurry' }).valid, false); // no assetId
});

test('follow threads correlation + causation', () => {
  const root = buildEnvelope({
    type: 'ingest.accepted',
    channelId: 'ch12',
    payload: { assetId: ulid() } as any,
  });
  const next = follow(root as Envelope, {
    type: 'asset.created',
    channelId: 'ch12',
    payload: { assetId: ulid() } as any,
  });
  assert.equal(next.correlationId, root.messageId); // opened a correlation from the root
  assert.equal(next.causationId, root.messageId);
});

test('subjectFor builds a channel-scoped subject', () => {
  assert.equal(subjectFor('ch12', 'asset.approved'), 'atlas.ch12.asset.approved');
});
