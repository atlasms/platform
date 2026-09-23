// EP-10.4 — the admin surface; EP-10.6 — what it emits. Through the HTTP routes where the
// contract is the thing under test, through IamAdmin where the transaction is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteOutboxStore } from '@atlas/data';
import { validateMessage, type Envelope } from '@atlas/contracts';
import {
  buildIamApp,
  IamAdmin,
  IamService,
  KeyRing,
  seedStarterRoles,
  sqliteIamStore,
  type Assignment,
  type Group,
  type StoredRole,
  type User,
} from '../src/index.ts';

const PASSWORD = 'correct horse battery';

/**
 * Two admins and a user: `root` holds an unscoped user:admin, `chAdmin` holds it for ch12 only,
 * `jo` is an ordinary ch12 user. The outbox is read straight from the double's table.
 */
async function harness() {
  const store = sqliteIamStore();
  const keyRing = await KeyRing.create('k1');
  const service = new IamService({ keyRing, store });
  await seedStarterRoles(store);
  const root = await service.createUser({ username: 'root', password: PASSWORD });
  const chAdmin = await service.createUser({
    username: 'admin12',
    password: PASSWORD,
    channelId: 'ch12',
  });
  const jo = await service.createUser({ username: 'jo', password: PASSWORD, channelId: 'ch12' });
  await store.transaction(async (tx) => {
    await tx.putAssignment({
      id: 'root-admin',
      userId: root.id,
      rule: { id: 'root-admin', permissions: ['user:admin'] },
    });
    await tx.putAssignment({
      id: 'ch12-admin',
      userId: chAdmin.id,
      rule: { id: 'ch12-admin', permissions: ['user:admin'], scope: { channelIds: ['ch12'] } },
    });
  });
  const admin = new IamAdmin({ service, store });
  const app = buildIamApp({ service, keyRing, admin });
  const outbox = new SqliteOutboxStore(store.db);
  const emitted = async () => {
    const records = await outbox.listUnsent(1000);
    return records.map((r) => ({ subject: r.message.subject, body: r.message.body as Envelope }));
  };
  const as = (user: User) => ({
    'x-atlas-user': user.id,
    ...(user.channelId ? { 'x-atlas-channel': user.channelId } : {}),
    'content-type': 'application/json',
  });
  return { store, service, admin, app, root, chAdmin, jo, emitted, as };
}

const rootCaller = (root: User) => ({ userId: root.id });
const chCaller = (u: User) => ({ userId: u.id, channelId: 'ch12' });

test('a grant is one transaction: the assignment, the bumped permVersion and permissions.changed', async () => {
  const h = await harness();
  const before = (await h.store.user(h.jo.id))!;
  const a = await h.admin.createAssignment(chCaller(h.chAdmin), h.jo.id, { roleId: 'editor' });
  assert.equal(a.roleId, 'editor');

  const after = (await h.store.user(h.jo.id))!;
  assert.equal(after.permVersion, before.permVersion + 1);
  assert.equal(after.version, before.version + 1);
  const policy = await h.service.effectivePolicy(h.jo.id);
  assert.ok(policy.rules.flatMap((r) => r.permissions).includes('asset:write'));

  const events = await h.emitted();
  const changed = events.find((e) => e.subject === 'atlas.ch12.permissions.changed');
  assert.ok(changed, 'permissions.changed rides out with the grant');
  assert.deepEqual(changed.body.payload, { userId: h.jo.id, permVersion: after.permVersion });
  assert.equal(changed.body.actor?.id, h.chAdmin.id);
  const audit = events.find((e) => e.subject === 'atlas.ch12.audit.recorded');
  assert.ok(audit);
  const payload = audit.body.payload as {
    entityType: string;
    revision: number;
    delta: Record<string, unknown>;
  };
  assert.equal(payload.entityType, 'user');
  assert.equal(payload.revision, after.version);
  assert.ok(payload.delta['assignments'], 'the grant is in the delta as a side table');
  for (const e of events) assert.deepEqual(validateMessage(e.body), { valid: true, errors: [] });

  await h.admin.deleteAssignment(chCaller(h.chAdmin), h.jo.id, a.id);
  assert.equal((await h.store.user(h.jo.id))!.permVersion, before.permVersion + 2);
  assert.deepEqual(await h.store.assignments(h.jo.id), []);
});

