import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryBroker } from '@atlas/messaging';
import { compile, type EffectivePolicy } from '@atlas/policy';
import {
  ConnectionRegistry,
  mayReceive,
  parseSubject,
  privateSubjectOwner,
  startBridge,
  type Connection,
  type ServerFrame,
} from '../src/index.ts';

const policyFor = (subjectId: string, permissions: string[]): EffectivePolicy =>
  compile({
    subjectId,
    permVersion: 1,
    rules: [{ id: 'r', permissions }],
  });

/** A connection that records what it was sent — no sockets involved. */
function fakeConn(over: Partial<Connection> = {}): Connection & { sent: ServerFrame[] } {
  const sent: ServerFrame[] = [];
  return {
    id: over.id ?? 'c1',
    userId: over.userId ?? 'user-1',
    channelId: over.channelId ?? 'ch12',
    policy: over.policy ?? policyFor(over.userId ?? 'user-1', ['asset:read', 'schedule:read']),
    send: (f) => sent.push(f),
    sent,
  };
}

const events = (c: { sent: ServerFrame[] }) => c.sent.filter((f) => f.type === 'event');

// --- subject parsing -------------------------------------------------------
test('subjects parse into channel + domain, and private streams are recognised', () => {
  assert.deepEqual(parseSubject('atlas.ch12.asset.approved'), {
    channelId: 'ch12',
    domain: 'asset',
    rest: ['approved'],
  });
  assert.equal(parseSubject('nope'), undefined);
  assert.equal(parseSubject('atlas.ch12'), undefined);

  assert.equal(privateSubjectOwner('user.user-7.task.created'), 'user-7');
  assert.equal(privateSubjectOwner('atlas.ch12.asset.approved'), undefined);
});

// --- EP-09.2 eligibility ---------------------------------------------------
test('a domain read grant admits that domain in the connection channel', () => {
  const sub = {
    userId: 'user-1',
    channelId: 'ch12',
    policy: policyFor('user-1', ['asset:read']),
  };
  assert.equal(mayReceive(sub, 'atlas.ch12.asset.approved').allowed, true);
  assert.equal(mayReceive(sub, 'atlas.ch12.schedule.updated').allowed, false);
});

test('SECURITY: tenant isolation beats even a wildcard grant', () => {
  // `*:read` on everything — but the connection authenticated into ch12.
  const sub = { userId: 'user-1', channelId: 'ch12', policy: policyFor('user-1', ['*:read']) };

  assert.equal(mayReceive(sub, 'atlas.ch12.asset.approved').allowed, true);
  const cross = mayReceive(sub, 'atlas.ch99.asset.approved');
  assert.equal(cross.allowed, false, 'a wildcard grant must not cross tenants');
  assert.match(cross.reason ?? '', /another channel/);
});

test('SECURITY: a private stream reaches its owner and nobody else, whatever their grants', () => {
  const owner = { userId: 'user-7', channelId: 'ch12', policy: policyFor('user-7', []) };
  const admin = { userId: 'user-1', channelId: 'ch12', policy: policyFor('user-1', ['*:*']) };

  assert.equal(mayReceive(owner, 'user.user-7.task.created').allowed, true);
  const stolen = mayReceive(admin, 'user.user-7.task.created');
  assert.equal(stolen.allowed, false, 'no permission grants someone else inbox');
  assert.match(stolen.reason ?? '', /another user/);
});

test('an unrecognised subject is refused rather than defaulted open', () => {
  const sub = { userId: 'u', channelId: 'ch12', policy: policyFor('u', ['*:*']) };
  assert.equal(mayReceive(sub, 'garbage').allowed, false);
  assert.equal(mayReceive(sub, 'user.').allowed, false);
});

