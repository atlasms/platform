// #240 — the `locked` state that nothing set.
//
// IAM refused a locked account correctly and had no way to reach that state, so an attacker could
// grind one known username forever at whatever rate they could drive the endpoint. The argon2 cost
// was a brake on throughput, not a limit.
//
// The clock is injected throughout. A lockout feature tested with real time either sleeps for
// fifteen minutes or asserts nothing about expiry, and the second is how "it unlocks eventually"
// becomes "it never unlocks" without a test noticing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearLock,
  DEFAULT_LOCKOUT,
  IamService,
  KeyRing,
  lockExpired,
  nextFailure,
  buildIamApp,
  type LockoutPolicy,
  type User,
} from '../src/index.ts';

const PASSWORD = 'correct horse battery';
const START = Date.parse('2026-08-07T12:00:00.000Z');

/** A fast policy, so a test can cross the threshold without twenty argon2 verifications. */
const FAST: LockoutPolicy = { threshold: 3, windowMs: 60_000, durationMs: 300_000 };

async function iam(lockout: Partial<LockoutPolicy> = FAST) {
  let clock = START;
  const keyRing = await KeyRing.create('k1');
  const service = new IamService({ keyRing, lockout, now: () => clock });
  const user = await service.createUser({ username: 'jo', password: PASSWORD, channelId: 'ch12' });
  return {
    service,
    user,
    app: buildIamApp({ service, keyRing }),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const wrong = async (service: IamService, times: number): Promise<void> => {
  for (let i = 0; i < times; i += 1) {
    await assert.rejects(service.login('jo', 'wrong'));
  }
};

// =============================================================================
// The policy, on its own
// =============================================================================

const asUser = (over: Partial<User> = {}): User => ({
  id: 'u1',
  username: 'jo',
  state: 'active',
  permVersion: 1,
  createdAt: new Date(START).toISOString(),
  ...over,
});

test('a run of failures accumulates, and trips at the threshold', () => {
  const policy: LockoutPolicy = { threshold: 3, windowMs: 60_000, durationMs: 60_000 };
  const first = nextFailure(asUser(), START, policy);
  assert.deepEqual(
    { n: first.failedAttempts, locked: first.locked },
    { n: 1, locked: false },
    'one failure is a typo, not an attack',
  );

  const second = nextFailure(
    asUser({ failedAttempts: 1, firstFailedAt: iso(START) }),
    START,
    policy,
  );
  assert.equal(second.locked, false);

  const third = nextFailure(
    asUser({ failedAttempts: 2, firstFailedAt: iso(START) }),
    START,
    policy,
  );
  assert.equal(third.failedAttempts, 3);
  assert.equal(third.locked, true);
});

test('a run that has aged out starts again rather than accumulating forever', () => {
  // Without this, three typos spread over three months lock the account — the counter would be a
  // lifetime total, which is not what "consecutive failures" means to anyone.
  const policy: LockoutPolicy = { threshold: 3, windowMs: 60_000, durationMs: 60_000 };
  const stale = asUser({ failedAttempts: 2, firstFailedAt: iso(START) });

  const next = nextFailure(stale, START + 60_001, policy);
  assert.equal(next.failedAttempts, 1, 'the old run is gone');
  assert.equal(next.locked, false);
  assert.equal(next.firstFailedAt, iso(START + 60_001), 'and the new run is dated now');
});

test('a threshold of 1 locks on the first failure', () => {
  // The boundary a `>` instead of a `>=` would break, and the fresh-run path is the one that
  // computes it separately.
  const policy: LockoutPolicy = { threshold: 1, windowMs: 60_000, durationMs: 60_000 };
  assert.equal(nextFailure(asUser(), START, policy).locked, true);
});

test('an automatic lock expires; an ADMINISTRATIVE one never does', () => {
  // The distinction is `lockedUntil`. An operator who locks an account for cause must not have the
  // clock quietly undo it — that would turn a deliberate act into a fifteen-minute inconvenience.
  const auto = asUser({ state: 'locked', lockedUntil: iso(START + 1_000) });
  assert.equal(lockExpired(auto, START), false, 'not yet');
  assert.equal(lockExpired(auto, START + 1_000), true, 'exactly at the boundary');

  const admin = asUser({ state: 'locked' });
  assert.equal(lockExpired(admin, START + 10 ** 9), false, 'an admin lock has no expiry to reach');

  assert.equal(lockExpired(asUser(), START), false, 'an active account is not an expired lock');
});

test('clearLock resets the state and the run together', () => {
  const user = asUser({
    state: 'locked',
    lockedUntil: iso(START),
    failedAttempts: 9,
    firstFailedAt: iso(START),
  });
  clearLock(user);
  assert.equal(user.state, 'active');
  assert.equal(user.lockedUntil, undefined);
  assert.equal(user.failedAttempts, undefined, 'unlocking into 9/10 failures is not unlocking');
});

test('the shipped default is not aggressive enough to train bad habits', () => {
  // Three attempts is the reflex choice and the wrong one: a user locked out for a fat-fingered
  // password twice learns to write it down. NIST SP 800-63B argues the same way.
  assert.ok(DEFAULT_LOCKOUT.threshold >= 5, 'a real user gets room to mistype');
  assert.ok(DEFAULT_LOCKOUT.durationMs > 0, 'and the lock must lift on its own');
});

// =============================================================================
// Against the service
// =============================================================================

test('SECURITY: repeated wrong passwords lock the account', async () => {
  const { service, user } = await iam();
  await wrong(service, FAST.threshold);

  assert.equal(user.state, 'locked');
  assert.equal(user.lockedUntil, iso(START + FAST.durationMs));

  // And the correct password no longer works — which is the entire point.
  await assert.rejects(service.login('jo', PASSWORD), /invalid username or password/);
});

test('SECURITY: the lock survives the RIGHT password and lifts on time', async () => {
  const { service, advance } = await iam();
  await wrong(service, FAST.threshold);

  advance(FAST.durationMs - 1);
  await assert.rejects(service.login('jo', PASSWORD), 'one millisecond early is still locked');

  advance(1);
  const pair = await service.login('jo', PASSWORD);
  assert.ok(pair.accessToken, 'and at the boundary the account is its owner’s again');
});

test('a success ends the run — near-misses do not accumulate across a lifetime', async () => {
  const { service, user } = await iam();
  await wrong(service, FAST.threshold - 1);
  assert.equal(user.failedAttempts, FAST.threshold - 1);

  await service.login('jo', PASSWORD);
  assert.equal(user.failedAttempts, undefined, 'the run is over');

  // Proof it really reset: another full-threshold-minus-one run still does not lock.
  await wrong(service, FAST.threshold - 1);
  assert.equal(user.state, 'active');
});

test('failures spread beyond the window never reach the threshold', async () => {
  const { service, user, advance } = await iam();
  for (let i = 0; i < FAST.threshold * 2; i += 1) {
    await assert.rejects(service.login('jo', 'wrong'));
    advance(FAST.windowMs + 1);
  }
  assert.equal(user.state, 'active', 'a slow trickle is a forgetful user, not an attack');
  assert.equal(user.failedAttempts, 1, 'each failure started its own run');
});

test('an operator can unlock immediately, including an administrative lock', async () => {
  const { service, user } = await iam();
  await wrong(service, FAST.threshold);
  assert.equal(user.state, 'locked');

  service.unlock(user.id);
  assert.ok(await service.login('jo', PASSWORD), 'back in without waiting out the clock');

  // An administrative lock has no expiry, so unlock() is the ONLY way out of it.
  user.state = 'locked';
  assert.equal(lockExpired(user, START + 10 ** 9), false);
  service.unlock(user.id);
  assert.equal(user.state, 'active');
});

test('unlocking an unknown user is refused, not silently ignored', async () => {
  const { service } = await iam();
  assert.throws(() => service.unlock('nobody'), /unknown user/);
});

test('SECURITY: an unknown username cannot be locked, so it cannot consume memory', async () => {
  // Failures are tracked on the USER RECORD, which is why this is safe. Keying a tracker on the
  // submitted username instead would let an attacker mint an entry per guess — an unbounded map
  // an attacker chooses the size of, which is a denial of service against the auth service itself.
  const { service } = await iam();
  for (let i = 0; i < 20; i += 1) {
    await assert.rejects(service.login(`ghost-${i}`, 'wrong'));
  }
  assert.equal(service.store.users.size, 1, 'no phantom records were created');
});

test('SECURITY: locking one account does not lock another', async () => {
  const { service } = await iam();
  const other = await service.createUser({ username: 'sam', password: PASSWORD });
  await wrong(service, FAST.threshold);

  assert.ok(await service.login('sam', PASSWORD), 'sam is unaffected');
  assert.equal(other.state, 'active');
});

// =============================================================================
// What the caller and the scraper can tell
// =============================================================================

test('SECURITY: a locked account is indistinguishable from a wrong password', async () => {
  // If the response said "locked", the endpoint would confirm the username exists — and worse, an
  // attacker could enumerate accounts by locking them on purpose.
  const { service, app } = await iam();
  await wrong(service, FAST.threshold);

  const locked = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { username: 'jo', password: PASSWORD },
  });
  const unknown = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { username: 'nobody', password: PASSWORD },
  });

  assert.equal(locked.statusCode, unknown.statusCode);
  assert.deepEqual(
    { ...(locked.json() as Record<string, unknown>), correlationId: null },
    { ...(unknown.json() as Record<string, unknown>), correlationId: null },
    'same status, same problem document — nothing distinguishes the two',
  );
});