test('SECURITY: a channel admin reaches only their channel; another channel’s user is NOT FOUND', async () => {
  const h = await harness();
  const other = await h.service.createUser({
    username: 'ann',
    password: PASSWORD,
    channelId: 'ch99',
  });
  await assert.rejects(h.admin.getUser(chCaller(h.chAdmin), other.id), /not found|user/i);
  await assert.rejects(
    h.admin.createAssignment(chCaller(h.chAdmin), other.id, { roleId: 'viewer' }),
    (e: { status?: number }) => e.status === 404,
  );
  // A platform-wide row needs an unscoped grant: the channel admin cannot see root, nor create
  // a platform group, nor write an unscoped rule.
  await assert.rejects(
    h.admin.getUser(chCaller(h.chAdmin), h.root.id),
    (e: { status?: number }) => e.status === 404,
  );
  await assert.rejects(
    h.admin.createGroup(chCaller(h.chAdmin), { name: 'Everyone', channelId: null }),
    (e: { status?: number }) => e.status === 403,
  );
  await assert.rejects(
    h.admin.createAssignment(chCaller(h.chAdmin), h.jo.id, {
      rule: { id: 'wide', permissions: ['asset:read'] },
    }),
    (e: { status?: number; message: string }) => e.status === 403 && /unscoped/.test(e.message),
  );
  await assert.rejects(
    h.admin.createAssignment(chCaller(h.chAdmin), h.jo.id, {
      rule: { id: 'elsewhere', permissions: ['asset:read'], scope: { channelIds: ['ch99'] } },
    }),
    (e: { status?: number }) => e.status === 403,
  );
  // And a user with no admin grant at all is refused everything.
  await assert.rejects(
    h.admin.listUsers(chCaller(h.jo)),
    (e: { status?: number }) => e.status === 403,
  );
  // The unscoped admin reaches all of it.
  assert.equal((await h.admin.getUser(rootCaller(h.root), other.id)).id, other.id);
  const everyone = await h.admin.createGroup(rootCaller(h.root), {
    name: 'Everyone',
    channelId: null,
  });
  assert.equal(everyone.channelId, undefined);
});

test('membership: group.membership.changed and permissions.changed, idempotent both ways', async () => {
  const h = await harness();
  const group = await h.admin.createGroup(chCaller(h.chAdmin), {
    name: 'Approvers',
    roleIds: ['approver'],
  });
  await h.admin.addMember(chCaller(h.chAdmin), group.id, h.jo.id);
  await h.admin.addMember(chCaller(h.chAdmin), group.id, h.jo.id); // twice: no second event
  const policy = await h.service.effectivePolicy(h.jo.id);
  assert.ok(policy.rules.flatMap((r) => r.permissions).includes('asset:approve'));

  const events = await h.emitted();
  const membership = events.filter((e) => e.subject === 'atlas.ch12.group.membership.changed');
  assert.equal(membership.length, 1);
  assert.deepEqual(
    { ...(membership[0]!.body.payload as object), at: undefined },
    {
      userId: h.jo.id,
      groupId: group.id,
      action: 'added',
      permVersion: 2,
      by: h.chAdmin.id,
      at: undefined,
    },
  );
  assert.equal(events.filter((e) => e.subject === 'atlas.ch12.permissions.changed').length, 1);
  assert.deepEqual(await h.admin.listMembers(chCaller(h.chAdmin), group.id), [h.jo.id]);

  await h.admin.removeMember(chCaller(h.chAdmin), group.id, h.jo.id);
  await h.admin.removeMember(chCaller(h.chAdmin), group.id, h.jo.id);
  const after = await h.emitted();
  assert.equal(after.filter((e) => e.subject === 'atlas.ch12.group.membership.changed').length, 2);
  assert.equal((await h.store.user(h.jo.id))!.permVersion, 3);

  // A membership is a revision of the GROUP. The sink keys an entity's history on its revision and
  // refuses a repeat, so two group audits at one revision would be redelivered forever — which is
  // exactly what the smoke suite saw before the group's version moved with its members.
  await h.admin.updateGroup(chCaller(h.chAdmin), group.id, { name: 'Approvers (desk)' });
  await h.admin.deleteGroup(chCaller(h.chAdmin), group.id);
  const revisions = (await h.emitted())
    .filter((e) => e.subject === 'atlas.ch12.audit.recorded')
    .map(
      (e) =>
        e.body.payload as {
          entityType: string;
          entityId: string;
          revision: number;
          action: string;
        },
    )
    .filter((p) => p.entityType === 'group' && p.entityId === group.id)
    .map((p) => `${p.action}@${p.revision}`);
  assert.deepEqual(
    revisions,
    ['group.created@1', 'group.updated@2', 'group.updated@3', 'group.updated@4', 'group.deleted@5'],
    'created, joined, left, renamed, deleted: five revisions, none repeated, the deletion last',
  );
  // The member's own record was not what changed: their permVersion moved, their audited
  // revision did not — a bump without an audit would leave a hole in the user's history.
  assert.equal((await h.store.user(h.jo.id))!.version, 1);
});

