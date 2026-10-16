// EP-25.3 — a task offered to a group or a role reaches whoever is in it NOW: resolved when the
// inbox is read (decided 2026-10-16), from IAM over a signed read (ADR-0008), cached briefly and
// forgotten on permissions.changed / group.membership.changed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope, subjectFor, ulid } from '@atlas/contracts';
import { InMemoryBroker, type Message } from '@atlas/messaging';
import { INTERNAL_SIGNATURE_HEADER, verifyInternal } from '@atlas/service-kit';
import {
  fakePrincipals,
  iamPrincipals,
  NotificationsService,
  sqliteInboxStore,
  startPrincipalInvalidation,
} from '../src/index.ts';

const CH = 'ch12';
const KEY = 'notifications-reads-iam-with-this-32-byte-key';

function taskFor(assignee: string, assigneeKind: 'user' | 'group' | 'role'): Message {
  const envelope = buildEnvelope({
    type: 'workflow.task.created',
    channelId: CH,
    payload: { taskId: ulid(), assignee, assigneeKind, kind: 'review' },
    actor: { kind: 'service', id: 'bms' },
  });
  return {
    id: envelope.messageId,
    subject: subjectFor(CH, 'workflow.task.created'),
    body: envelope,
  };
}

test('a role or group task is in the inbox of whoever holds it now — and nobody else’s', async () => {
  const principals = fakePrincipals({
    ana: [
      { kind: 'role', id: 'editor' },
      { kind: 'group', id: 'g-desk' },
    ],
    ben: [{ kind: 'role', id: 'viewer' }],
  });
  const service = new NotificationsService({ store: sqliteInboxStore(), principals });
  await service.consumeTaskCreated(taskFor('editor', 'role'));
  await service.consumeTaskCreated(taskFor('g-desk', 'group'));
  await service.consumeTaskCreated(taskFor('ana', 'user'));
  // A USER named like the role is not the role.
  await service.consumeTaskCreated(taskFor('editor', 'user'));

  const ana = await service.inbox({ userId: 'ana', channelId: CH });
  assert.equal(ana.partial, false);
  assert.deepEqual(ana.tasks.map((t) => `${t.assigneeKind}:${t.assignee}`).sort(), [
    'group:g-desk',
    'role:editor',
    'user:ana',
  ]);
  const ben = await service.inbox({ userId: 'ben', channelId: CH });
  assert.deepEqual(ben.tasks, []);

  // Ben is given the role: the open task is his on the next read — no fan-out ever happened.
  principals.table['ben'] = [{ kind: 'role', id: 'editor' }];
  assert.deepEqual(
    (await service.inbox({ userId: 'ben', channelId: CH })).tasks.map((t) => t.assignee),
    ['editor'],
  );
  // And not in another channel, whoever holds what.
  assert.deepEqual((await service.inbox({ userId: 'ana', channelId: 'ch99' })).tasks, []);
});

test('IAM away is not a failed read: what is offered by name, and `partial`', async () => {
  const principals = fakePrincipals({ ana: [{ kind: 'role', id: 'editor' }] });
  const unavailable: string[] = [];
  const service = new NotificationsService({
    store: sqliteInboxStore(),
    principals,
    onPrincipalsUnavailable: (_err, userId) => unavailable.push(userId),
  });
  await service.consumeTaskCreated(taskFor('editor', 'role'));
  await service.consumeTaskCreated(taskFor('ana', 'user'));
  principals.down = true;
  const inbox = await service.inbox({ userId: 'ana', channelId: CH });
  assert.equal(inbox.partial, true);
  assert.deepEqual(
    inbox.tasks.map((t) => t.assignee),
    ['ana'],
  );
  assert.deepEqual(unavailable, ['ana']);
});

test('the IAM client: signed for exactly its path, cached, shared while in flight, forgotten on change', async () => {
  const asked: string[] = [];
  let roles = ['editor'];
  let release: () => void = () => undefined;
  let gate: Promise<void> = Promise.resolve();
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    await gate;
    const header = (init?.headers as Record<string, string>)[INTERNAL_SIGNATURE_HEADER];
    const verdict = verifyInternal([KEY], { method: 'GET', path: url.pathname, body: '' }, header);
    assert.ok(verdict.ok, 'IAM would accept it');
    asked.push(url.pathname);
    if (url.pathname.includes('nobody')) return new Response('{}', { status: 404 });
    return Response.json({ userId: 'ana', groups: ['g-desk'], roles, permVersion: 1 });
  }) as typeof fetch;
  let clock = 0;
  const source = iamPrincipals({
    origin: 'http://iam:3000',
    key: KEY,
    ttlMs: 1000,
    fetchImpl,
    now: () => clock,
  });

  assert.deepEqual(await source.principalsOf('ana'), [
    { kind: 'group', id: 'g-desk' },
    { kind: 'role', id: 'editor' },
  ]);
  assert.equal(asked.length, 1);
  await source.principalsOf('ana');
  assert.equal(asked.length, 1, 'within the TTL: cached');
  clock = 1500;
  await source.principalsOf('ana');
  assert.equal(asked.length, 2, 'past the TTL: asked again');

  // A change is heard: forgotten, and the next read asks.
  roles = ['viewer'];
  source.forget('ana');
  assert.deepEqual(
    (await source.principalsOf('ana')).filter((p) => p.kind === 'role'),
    [{ kind: 'role', id: 'viewer' }],
  );

  // Concurrent reads share one request — and one that was in flight when the change came is
  // not cached after it.
  gate = new Promise((resolve) => (release = resolve));
  clock = 5000;
  const a = source.principalsOf('ana');
  const b = source.principalsOf('ana');
  source.forget('ana');
  release();
  await Promise.all([a, b]);
  const before = asked.length;
  await source.principalsOf('ana');
  assert.equal(asked.length, before + 1, 'the answer from before the change was not kept');

  assert.deepEqual(await source.principalsOf('nobody'), [], 'unknown or disabled: nobody');
});

test('permissions.changed and group.membership.changed reach EVERY replica’s cache', async () => {
  const broker = new InMemoryBroker();
  const replicaA = fakePrincipals();
  const replicaB = fakePrincipals();
  startPrincipalInvalidation({ broker, principals: replicaA });
  startPrincipalInvalidation({ broker, principals: replicaB });
  for (const [type, payload] of [
    ['permissions.changed', { userId: 'ana', permVersion: 4 }],
    [
      'group.membership.changed',
      { userId: 'ben', groupId: 'g-desk', action: 'added', at: new Date().toISOString() },
    ],
  ] as const) {
    const envelope = buildEnvelope({
      type,
      channelId: CH,
      payload,
      actor: { kind: 'service', id: 'iam' },
    });
    await broker.publish({ id: envelope.messageId, subject: subjectFor(CH, type), body: envelope });
  }
  assert.deepEqual(replicaA.forgotten, ['ana', 'ben']);
  assert.deepEqual(replicaB.forgotten, ['ana', 'ben']);
});