test('SECURITY: a refused non-active account costs the same argon2 work as a wrong password', async () => {
  // The leak lockout would have made exploitable. Refusing on state used to return in microseconds
  // while a wrong password cost ~100ms, so timing alone said "this account exists and is not
  // active" — and an attacker who can CAUSE the lock could use it to confirm a username.
  const { service, user } = await iam();

  const time = async (fn: () => Promise<unknown>): Promise<number> => {
    const started = performance.now();
    await assert.rejects(fn());
    return performance.now() - started;
  };

  const badPassword = await time(() => service.login('jo', 'wrong'));
  user.state = 'disabled';
  const refusedState = await time(() => service.login('jo', PASSWORD));
  user.state = 'active';
  const unknownUser = await time(() => service.login('nobody', PASSWORD));

  // A generous bound: this asserts the argon2 verification HAPPENED on each path, not that the
  // timing is constant to the microsecond. The bug it catches is a path returning in ~0ms, which
  // is two orders of magnitude away, not a few percent.
  const floor = badPassword / 4;
  assert.ok(refusedState > floor, `state refusal took ${refusedState}ms vs ${badPassword}ms`);
  assert.ok(unknownUser > floor, `unknown user took ${unknownUser}ms vs ${badPassword}ms`);
});

test('the lockout EVENT is counted separately from attempts against a locked account', async () => {
  // Two different questions. `lockouts_total` fires once, when the door closes — that is the alert.
  // `login_attempts_total{outcome="locked"}` keeps climbing for as long as somebody keeps knocking,
  // which measures persistence, not incidents.
  const { service, app } = await iam();
  await wrong(service, FAST.threshold);
  await wrong(service, 3); // keep knocking

  const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;
  const value = (line: string): number => {
    const found = body.split('\n').find((l) => l.startsWith(line));
    return found === undefined ? 0 : Number(found.slice(found.lastIndexOf(' ') + 1));
  };

  assert.equal(value('atlas_iam_lockouts_total'), 1, 'one incident');
  assert.equal(
    value('atlas_iam_login_attempts_total{outcome="locked"}'),
    3,
    'three further knocks',
  );
});

test('the lock transition is audited', async () => {
  const { service, user } = await iam();
  await wrong(service, FAST.threshold);

  const locked = service.store.loginEvents.filter((e) => e.result === 'locked');
  assert.equal(locked.length, 1, 'the transition itself, not just the refusals after it');
  assert.equal(locked[0]?.userId, user.id);
  assert.match(locked[0]?.reason ?? '', /consecutive failures/);
});

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
