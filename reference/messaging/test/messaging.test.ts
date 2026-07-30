import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchSubject, InMemoryBroker, InMemoryOutboxStore, OutboxRelay, InMemorySeenStore, idempotent,
  type Message,
} from '../src/index.ts';

const m = (id: string, subject: string, body: unknown = {}): Message => ({ id, subject, body });

test('subject matching: literals, *, and >', () => {
  assert.ok(matchSubject('atlas.ch12.asset.approved', 'atlas.ch12.asset.approved'));
  assert.ok(matchSubject('atlas.*.asset.*.ready', 'atlas.ch12.asset.x.ready'));
  assert.ok(matchSubject('atlas.ch12.>', 'atlas.ch12.asset.approved'));
  assert.equal(matchSubject('atlas.*.asset', 'atlas.ch12.asset.approved'), false); // too many tokens
  assert.equal(matchSubject('atlas.ch12.>', 'atlas.ch12'), false);                 // '>' needs >=1 token
  assert.equal(matchSubject('atlas.ch99.asset.approved', 'atlas.ch12.asset.approved'), false);
});

test('publish delivers to matching subscribers only', async () => {
  const broker = new InMemoryBroker();
  const got: string[] = [];
  broker.subscribe('atlas.*.asset.*.ready', (msg) => { got.push(msg.id); });
  broker.subscribe('atlas.ch12.transcode.>', (msg) => { got.push('T:' + msg.id); });
  await broker.publish(m('a', 'atlas.ch12.asset.x.ready'));
  await broker.publish(m('b', 'atlas.ch12.transcode.completed'));
  await broker.publish(m('c', 'atlas.ch12.asset.deleted')); // matches neither
  assert.deepEqual(got, ['a', 'T:b']);
});

test('failing handler retries then dead-letters', async () => {
  const broker = new InMemoryBroker();
  let attempts = 0;
  broker.subscribe('x.>', () => { attempts++; throw new Error('boom'); }, { maxAttempts: 3 });
  await broker.publish(m('1', 'x.y'));
  assert.equal(attempts, 3);
  assert.equal(broker.deadLetters.length, 1);
  assert.equal(broker.deadLetters[0].error, 'boom');
});

test('outbox relay drains once and is safe to re-run', async () => {
  const broker = new InMemoryBroker();
  const store = new InMemoryOutboxStore();
  const relay = new OutboxRelay(store, broker, () => 123);
  await store.add({ id: 'r1', message: m('1', 'atlas.ch12.asset.approved') });
  await store.add({ id: 'r2', message: m('2', 'atlas.ch12.asset.rejected') });

  assert.equal(await relay.drain(), 2);        // both relayed
  assert.equal(broker.published.length, 2);
  assert.equal(await relay.drain(), 0);        // nothing left — already marked sent
  assert.equal(broker.published.length, 2);
  assert.ok(store.all().every((r) => r.sentAt === 123));
});

test('idempotent consumer processes a redelivered message once', async () => {
  const broker = new InMemoryBroker();
  const seen = new InMemorySeenStore();
  let handled = 0;
  broker.subscribe('atlas.ch12.>', idempotent(() => { handled++; }, seen));
  const dup = m('same-id', 'atlas.ch12.asset.approved');
  await broker.publish(dup);
  await broker.publish(dup); // at-least-once redelivery
  assert.equal(handled, 1);
});

test('end-to-end: outbox -> broker -> idempotent consumer', async () => {
  const broker = new InMemoryBroker();
  const store = new InMemoryOutboxStore();
  const relay = new OutboxRelay(store, broker);
  const seen = new InMemorySeenStore();
  const received: string[] = [];
  broker.subscribe('atlas.ch12.>', idempotent((msg) => { received.push(msg.id); }, seen));

  await store.add({ id: 'o1', message: m('evt-1', 'atlas.ch12.asset.approved') });
  await relay.drain();
  await broker.publish(m('evt-1', 'atlas.ch12.asset.approved')); // duplicate from a retry
  assert.deepEqual(received, ['evt-1']);
});
