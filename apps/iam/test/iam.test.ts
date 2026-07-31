import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { can } from '@atlas/policy';
import {
  IamService,
  KeyRing,
  buildIamApp,
  hashPassword,
  needsRehash,
  seedStarterRoles,
  verifyPassword,
  STARTER_ROLES,
} from '../src/index.ts';

async function iam(over: { now?: () => number; refreshTokenTtlMs?: number } = {}) {
  const keyRing = await KeyRing.create('k1');
  const service = new IamService({ keyRing, issuer: 'atlas-iam', audience: 'atlas', ...over });
  seedStarterRoles(service.store.roles);
  const user = await service.createUser({
    username: 'jo',
    password: 'correct horse battery',
    channelId: 'ch12',
  });
  service.store.assignments.push({ userId: user.id, roleId: 'editor' });
  return { keyRing, service, user };
}

// --- EP-10.1 password hashing ---------------------------------------------
test('argon2id hashes are salted, self-describing and verify correctly', async () => {
  const a = await hashPassword('hunter2');
  const b = await hashPassword('hunter2');

  assert.notEqual(a, b, 'the same password must not produce the same hash — salts differ');
  assert.match(a, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);

  assert.equal(await verifyPassword('hunter2', a), true);
  assert.equal(await verifyPassword('hunter3', a), false);
  assert.equal(await verifyPassword('hunter2', b), true);
});

test('a malformed stored hash fails the login instead of throwing', async () => {
  // A corrupt row must not 500 the auth endpoint — that itself leaks that the account exists.
  for (const junk of ['', 'not-a-hash', '$argon2id$bad', '$bcrypt$v=19$m=1,t=1,p=1$aa$bb']) {
    assert.equal(await verifyPassword('x', junk), false);
  }
});

test('needsRehash spots credentials stored under weaker parameters', async () => {
  const current = await hashPassword('pw');
  assert.equal(needsRehash(current), false);

  const weak = await hashPassword('pw', { memory: 4096, passes: 1, parallelism: 1, tagLength: 32 });
  assert.equal(needsRehash(weak), true, 'an old cheap hash should be flagged for upgrade');
});

// --- EP-10.2 login --------------------------------------------------------
test('login issues a verifiable access token carrying permVersion, not rules', async () => {
  const { service, keyRing, user } = await iam();
  const pair = await service.login('jo', 'correct horse battery');

  const jwks = createLocalJWKSet(keyRing.jwks() as Parameters<typeof createLocalJWKSet>[0]);
  const { payload } = await jwtVerify(pair.accessToken, jwks, {
    issuer: 'atlas-iam',
    audience: 'atlas',
  });

  assert.equal(payload.sub, user.id);
  assert.equal(payload.channelId, 'ch12');
  assert.equal(payload.permVersion, 1);
  assert.ok(Array.isArray(payload.permissions));
  assert.ok((payload.permissions as string[]).includes('asset:write'));
  // The JWT stays small: grants are fetched once per permVersion, not embedded.
  assert.equal((payload as Record<string, unknown>)['rules'], undefined);
});

test('SECURITY: an unknown user and a wrong password are indistinguishable', async () => {
  const { service } = await iam();

  const errors: string[] = [];
  for (const [u, p] of [
    ['jo', 'wrong'],
    ['nobody', 'wrong'],
  ]) {
    await assert.rejects(service.login(u!, p!), (e: Error) => {
      errors.push(e.message);
      return true;
    });
  }
  assert.equal(errors[0], errors[1], 'the message must not reveal which failed');
  assert.match(errors[0] ?? '', /invalid username or password/);
});

test('a disabled account cannot log in, and the reason is audited but not returned', async () => {
  const { service, user } = await iam();
  user.state = 'disabled';

  await assert.rejects(
    service.login('jo', 'correct horse battery'),
    /invalid username or password/,
  );
  const ev = service.store.loginEvents.at(-1)!;
  assert.equal(ev.result, 'failure');
  assert.match(ev.reason ?? '', /account is disabled/);
});

// --- EP-10.2 refresh rotation ---------------------------------------------
test('refresh rotates the token and the old one stops working', async () => {
  const { service } = await iam();
  const first = await service.login('jo', 'correct horse battery');

  const second = await service.refresh(first.refreshToken);
  assert.notEqual(second.refreshToken, first.refreshToken, 'refresh tokens are single-use');
  assert.ok(second.accessToken.length > 0);
});