// --- subscribe / fan-out ---------------------------------------------------
test('subscribing is refused at the door when not permitted', () => {
  const reg = new ConnectionRegistry();
  const c = fakeConn({ policy: policyFor('user-1', ['asset:read']) });
  reg.add(c);

  assert.equal(reg.subscribe('c1', 'atlas.ch12.asset.>').ok, true);
  assert.equal(c.sent.at(-1)?.type, 'subscribed');

  const bad = reg.subscribe('c1', 'atlas.ch12.schedule.>');
  assert.equal(bad.ok, false);
  assert.equal(c.sent.at(-1)?.type, 'error');
  assert.deepEqual(reg.subscriptionsOf('c1'), ['atlas.ch12.asset.>']);
});

test('SECURITY: a wildcard subscription cannot smuggle in another tenant', () => {
  const reg = new ConnectionRegistry();
  const c = fakeConn({ policy: policyFor('user-1', ['*:read']) });
  reg.add(c);

  // The literal prefix is what carries authority; `>` grants nothing by itself.
  assert.equal(reg.subscribe('c1', 'atlas.ch99.>').ok, false);
  assert.equal(reg.subscribe('c1', 'atlas.ch12.>').ok, true);

  reg.publish('atlas.ch99.asset.approved', { id: 'a' });
  assert.equal(events(c).length, 0, 'cross-tenant message must not be delivered');

  reg.publish('atlas.ch12.asset.approved', { id: 'b' });
  assert.equal(events(c).length, 1);
});

test('fan-out reaches only subscribed, eligible connections', () => {
  const reg = new ConnectionRegistry();
  const a = fakeConn({ id: 'a', userId: 'u-a' });
  const b = fakeConn({ id: 'b', userId: 'u-b' });
  const other = fakeConn({ id: 'x', userId: 'u-x', channelId: 'ch99' });
  for (const c of [a, b, other]) reg.add(c);

  reg.subscribe('a', 'atlas.ch12.asset.>');
  // b is connected but never subscribed.
  reg.subscribe('x', 'atlas.ch99.asset.>');

  const delivered = reg.publish('atlas.ch12.asset.approved', { id: '1' });
  assert.equal(delivered, 1);
  assert.equal(events(a).length, 1);
  assert.equal(events(b).length, 0);
  assert.equal(events(other).length, 0, 'other tenant must not receive');
});

test('SECURITY: eligibility is re-checked per message, not trusted from subscribe time', () => {
  const reg = new ConnectionRegistry();
  const c = fakeConn({ policy: policyFor('user-1', ['asset:read']) });
  reg.add(c);
  reg.subscribe('c1', 'atlas.ch12.asset.>');

  // Revoke directly on the live connection — simulating a grant lost between subscribe and
  // publish. The subscribe-time check is an early refusal, never the boundary.
  c.policy = policyFor('user-1', []);

  assert.equal(reg.publish('atlas.ch12.asset.approved', {}), 0);
  assert.equal(events(c).length, 0);
});

test('private streams fan out to the owner only', () => {
  const reg = new ConnectionRegistry();
  const owner = fakeConn({ id: 'o', userId: 'user-7' });
  const nosy = fakeConn({ id: 'n', userId: 'user-1', policy: policyFor('user-1', ['*:*']) });
  reg.add(owner);
  reg.add(nosy);

  assert.equal(reg.subscribe('o', 'user.user-7.>').ok, true);
  assert.equal(reg.subscribe('n', 'user.user-7.>').ok, false, 'cannot subscribe to another inbox');

  reg.publish('user.user-7.task.created', { taskId: 't1' });
  assert.equal(events(owner).length, 1);
  assert.equal(events(nosy).length, 0);
});

