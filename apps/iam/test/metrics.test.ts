// #205 — IAM was the only Atlas service with no `/metrics` route and no golden signals, so
// Prometheus discovered it by pod annotation and reported the target down.
//
// The tests below are in two halves, and the second half is the one that matters. Exposing counts
// is easy; exposing them WITHOUT publishing who the accounts are is the part that can regress
// quietly, because a username label would work perfectly and break nothing until somebody reads
// the endpoint.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IamService, KeyRing, buildIamApp, seedStarterRoles } from '../src/index.ts';

const PASSWORD = 'correct horse battery';

async function iam(over: { now?: () => number; refreshTokenTtlMs?: number } = {}) {
  const keyRing = await KeyRing.create('k1');
  const service = new IamService({ keyRing, issuer: 'atlas-iam', audience: 'atlas', ...over });
  seedStarterRoles(service.store.roles);
  const user = await service.createUser({ username: 'jo', password: PASSWORD, channelId: 'ch12' });
  service.store.assignments.push({ userId: user.id, roleId: 'editor' });
  const app = buildIamApp({ service, keyRing });
  return { keyRing, service, user, app };
}

/** One sample's value, or undefined if the series was never created. */
function sample(exposition: string, name: string, labels: Record<string, string> = {}): number {
  const rendered = Object.entries(labels)
    .map(([k, v]) => `${k}="${v}"`)
    .join(',');
  const line = exposition
    .split('\n')
    .find((l) => l.startsWith(rendered === '' ? `${name} ` : `${name}{${rendered}}`));
  return line === undefined ? 0 : Number(line.slice(line.lastIndexOf(' ') + 1));
}

const scrape = async (app: Awaited<ReturnType<typeof iam>>['app']): Promise<string> => {
  const res = await app.inject({ method: 'GET', url: '/metrics' });
  assert.equal(res.statusCode, 200);
  return res.body;
};

// =============================================================================
// The endpoint exists at all
// =============================================================================

test('/metrics answers unauthenticated, in the Prometheus text format', async () => {
  // The whole issue in one assertion: a scraper is infrastructure, not a user, and it arrives with
  // no token. Requiring one is the same as having no endpoint.
  const { service, app } = await iam();
  await service.login('jo', PASSWORD);
  const res = await app.inject({ method: 'GET', url: '/metrics' });

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /^text\/plain; version=0\.0\.4/);
  assert.match(res.body, /^# HELP /m);
  assert.match(res.body, /^# TYPE /m);
});

test('a just-started process scrapes cleanly rather than failing', async () => {
  // A cold process has almost nothing to say. That must still be a 200 — a 500 or a 404 here shows
  // up as a DOWN target and pages somebody about a service that is perfectly healthy and idle.
  const { app } = await iam();
  const res = await app.inject({ method: 'GET', url: '/metrics' });

  assert.equal(res.statusCode, 200);
  // Not empty, and the one line present is the scrape COUNTING ITSELF: the request is in flight
  // while the body is being rendered. Standard for an in-flight gauge and worth knowing before
  // reading the saturation panel — an idle service reads 1, not 0.
  assert.equal(sample(res.body, 'atlas_http_requests_in_flight', { service: 'iam' }), 1);
  assert.ok(!res.body.includes('atlas_http_requests_total'), 'nothing has completed yet');
});

test('golden signals are recorded under service="iam"', async () => {
  // The dashboard shipped by the observability spike renders one panel per `service` label. IAM
  // was simply absent from it; this is the label that puts it there.
  const { app } = await iam();
  await app.inject({ method: 'GET', url: '/healthz' });

  const body = await scrape(app);
  assert.equal(
    sample(body, 'atlas_http_requests_total', {
      service: 'iam',
      method: 'GET',
      route: '/healthz',
      status: '2xx',
    }),
    1,
  );
});

test('JWKS latency is observable, under its route template', async () => {
  // Named in the issue: every service verifies tokens against this document, so its latency is on
  // the critical path of every authenticated request in the platform. It needs no bespoke metric —
  // the golden-signal histogram covers it once the route is labelled.
  const { app } = await iam();
  await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });

  const body = await scrape(app);
  const labels = { service: 'iam', method: 'GET', route: '/.well-known/jwks.json' };
  assert.equal(sample(body, 'atlas_http_request_duration_seconds_count', labels), 1);
  assert.ok(
    body.includes('atlas_http_request_duration_seconds_bucket'),
    'buckets are exposed, so a quantile is computable at query time',
  );
});

test('saturation is recorded and returns to zero', async () => {
  // The panel that was permanently empty: nothing in any service touched the in-flight gauge, so
  // the saturation signal read "no load" forever. The failure mode of the fix is the opposite —
  // a gauge that only ever climbs — so what is asserted is that it comes back DOWN.
  const { app } = await iam();
  for (let i = 0; i < 3; i += 1) await app.inject({ method: 'GET', url: '/healthz' });

  const body = await scrape(app);
  assert.equal(
    sample(body, 'atlas_http_requests_in_flight', { service: 'iam' }),
    1,
    'exactly the scrape itself — the three finished requests were all counted back out',
  );
});