test('editing a role reaches every holder — directly and through a group; deleting one in use is refused', async () => {
  const h = await harness();
  const direct = await h.service.createUser({
    username: 'd',
    password: PASSWORD,
    channelId: 'ch12',
  });
  const viaGroup = await h.service.createUser({
    username: 'g',
    password: PASSWORD,
    channelId: 'ch12',
  });
  const bystander = await h.service.createUser({
    username: 'b',
    password: PASSWORD,
    channelId: 'ch12',
  });
  const role = await h.admin.createRole(chCaller(h.chAdmin), {
    id: 'ch12-reporter',
    name: 'Reporter',
    rules: [{ id: 'r1', permissions: ['asset:read'], scope: { channelIds: ['ch12'] } }],
  });
  await h.admin.createAssignment(chCaller(h.chAdmin), direct.id, { roleId: role.id });
  const desk = await h.admin.createGroup(chCaller(h.chAdmin), { name: 'Desk', roleIds: [role.id] });
  await h.admin.addMember(chCaller(h.chAdmin), desk.id, viaGroup.id);
  const versions = async () =>
    Promise.all(
      [direct.id, viaGroup.id, bystander.id].map(
        async (id) => (await h.store.user(id))!.permVersion,
      ),
    );
  const before = await versions();

  await h.admin.updateRole(chCaller(h.chAdmin), role.id, {
    rules: [
      { id: 'r1', permissions: ['asset:read', 'asset:write'], scope: { channelIds: ['ch12'] } },
    ],
  });
  const after = await versions();
  assert.deepEqual(
    after,
    [before[0]! + 1, before[1]! + 1, before[2]!],
    'both holders bumped, the bystander not',
  );
  assert.ok(
    (await h.service.effectivePolicy(viaGroup.id)).rules
      .flatMap((r) => r.permissions)
      .includes('asset:write'),
  );
  // A name-only edit changes no grant and bumps nobody.
  await h.admin.updateRole(chCaller(h.chAdmin), role.id, { name: 'Senior reporter' });
  assert.deepEqual(await versions(), after);

  await assert.rejects(
    h.admin.deleteRole(chCaller(h.chAdmin), role.id),
    (e: { status?: number }) => e.status === 409,
  );
  await h.admin.deleteGroup(chCaller(h.chAdmin), desk.id);
  assert.equal(
    (await h.store.user(viaGroup.id))!.permVersion,
    after[1]! + 1,
    'losing the group bumps',
  );
  const assignments = await h.admin.listAssignments(chCaller(h.chAdmin), direct.id);
  await h.admin.deleteAssignment(chCaller(h.chAdmin), direct.id, (assignments[0] as Assignment).id);
  await h.admin.deleteRole(chCaller(h.chAdmin), role.id);
  assert.equal(await h.store.role(role.id), undefined);
});