// --- EP-09.2 revocation ----------------------------------------------------
test('SECURITY: permissions.changed drops subscriptions immediately, not on reconnect', () => {
  const reg = new ConnectionRegistry();
  const c = fakeConn({ policy: policyFor('user-1', ['asset:read', 'schedule:read']) });
  reg.add(c);
  reg.subscribe('c1', 'atlas.ch12.asset.>');
  reg.subscribe('c1', 'atlas.ch12.schedule.>');
  assert.equal(reg.subscriptionsOf('c1').length, 2);

  // Schedule access revoked.
  const { dropped } = reg.applyPolicyChange('user-1', policyFor('user-1', ['asset:read']));

  assert.deepEqual(dropped, ['atlas.ch12.schedule.>']);
  assert.deepEqual(reg.subscriptionsOf('c1'), ['atlas.ch12.asset.>']);
  assert.equal(c.sent.at(-1)?.type, 'permissions-changed');

  // And the stream really stops — no waiting for the client to disconnect.
  reg.publish('atlas.ch12.schedule.updated', {});
  assert.equal(events(c).length, 0);
  reg.publish('atlas.ch12.asset.approved', {});
  assert.equal(events(c).length, 1, 'still-permitted subscriptions survive');
});

test('a policy change for another user leaves this connection alone', () => {
  const reg = new ConnectionRegistry();
  const c = fakeConn();
  reg.add(c);
  reg.subscribe('c1', 'atlas.ch12.asset.>');

  reg.applyPolicyChange('someone-else', policyFor('someone-else', []));
  assert.deepEqual(reg.subscriptionsOf('c1'), ['atlas.ch12.asset.>']);
});

// --- lifecycle -------------------------------------------------------------
test('removing a connection stops delivery and clears its subscriptions', () => {
  const reg = new ConnectionRegistry();
  const c = fakeConn();
  reg.add(c);
  reg.subscribe('c1', 'atlas.ch12.asset.>');
  assert.deepEqual(reg.stats(), { connections: 1, subscriptions: 1 });

  reg.remove('c1');
  assert.deepEqual(reg.stats(), { connections: 0, subscriptions: 0 });
  assert.equal(reg.publish('atlas.ch12.asset.approved', {}), 0);
});

test('unsubscribe stops delivery and acknowledges', () => {
  const reg = new ConnectionRegistry();
  const c = fakeConn();
  reg.add(c);
  reg.subscribe('c1', 'atlas.ch12.asset.>');
  reg.unsubscribe('c1', 'atlas.ch12.asset.>');

  assert.equal(c.sent.at(-1)?.type, 'unsubscribed');
  assert.equal(reg.publish('atlas.ch12.asset.approved', {}), 0);
});

// --- EP-09.3 the broker bridge --------------------------------------------
test('the bridge carries broker messages to eligible sockets', async () => {
  const broker = new InMemoryBroker();
  const reg = new ConnectionRegistry();
  startBridge({ broker, registry: reg });

  const c = fakeConn();
  reg.add(c);
  reg.subscribe('c1', 'atlas.ch12.asset.>');

  await broker.publish({ id: 'm1', subject: 'atlas.ch12.asset.approved', body: { assetId: 'a1' } });

  assert.equal(events(c).length, 1);
  assert.deepEqual(events(c)[0]?.payload, { assetId: 'a1' });
});

test('the bridge asks for a fresh policy on permissions.changed, then re-checks', async () => {
  const broker = new InMemoryBroker();
  const reg = new ConnectionRegistry();
  const c = fakeConn({ policy: policyFor('user-1', ['asset:read', 'schedule:read']) });
  reg.add(c);

  startBridge({
    broker,
    registry: reg,
    onPermissionsChanged: (userId) => {
      // In production this refetches /users/me/effective-permissions for the new permVersion.
      reg.applyPolicyChange(userId, policyFor(userId, ['asset:read']));
    },
  });

  reg.subscribe('c1', 'atlas.ch12.schedule.>');
  assert.equal(reg.subscriptionsOf('c1').length, 1);

  await broker.publish({
    id: 'm2',
    subject: 'atlas.ch12.permissions.changed',
    body: { userId: 'user-1' },
  });

  assert.deepEqual(reg.subscriptionsOf('c1'), [], 'revoked subscription dropped by the bridge');
});