test('a failed login is still counted as HTTP traffic', async () => {
  // The onResponse hook fires for 4xx as well, or the error rate would read zero during exactly
  // the incident it exists to show.
  const { app } = await iam();
  await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { username: 'jo', password: 'wrong' },
  });

  const body = await scrape(app);
  assert.equal(
    sample(body, 'atlas_http_requests_total', {
      service: 'iam',
      method: 'POST',
      route: '/auth/login',
      status: '4xx',
    }),
    1,
  );
});

// =============================================================================
// The auth-specific signals
// =============================================================================

test('login attempts are counted by outcome, not lumped into one failure count', async () => {
  // "Failed logins are up" is not actionable. A spike of unknown_user is username enumeration; a
  // spike of bad_password against known accounts is credential stuffing. Different responses.
  const { service, app } = await iam();

  await service.login('jo', PASSWORD);
  await assert.rejects(service.login('jo', 'wrong'));
  await assert.rejects(service.login('nobody', 'wrong'));

  const body = await scrape(app);
  assert.equal(sample(body, 'atlas_iam_login_attempts_total', { outcome: 'success' }), 1);
  assert.equal(sample(body, 'atlas_iam_login_attempts_total', { outcome: 'bad_password' }), 1);
  assert.equal(sample(body, 'atlas_iam_login_attempts_total', { outcome: 'unknown_user' }), 1);
});

test('a non-active account is counted under its own state', async () => {
  // The outcome IS the user state here, so the label set cannot drift from UserState.
  const { service, user, app } = await iam();
  user.state = 'locked';
  await assert.rejects(service.login('jo', PASSWORD));

  user.state = 'disabled';
  await assert.rejects(service.login('jo', PASSWORD));

  const body = await scrape(app);
  assert.equal(sample(body, 'atlas_iam_login_attempts_total', { outcome: 'locked' }), 1);
  assert.equal(sample(body, 'atlas_iam_login_attempts_total', { outcome: 'disabled' }), 1);
  assert.equal(
    sample(body, 'atlas_iam_login_attempts_total', { outcome: 'bad_password' }),
    0,
    'a refused state is not a wrong password — conflating them hides both',
  );
});

test('token issuance distinguishes the credential exchange from a rotation', async () => {
  const { service, app } = await iam();
  const pair = await service.login('jo', PASSWORD);
  await service.refresh(pair.refreshToken);

  const body = await scrape(app);
  assert.equal(sample(body, 'atlas_iam_tokens_issued_total', { grant: 'password' }), 1);
  assert.equal(sample(body, 'atlas_iam_tokens_issued_total', { grant: 'refresh' }), 1);
});

test('SECURITY: refresh-token reuse is counted, and so is the family it revoked', async () => {
  // The issue's sharpest point — reuse revokes an entire login family, and until now that happened
  // invisibly. It is the one metric here worth alerting on at a threshold of zero.
  const { service, app } = await iam();
  const first = await service.login('jo', PASSWORD);
  const second = await service.refresh(first.refreshToken);
  await service.refresh(second.refreshToken); // a third live token in the same family

  await assert.rejects(service.refresh(first.refreshToken), /reuse detected/);

  const body = await scrape(app);
  assert.equal(sample(body, 'atlas_iam_refresh_attempts_total', { outcome: 'reuse_detected' }), 1);
  assert.equal(
    sample(body, 'atlas_iam_sessions_revoked_total', { reason: 'reuse' }),
    1,
    'one token in that family was still live; the two already rotated were not revoked twice',
  );
});

test('replaying the same stolen token twice is not two breaches', async () => {
  // The two counters answer different questions and must not track each other. The first replay
  // kills the one live descendant; the second finds a family that is already dead. Counting a
  // revocation again would make one incident look like an escalating attack.
  const { service, app } = await iam();
  const pair = await service.login('jo', PASSWORD);
  await service.refresh(pair.refreshToken);

  await assert.rejects(service.refresh(pair.refreshToken));
  await assert.rejects(service.refresh(pair.refreshToken));

  const body = await scrape(app);
  assert.equal(
    sample(body, 'atlas_iam_refresh_attempts_total', { outcome: 'reuse_detected' }),
    2,
    'both attempts are attempts',
  );
  assert.equal(
    sample(body, 'atlas_iam_sessions_revoked_total', { reason: 'reuse' }),
    1,
    'but only one of them had a live session left to revoke',
  );
});

test('refresh failures are separated from reuse', async () => {
  const { service, app } = await iam({ refreshTokenTtlMs: -1 });
  const pair = await service.login('jo', PASSWORD);

  await assert.rejects(service.refresh(pair.refreshToken), /expired/);
  await assert.rejects(service.refresh('never-issued'), /invalid refresh token/);

  const body = await scrape(app);
  assert.equal(sample(body, 'atlas_iam_refresh_attempts_total', { outcome: 'expired' }), 1);
  assert.equal(sample(body, 'atlas_iam_refresh_attempts_total', { outcome: 'unknown_token' }), 1);
  assert.equal(sample(body, 'atlas_iam_refresh_attempts_total', { outcome: 'reuse_detected' }), 0);
});