test('who holds a role: directly, through a group, both at once — and what a revoker needs to act', async () => {
  const h = await harness();
  const caller = chCaller(h.chAdmin);
  const direct = await h.service.createUser({
    username: 'zoe',
    password: PASSWORD,
    channelId: 'ch12',
  });
  const member = await h.service.createUser({
    username: 'ana',
    password: PASSWORD,
    channelId: 'ch12',
  });
  const both = await h.service.createUser({
    username: 'bo',
    password: PASSWORD,
    channelId: 'ch12',
  });
  await h.service.createUser({ username: 'nobody', password: PASSWORD, channelId: 'ch12' });
  const role = await h.admin.createRole(caller, {
    id: 'ch12-reporter',
    name: 'Reporter',
    rules: [{ id: 'r1', permissions: ['asset:read'], scope: { channelIds: ['ch12'] } }],
  });

  assert.deepEqual(
    await h.admin.roleHolders(caller, role.id),
    { users: [], groups: [] },
    'a fresh role reaches nobody',
  );

  const assignment = await h.admin.createAssignment(caller, direct.id, { roleId: role.id });
  const bothAssignment = await h.admin.createAssignment(caller, both.id, { roleId: role.id });
  const desk = await h.admin.createGroup(caller, { name: 'Desk', roleIds: [role.id] });
  await h.admin.addMember(caller, desk.id, member.id);
  await h.admin.addMember(caller, desk.id, both.id);
  // A group that does NOT carry the role reaches nobody through it, however many members it has.
  const other = await h.admin.createGroup(caller, { name: 'Sport' });
  await h.admin.addMember(caller, other.id, member.id);

  const holders = await h.admin.roleHolders(caller, role.id);
  assert.deepEqual(
    holders.groups,
    [{ id: desk.id, name: 'Desk' }],
    'only the group that carries it',
  );
  assert.deepEqual(
    holders.users.map((u) => u.username),
    ['ana', 'bo', 'zoe'],
    'every person it reaches, once each, by username',
  );
  const [ana, bo, zoe] = holders.users;
  // The direct grant's id IS the revoke: no second request to read the user's assignments.
  assert.equal(zoe?.assignmentId, assignment.id);
  assert.deepEqual(zoe?.viaGroupIds, []);
  // Through a group only: nothing to revoke here, and the page can say which group to go to.
  assert.equal(ana?.assignmentId, undefined);
  assert.deepEqual(ana?.viaGroupIds, [desk.id]);
  // Both paths are one row carrying both facts.
  assert.equal(bo?.assignmentId, bothAssignment.id);
  assert.deepEqual(bo?.viaGroupIds, [desk.id]);

  // Revoking each path empties it, which is also the precondition `deleteRole` enforces.
  await h.admin.deleteAssignment(caller, direct.id, assignment.id);
  await h.admin.deleteAssignment(caller, both.id, bothAssignment.id);
  await h.admin.updateGroup(caller, desk.id, { roleIds: [] });
  assert.deepEqual(await h.admin.roleHolders(caller, role.id), { users: [], groups: [] });
  await h.admin.deleteRole(caller, role.id);
});

test('GET /roles/{id}/holders: the contract shape, and another channel’s role is 404 rather than 403', async () => {
  const h = await harness();
  const caller = chCaller(h.chAdmin);
  const role = await h.admin.createRole(caller, {
    id: 'ch12-reporter',
    name: 'Reporter',
    rules: [],
  });
  const assignment = await h.admin.createAssignment(caller, h.jo.id, { roleId: role.id });

  const res = await h.app.inject({
    method: 'GET',
    url: `/api/v1/roles/${role.id}/holders`,
    headers: h.as(h.chAdmin),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), {
    users: [{ id: h.jo.id, username: 'jo', viaGroupIds: [], assignmentId: assignment.id }],
    groups: [],
  });

  // A platform-wide role needs an unscoped grant to read, exactly as reading the role does: a
  // channel administrator is not told who holds the starter roles across the estate.
  const starter = await h.app.inject({
    method: 'GET',
    url: '/api/v1/roles/editor/holders',
    headers: h.as(h.chAdmin),
  });
  assert.equal(starter.statusCode, 404, starter.body);
  const asRoot = await h.app.inject({
    method: 'GET',
    url: '/api/v1/roles/editor/holders',
    headers: h.as(h.root),
  });
  assert.equal(asRoot.statusCode, 200, asRoot.body);

  const missing = await h.app.inject({
    method: 'GET',
    url: '/api/v1/roles/no-such-role/holders',
    headers: h.as(h.chAdmin),
  });
  assert.equal(missing.statusCode, 404);
});

test('disabling a user revokes every session, bumps, and emits user.updated + permissions.changed', async () => {
  const h = await harness();
  await h.service.login('jo', PASSWORD);
  await h.service.login('jo', PASSWORD);
  const updated = await h.admin.updateUser(chCaller(h.chAdmin), h.jo.id, { state: 'disabled' });
  assert.equal(updated.state, 'disabled');
  assert.ok((await h.store.userTokens(h.jo.id)).every((t) => t.revokedAt !== undefined));
  await assert.rejects(h.service.login('jo', PASSWORD));
  const events = await h.emitted();
  const upd = events.find((e) => e.subject === 'atlas.ch12.user.updated');
  assert.deepEqual(
    { ...(upd!.body.payload as object), at: undefined },
    { userId: h.jo.id, changed: ['state'], state: 'disabled', at: undefined },
  );
  assert.ok(events.some((e) => e.subject === 'atlas.ch12.permissions.changed'));

  // Re-enabling is the operator's unlock too: back in, and the password can be reset on the way.
  await h.admin.updateUser(chCaller(h.chAdmin), h.jo.id, {
    state: 'active',
    password: 'new pass phrase',
  });
  await h.service.login('jo', 'new pass phrase');
  const audit = (await h.emitted())
    .filter((e) => e.subject === 'atlas.ch12.audit.recorded')
    .at(-1)!;
  const delta = (audit.body.payload as { delta: Record<string, unknown> }).delta;
  assert.deepEqual(
    delta['password'],
    { after: '[changed]' },
    'the audit says a password changed, never what to',
  );
  assert.equal(delta['lastPasswordChange'] !== undefined, true);
});

