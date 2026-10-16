// EP-25.3 — who a user is as an ADDRESSEE: their groups, and every role they hold directly or
// through a group, on a signed read-only internal route (ADR-0008). Notifications asks it when an
// inbox is read, so a task offered to a role reaches whoever holds the role now.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signInternal, INTERNAL_SIGNATURE_HEADER } from '@atlas/service-kit';
import {
  buildIamApp,
  IamService,
  KeyRing,
  seedStarterRoles,
  sqliteIamStore,
} from '../src/index.ts';

const READ_KEY = 'a-reader-key-for-the-suite-at-least-32-bytes-long';
const OTHER_KEY = 'some-other-services-key-also-at-least-32-bytes-long';

async function harness() {
  const store = sqliteIamStore();
  const keyRing = await KeyRing.create('k1');
  const service = new IamService({ keyRing, store });
  await seedStarterRoles(store);
  const jo = await service.createUser({
    username: 'jo',
    password: 'correct horse battery',
    channelId: 'ch12',
  });
  const refused: string[] = [];
  const app = buildIamApp({
    service,
    keyRing,
    readKeys: [READ_KEY],
    onInternalRefused: (reason) => refused.push(reason),
  });
  const ask = (userId: string, key: string | null = READ_KEY) => {
    const path = `/internal/v1/users/${userId}/principals`;
    return app.inject({
      method: 'GET',
      url: path,
      headers:
        key === null
          ? {}
          : { [INTERNAL_SIGNATURE_HEADER]: signInternal(key, { method: 'GET', path, body: '' }) },
    });
  };
  return { store, service, jo, app, ask, refused };
}

test('a user’s principals: their groups, and roles held directly AND through a group', async () => {
  const h = await harness();
  await h.store.transaction(async (tx) => {
    await tx.putAssignment({ id: 'a1', userId: h.jo.id, roleId: 'viewer' });
    // A rule-only grant is not a role: nothing to address.
    await tx.putAssignment({ id: 'a2', userId: h.jo.id, rule: { id: 'r', permissions: ['x:y'] } });
    await tx.putGroup({
      id: 'g-desk',
      channelId: 'ch12',
      name: 'Desk',
      roleIds: ['editor'],
      version: 1,
    });
    await tx.putGroup({ id: 'g-empty', channelId: 'ch12', name: 'Empty', version: 1 });
    await tx.putMembership({ userId: h.jo.id, groupId: 'g-desk' });
    await tx.putMembership({ userId: h.jo.id, groupId: 'g-empty' });
  });
  const res = await h.ask(h.jo.id);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json<{
    userId: string;
    groups: string[];
    roles: string[];
    permVersion: number;
  }>();
  assert.equal(body.userId, h.jo.id);
  assert.deepEqual(body.groups, ['g-desk', 'g-empty']);
  assert.deepEqual(body.roles, ['editor', 'viewer']);
  assert.equal(typeof body.permVersion, 'number');
});

test('signed with the READ key or not at all: unsigned, wrongly signed and unconfigured are 401', async () => {
  const h = await harness();
  assert.equal((await h.ask(h.jo.id, null)).statusCode, 401);
  assert.equal((await h.ask(h.jo.id, OTHER_KEY)).statusCode, 401);
  assert.equal(h.refused.length, 2, 'each refusal is reported where an operator sees it');

  // A signature over another path does not open this one.
  const path = `/internal/v1/users/${h.jo.id}/principals`;
  const forged = await h.app.inject({
    method: 'GET',
    url: path,
    headers: {
      [INTERNAL_SIGNATURE_HEADER]: signInternal(READ_KEY, {
        method: 'GET',
        path: '/internal/v1/users/someone-else/principals',
        body: '',
      }),
    },
  });
  assert.equal(forged.statusCode, 401);

  // An IAM with no read keys configured answers nobody.
  const keyRing = await KeyRing.create('k2');
  const closed = buildIamApp({ service: new IamService({ keyRing, store: h.store }), keyRing });
  const res = await closed.inject({
    method: 'GET',
    url: path,
    headers: {
      [INTERNAL_SIGNATURE_HEADER]: signInternal(READ_KEY, { method: 'GET', path, body: '' }),
    },
  });
  assert.equal(res.statusCode, 401);
});

test('an unknown or disabled user is addressed as nobody (404)', async () => {
  const h = await harness();
  assert.equal((await h.ask('no-such-user')).statusCode, 404);
  const user = (await h.store.user(h.jo.id))!;
  await h.store.transaction((tx) => tx.putUser({ ...user, state: 'disabled' }));
  assert.equal((await h.ask(h.jo.id)).statusCode, 404);
});