test('logout counts the sessions it actually ended, and is idempotent', async () => {
  const { service, app } = await iam();
  const a = await service.login('jo', PASSWORD);
  const b = await service.login('jo', PASSWORD);

  service.logout(a.refreshToken);
  service.logout(a.refreshToken); // idempotent: nothing left to revoke
  service.logout(b.refreshToken, { allSessions: true });

  const body = await scrape(app);
  assert.equal(sample(body, 'atlas_iam_sessions_revoked_total', { reason: 'logout' }), 2);
});

test('policy compilation is timed', async () => {
  // iam.md §12 calls this "permission-resolution latency". It runs on every token issue as well as
  // on the endpoint, so the route histogram does not cover it.
  const { service, user, app } = await iam();
  service.effectivePolicy(user.id);

  const body = await scrape(app);
  assert.ok(
    sample(body, 'atlas_iam_policy_compile_duration_seconds_count', {}) >= 1,
    'at least the explicit compile was observed',
  );
});

// =============================================================================
// What must NOT be in the exposition
// =============================================================================

test('SECURITY: no identity ever reaches a label', async () => {
  // `/metrics` is unauthenticated. A username label would publish the account list to anyone who
  // can reach the port, and the failure path is the one that would carry it — an attacker spraying
  // logins would be writing their guesses into a document they can then read back.
  const { service, app } = await iam();
  await service.login('jo', PASSWORD);
  await assert.rejects(service.login('jo', 'wrong'));
  await assert.rejects(service.login('administrator', 'hunter2'));
  await assert.rejects(service.login('jo@example.com', 'hunter2'));

  const body = await scrape(app);
  for (const secret of ['jo', 'administrator', 'jo@example.com', PASSWORD]) {
    assert.ok(!body.includes(`"${secret}"`), `"${secret}" appears as a label value in /metrics`);
  }
  assert.ok(!/\buser(name|_id|Id)?=/.test(body), 'no identity-shaped label name is present');
});

test('SECURITY: an attacker cannot mint series by guessing usernames', async () => {
  // The cardinality half of the same rule. Unbounded labels take the metrics store down, and a
  // login endpoint is the easiest place in the platform to feed one arbitrary strings.
  // Fifty, not five thousand: each guess pays for a real argon2 verification against the dummy
  // hash — the timing-oracle defence — so the count is bounded by what is reasonable in CI. Fifty
  // distinct usernames collapsing to one series is the same proof a spray of fifty thousand gives.
  const GUESSES = 50;
  const { service, app } = await iam();
  for (let i = 0; i < GUESSES; i += 1) {
    await assert.rejects(service.login(`guess-${i}`, 'x'));
  }

  const body = await scrape(app);
  const series = body.split('\n').filter((l) => l.startsWith('atlas_iam_login_attempts_total'));
  assert.equal(series.length, 1, 'every distinct username produced ONE series');
  assert.equal(
    sample(body, 'atlas_iam_login_attempts_total', { outcome: 'unknown_user' }),
    GUESSES,
  );
  assert.equal(
    sample(body, 'atlas_metrics_series_dropped_total', {
      metric: 'atlas_iam_login_attempts_total',
    }),
    0,
    'and it never came near the cardinality cap',
  );
});

test('a token never appears in the exposition', async () => {
  const { service, app } = await iam();
  const pair = await service.login('jo', PASSWORD);
  await assert.rejects(service.refresh('a-token-that-was-never-issued'));

  const body = await scrape(app);
  assert.ok(!body.includes(pair.refreshToken), 'the refresh token is not in /metrics');
  assert.ok(!body.includes(pair.accessToken), 'the access token is not in /metrics');
  assert.ok(!body.includes('a-token-that-was-never-issued'), 'nor is a rejected one');
});

// =============================================================================
// Wiring
// =============================================================================

test('the app exposes the SERVICE’s registry, so no wiring step can be forgotten', async () => {
  // This issue exists because a wiring step was missed. The auth counters live on IamService and
  // the golden signals on the app; if those were two registries, half the signals would be
  // unscrapeable and everything would still look fine.
  const { service, app } = await iam();
  await service.login('jo', PASSWORD);
  await app.inject({ method: 'GET', url: '/healthz' });

  const body = await scrape(app);
  assert.ok(body.includes('atlas_iam_login_attempts_total'), 'service-recorded');
  assert.ok(body.includes('atlas_http_requests_total'), 'app-recorded');

  // And the route reads the LIVE registry rather than a snapshot taken at build time.
  await service.login('jo', PASSWORD);
  const after = await scrape(app);
  assert.equal(sample(after, 'atlas_iam_login_attempts_total', { outcome: 'success' }), 2);
});