test('SECURITY: reusing a rotated refresh token revokes the WHOLE family', async () => {
  const { service } = await iam();
  const first = await service.login('jo', 'correct horse battery');
  const second = await service.refresh(first.refreshToken);
  const third = await service.refresh(second.refreshToken);

  // Replaying an already-rotated token is either a replay or a theft. Either way we cannot tell
  // which holder is genuine, so every descendant of that login is invalidated.
  await assert.rejects(service.refresh(first.refreshToken), /reuse detected/);

  // The currently-valid token is now dead too — that is the point.
  await assert.rejects(service.refresh(third.refreshToken), /invalid|reuse|revoked/);
});

test('an expired refresh token is refused', async () => {
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const { service } = await iam({ now: () => clock, refreshTokenTtlMs: 1000 });
  const pair = await service.login('jo', 'correct horse battery');

  clock += 2000;
  await assert.rejects(service.refresh(pair.refreshToken), /expired/);
});

test('logout revokes the session family and is idempotent', async () => {
  const { service } = await iam();
  const pair = await service.login('jo', 'correct horse battery');

  service.logout(pair.refreshToken);
  await assert.rejects(service.refresh(pair.refreshToken), /reuse detected|invalid/);

  service.logout(pair.refreshToken); // second call must not throw
  service.logout('never-existed'); // unknown token must not throw
});

test('logout allSessions kills tokens from other logins too', async () => {
  const { service } = await iam();
  const a = await service.login('jo', 'correct horse battery');
  const b = await service.login('jo', 'correct horse battery');

  service.logout(a.refreshToken, { allSessions: true });
  await assert.rejects(service.refresh(b.refreshToken), /reuse detected|invalid/);
});

// --- EP-10.3 keys ---------------------------------------------------------
test('rotation keeps the previous public key published — not a mass logout', async () => {
  const { service, keyRing } = await iam();
  const before = await service.login('jo', 'correct horse battery');

  await keyRing.rotate('k2');
  assert.equal(keyRing.active.kid, 'k2');
  assert.equal(keyRing.jwks().keys.length, 2, 'the retired key must still be published');

  // A token signed by the old key still verifies.
  const jwks = createLocalJWKSet(keyRing.jwks() as Parameters<typeof createLocalJWKSet>[0]);
  await jwtVerify(before.accessToken, jwks, { issuer: 'atlas-iam', audience: 'atlas' });

  // Dropping it finally invalidates those tokens.
  keyRing.drop('k1');
  const after = createLocalJWKSet(keyRing.jwks() as Parameters<typeof createLocalJWKSet>[0]);
  await assert.rejects(jwtVerify(before.accessToken, after));
});

test('the JWKS contains public halves only', async () => {
  const { keyRing } = await iam();
  for (const k of keyRing.jwks().keys) {
    assert.equal(k.kty, 'RSA');
    assert.ok(k.n && k.e, 'public modulus/exponent present');
    for (const priv of ['d', 'p', 'q', 'dp', 'dq', 'qi']) {
      assert.equal((k as Record<string, unknown>)[priv], undefined, `must not publish "${priv}"`);
    }
  }
});

// --- EP-10.5 effective policy ---------------------------------------------
test('effective policy is the union of user, role and group grants', async () => {
  const { service, user } = await iam();
  service.store.groups.set('g-approvers', {
    id: 'g-approvers',
    name: 'Approvers',
    roles: [service.store.roles.get('approver')!],
  });
  service.store.memberships.push({ userId: user.id, groupId: 'g-approvers' });

  const policy = service.effectivePolicy(user.id);
  assert.equal(policy.subjectId, user.id);
  assert.equal(can(policy, 'asset:write', { fieldGroup: 'core' }).allowed, true); // via editor role
  assert.equal(can(policy, 'asset:approve').allowed, true); // via group
  assert.equal(can(policy, 'user:admin').allowed, false);
  // Editors cannot touch rights fields.
  assert.equal(can(policy, 'asset:write', { fieldGroup: 'rights' }).allowed, false);
});