test('the HTTP surface: the contract’s routes, the caller from the gateway headers, problems on refusal', async () => {
  const h = await harness();
  const created = await h.app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: h.as(h.chAdmin),
    payload: { username: 'newbie', password: PASSWORD, name: 'New' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const user = created.json<User>();
  assert.equal(user.channelId, 'ch12', "defaults to the caller's channel");
  assert.equal(user.version, 1);

  const dup = await h.app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: h.as(h.chAdmin),
    payload: { username: 'newbie' },
  });
  assert.equal(dup.statusCode, 409);
  assert.match(dup.headers['content-type'] as string, /problem\+json/);

  const listed = await h.app.inject({
    method: 'GET',
    url: '/api/v1/users?limit=2',
    headers: h.as(h.chAdmin),
  });
  const page = listed.json<{ items: User[]; nextCursor?: string }>();
  assert.equal(page.items.length, 2);
  assert.ok(page.nextCursor, 'three ch12 users, two per page');
  assert.ok(page.items.every((u) => u.channelId === 'ch12'));

  const granted = await h.app.inject({
    method: 'POST',
    url: `/api/v1/users/${user.id}/assignments`,
    headers: h.as(h.chAdmin),
    payload: { roleId: 'viewer' },
  });
  assert.equal(granted.statusCode, 201);
  const me = await h.app.inject({
    method: 'GET',
    url: '/api/v1/users/me/effective-permissions',
    headers: h.as(user),
  });
  assert.equal(me.statusCode, 200);
  assert.equal(me.headers['etag'], 'W/"pv-2"');
  assert.ok(
    me
      .json<{ rules: { permissions: string[] }[] }>()
      .rules.some((r) => r.permissions.includes('asset:read')),
  );
  const someoneElse = await h.app.inject({
    method: 'GET',
    url: `/api/v1/users/${h.chAdmin.id}/effective-permissions`,
    headers: h.as(user),
  });
  assert.equal(
    someoneElse.statusCode,
    404,
    'another user’s policy needs user:admin — and is not found without it, not forbidden',
  );

  const group = await h.app.inject({
    method: 'POST',
    url: '/api/v1/groups',
    headers: h.as(h.chAdmin),
    payload: { name: 'Ops', roleIds: ['viewer'] },
  });
  assert.equal(group.statusCode, 201, group.body);
  const ops = group.json<Group>().id;
  assert.equal(
    (
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/groups/${ops}/members`,
        headers: h.as(h.chAdmin),
        payload: { userId: user.id },
      })
    ).statusCode,
    204,
  );
  const withMembers = await h.app.inject({
    method: 'GET',
    url: `/api/v1/groups/${ops}`,
    headers: h.as(h.chAdmin),
  });
  assert.deepEqual(withMembers.json<Group & { members: string[] }>().members, [user.id]);
  assert.equal(
    (
      await h.app.inject({
        method: 'DELETE',
        url: `/api/v1/groups/${ops}/members?userId=${user.id}`,
        headers: h.as(h.chAdmin),
      })
    ).statusCode,
    204,
  );

  const roles = await h.app.inject({
    method: 'GET',
    url: '/api/v1/roles',
    headers: h.as(h.chAdmin),
  });
  assert.ok(
    roles.json<StoredRole[]>().some((r) => r.id === 'editor'),
    'the platform starter roles are listed',
  );
  const badRule = await h.app.inject({
    method: 'POST',
    url: '/api/v1/roles',
    headers: h.as(h.chAdmin),
    payload: { id: 'bad', rules: [{ id: 'x', permissions: ['not a permission'] }] },
  });
  assert.equal(badRule.statusCode, 422);
  assert.match(badRule.json<{ message: string }>().message, /resource:action/);

  const noCaller = await h.app.inject({ method: 'GET', url: '/api/v1/users' });
  assert.equal(noCaller.statusCode, 401);
  const notAdmin = await h.app.inject({ method: 'GET', url: '/api/v1/users', headers: h.as(h.jo) });
  assert.equal(notAdmin.statusCode, 403);
  assert.equal(notAdmin.json<{ code: string }>().code, 'FORBIDDEN');
  const gone = await h.app.inject({
    method: 'DELETE',
    url: `/api/v1/groups/${ops}`,
    headers: h.as(h.chAdmin),
  });
  assert.equal(gone.statusCode, 204, 'an empty body with the JSON header is not an error');
});
