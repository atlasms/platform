// EP-25.4 — chat messages through the routes (notifications.yaml), with the decisions of 2026-10-18
// as the assertions: `message:send` to send, to ANY user or group of the channel; a group's message
// read by whoever is in the group WHEN IT IS READ; a role is not addressable; the audit record holds
// the metadata, not the body; another channel never sees it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteOutboxStore } from '@atlas/data';
import type { Envelope } from '@atlas/contracts';
import { compile, type EffectivePolicy } from '@atlas/policy';
import {
  buildNotificationsApp,
  fakePrincipals,
  INTERNAL_HEADERS,
  Messages,
  NotificationsService,
  sqliteInboxStore,
  TaskActions,
  type Message,
} from '../src/index.ts';

const policyOf = (userId: string, permissions: string[]): EffectivePolicy =>
  compile({
    subjectId: userId,
    permVersion: 1,
    rules: permissions.length > 0 ? [{ id: 'r', permissions }] : [],
    roles: [],
    groups: [],
  });

async function harness() {
  const store = sqliteInboxStore();
  const principals = fakePrincipals({
    ana: [{ kind: 'group', id: 'g-desk' }],
    ben: [],
    cat: [{ kind: 'group', id: 'g-desk' }],
  });
  const grants: Record<string, string[]> = { ana: ['message:send'], ben: ['message:send'] };
  const app = await buildNotificationsApp({
    service: new NotificationsService({ store, principals }),
    tasks: new TaskActions({ store, principals }),
    messages: new Messages({ store, principals }),
    policyFor: (userId) => policyOf(userId, grants[userId] ?? []),
  });
  const call = (
    userId: string,
    method: 'GET' | 'POST',
    url: string,
    payload?: unknown,
    channel = 'ch12',
  ) =>
    app.inject({
      method,
      url,
      headers: {
        [INTERNAL_HEADERS.user]: userId,
        [INTERNAL_HEADERS.channel]: channel,
        'content-type': 'application/json',
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });
  const read = async (userId: string, channel = 'ch12') => {
    const res = await call(userId, 'GET', '/api/v1/messages', undefined, channel);
    assert.equal(res.statusCode, 200, res.body);
    return res.json<{ items: Message[]; partial: boolean }>();
  };
  const outbox = new SqliteOutboxStore(store.db);
  return { call, read, principals, outbox };
}

test('a message to a user and to a group: the sender, the user and the group’s members read it — nobody else', async () => {
  const h = await harness();
  const sent = await h.call('ben', 'POST', '/api/v1/messages', {
    to: [
      { kind: 'user', id: 'dan' },
      { kind: 'group', id: 'g-desk' }, // ben is not in it — any group of the channel will do
    ],
    body: 'Rundown at 6',
  });
  assert.equal(sent.statusCode, 201, sent.body);
  const m = sent.json<Message>();
  assert.deepEqual([m.from, m.channelId, m.body], ['ben', 'ch12', 'Rundown at 6']);

  for (const who of ['ben', 'dan', 'ana', 'cat'])
    assert.deepEqual(
      (await h.read(who)).items.map((x) => x.id),
      [m.id],
      `${who} reads it`,
    );
  assert.deepEqual((await h.read('eve')).items, [], 'not a recipient');
  assert.deepEqual((await h.read('dan', 'ch99')).items, [], 'another channel never sees it');
});

test('a group’s message is read by its members NOW: a joiner reads its history, a leaver does not', async () => {
  const h = await harness();
  const sent = await h.call('ana', 'POST', '/api/v1/messages', {
    to: [{ kind: 'group', id: 'g-desk' }],
    body: 'Desk only',
  });
  const id = sent.json<Message>().id;
  h.principals.table['eve'] = [{ kind: 'group', id: 'g-desk' }];
  h.principals.table['cat'] = [];
  assert.deepEqual(
    (await h.read('eve')).items.map((x) => x.id),
    [id],
    'joined: reads the history',
  );
  assert.deepEqual((await h.read('cat')).items, [], 'left: no longer reads it');
  // IAM away: what is theirs by name only, and the read says so.
  h.principals.down = true;
  const partial = await h.read('eve');
  assert.deepEqual([partial.items, partial.partial], [[], true]);
});

test('message:send to send; a role is not addressable; an empty or overlong body is refused', async () => {
  const h = await harness();
  const to = [{ kind: 'user', id: 'ana' }];
  assert.equal(
    (await h.call('cat', 'POST', '/api/v1/messages', { to, body: 'hi' })).statusCode,
    403,
  );
  const role = await h.call('ana', 'POST', '/api/v1/messages', {
    to: [{ kind: 'role', id: 'editor' }],
    body: 'hi',
  });
  assert.equal(role.statusCode, 422);
  assert.match(role.body, /role is not addressable/);
  for (const bad of [
    { to, body: '   ' },
    { to, body: 'x'.repeat(4001) },
    { to: [], body: 'hi' },
    { to, body: 'hi', cc: [] },
  ])
    assert.equal((await h.call('ana', 'POST', '/api/v1/messages', bad)).statusCode, 422);
});

test('sending is one transaction: message.sent, and an audit record of who wrote to whom — not what', async () => {
  const h = await harness();
  const sent = await h.call('ana', 'POST', '/api/v1/messages', {
    to: [{ kind: 'user', id: 'ben' }],
    body: 'Private words',
  });
  const id = sent.json<Message>().id;
  const envelopes = (await h.outbox.listUnsent(100)).map((r) => r.message.body as Envelope);
  const event = envelopes.find((e) => e.type === 'message.sent');
  assert.equal((event?.payload as { body?: string }).body, 'Private words');
  const audit = envelopes.find((e) => e.type === 'audit.recorded');
  const p = audit?.payload as {
    entityType: string;
    entityId: string;
    delta: Record<string, unknown>;
  };
  assert.deepEqual([p.entityType, p.entityId], ['message', id]);
  assert.ok(!('body' in p.delta), 'the body is not in the audit record');
  assert.deepEqual(p.delta['from'], { after: 'ana' });
});

test('the list pages newest first by id', async () => {
  const h = await harness();
  const ids: string[] = [];
  for (let i = 0; i < 3; i++)
    ids.push(
      (
        await h.call('ana', 'POST', '/api/v1/messages', {
          to: [{ kind: 'user', id: 'ben' }],
          body: `m${i}`,
        })
      ).json<Message>().id,
    );
  // Newest first means by id: ids minted in one millisecond need not be in sending order.
  ids.sort().reverse();
  const first = await h.call('ben', 'GET', '/api/v1/messages?limit=2');
  const page = first.json<{ items: Message[]; nextCursor?: string }>();
  assert.deepEqual(
    page.items.map((m) => m.id),
    [ids[0], ids[1]],
  );
  const second = await h.call('ben', 'GET', `/api/v1/messages?limit=2&after=${page.nextCursor}`);
  assert.deepEqual(
    second.json<{ items: Message[] }>().items.map((m) => m.id),
    [ids[2]],
  );
});