test('bumping permVersion is what makes revocation land within a token TTL', async () => {
  const { service, user } = await iam();
  const before = await service.login('jo', 'correct horse battery');
  assert.equal(before.permVersion, 1);

  assert.equal(service.bumpPermVersion(user.id), 2);
  const after = await service.login('jo', 'correct horse battery');
  assert.equal(after.permVersion, 2);
  // The edge refuses anything below the current version; the old token is now stale.
});

// --- EP-10.7 starter roles ------------------------------------------------
test('starter roles seed idempotently and keep send-to-air separate', async () => {
  const { service } = await iam();
  const added = seedStarterRoles(service.store.roles); // already seeded in the fixture
  assert.equal(added, 0, 're-seeding must not duplicate');
  assert.equal(service.store.roles.size, STARTER_ROLES.length);

  // schedule:send is deliberately NOT part of Scheduler — putting media to air deserves its own
  // audited grant rather than arriving as a side effect of schedule editing.
  const scheduler = service.store.roles.get('scheduler')!;
  const perms = scheduler.rules.flatMap((r) => r.permissions);
  assert.ok(perms.includes('schedule:write'));
  assert.equal(perms.includes('schedule:send'), false);
  assert.ok(
    service.store.roles.get('send-to-air')!.rules[0]?.permissions.includes('schedule:send'),
  );
});

// --- EP-10.8 audit --------------------------------------------------------
test('every login attempt is recorded with ip and outcome', async () => {
  const { service, user } = await iam();

  await service.login('jo', 'correct horse battery', { ip: '10.0.0.5', userAgent: 'Studio/1.0' });
  await assert.rejects(service.login('jo', 'nope', { ip: '10.0.0.9' }));
  await assert.rejects(service.login('ghost', 'nope', { ip: '10.0.0.9' }));

  const events = service.store.loginEvents;
  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map((e) => e.result),
    ['success', 'failure', 'failure'],
  );
  assert.equal(events[0]?.ip, '10.0.0.5');
  assert.equal(events[0]?.userAgent, 'Studio/1.0');
  assert.equal(events[2]?.userId, undefined, 'an unknown username has no user id to record');
  assert.equal(user.lastIp, '10.0.0.5');
  assert.ok(user.lastLogin);
});

// --- HTTP surface ---------------------------------------------------------
test('the HTTP surface: login, refresh, jwks, effective-permissions', async () => {
  const { service, keyRing, user } = await iam();
  const app = buildIamApp({ service, keyRing });

  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { username: 'jo', password: 'correct horse battery' },
  });
  assert.equal(login.statusCode, 200);
  const pair = login.json();
  assert.ok(pair.accessToken && pair.refreshToken);

  const jwks = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
  assert.equal(jwks.statusCode, 200, 'JWKS must be reachable without a token');
  assert.equal(jwks.json().keys.length, 1);

  const refreshed = await app.inject({
    method: 'POST',
    url: '/auth/refresh',
    payload: { refreshToken: pair.refreshToken },
  });
  assert.equal(refreshed.statusCode, 200);

  const perms = await app.inject({
    method: 'GET',
    url: '/api/v1/users/me/effective-permissions',
    headers: { 'x-atlas-user': user.id },
  });
  assert.equal(perms.statusCode, 200);
  assert.equal(perms.json().subjectId, user.id);
  assert.equal(perms.headers['etag'], 'W/"pv-1"', 'cacheable against permVersion');
});

test('HTTP: bad credentials are 401, and logout is always 204', async () => {
  const { service, keyRing } = await iam();
  const app = buildIamApp({ service, keyRing });

  const bad = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { username: 'jo', password: 'wrong' },
  });
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.json().code, 'UNAUTHORIZED');

  const missing = await app.inject({ method: 'POST', url: '/auth/login', payload: {} });
  assert.equal(missing.statusCode, 401, 'a malformed body must not 500');

  // 204 regardless: telling a caller whether the token existed is an oracle.
  const out = await app.inject({
    method: 'POST',
    url: '/auth/logout',
    payload: { refreshToken: 'never-existed' },
  });
  assert.equal(out.statusCode, 204);
});

test('effective-permissions requires an established subject', async () => {
  const { service, keyRing } = await iam();
  const app = buildIamApp({ service, keyRing });
  const res = await app.inject({ method: 'GET', url: '/api/v1/users/me/effective-permissions' });
  assert.equal(res.statusCode, 401);
});
