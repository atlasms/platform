// ADR-0010 check 4 — a running instance survives its runtime being KILLED (EP-22.3).
//
//   npm run crash:bms        # against the kind cluster (kubectl context kind-atlas-dev)
//
// An instance is started and left inside a durable timer; then the Temporal server AND the BMS pod
// running its worker are force-deleted — no grace, no drain: a crash. When both are back, the timer
// still fires (it is Temporal's, in Postgres, not the dead process's), the instance reaches its
// wait, a signal releases it, and it ends with a gapless history: every step event once, none lost
// to the crash and none written twice by an activity Temporal retried.
//
// Destructive to the two pods only; everything else keeps running. Run after the smoke suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const BASE = process.env.ATLAS_BASE_URL ?? 'http://localhost:30080';
const CONTEXT = process.env.ATLAS_KUBE_CONTEXT ?? 'kind-atlas-dev';
const kubectl = (...args) =>
  execFileSync('kubectl', ['--context', CONTEXT, '-n', 'atlas', ...args], { encoding: 'utf8' });

async function call(path, init = {}) {
  const res = await fetch(new URL(path, BASE), { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  return { status: res.status, text, json: () => JSON.parse(text) };
}

/** Retry a request through a window where the service may be restarting (refused or 502/503). */
async function through(what, fn, budgetMs = 180_000) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      const res = await fn();
      if (![502, 503].includes(res.status)) return res;
    } catch {
      // connection refused while the gateway's upstream restarts
    }
    if (Date.now() > deadline) throw new Error(`${what}: still unavailable after ${budgetMs} ms`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

test('ADR-0010 check 4: an instance survives the Temporal server and its worker being killed mid-timer', async () => {
  const login = await call('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: process.env.ATLAS_SMOKE_USER ?? 'dev',
      password: process.env.ATLAS_SMOKE_PASSWORD ?? 'dev-password',
    }),
  });
  assert.equal(login.status, 200, login.text);
  const headers = {
    authorization: `Bearer ${login.json().accessToken}`,
    'content-type': 'application/json',
  };

  const created = await call('/api/v1/workflows', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: `crash test ${Date.now()}`,
      vars: [{ name: 'verdict', type: 'string' }],
      steps: [
        { id: 's_start', kind: 'start' },
        // Long enough to kill both pods inside it and have them back before it fires.
        { id: 's_hold', kind: 'timer', config: { mode: 'duration', value: 'PT90S' } },
        {
          id: 's_wait',
          kind: 'wait-event',
          config: {
            event: 'asset.approved',
            correlate: '= incoming.assetId = vars.assetId',
            output: { 'vars.verdict': '= incoming.verdict' },
          },
        },
        { id: 's_end', kind: 'end', config: { status: 'survived' } },
      ],
      transitions: [
        { id: 't1', from: 's_start', to: 's_hold' },
        { id: 't2', from: 's_hold', to: 's_wait' },
        { id: 't3', from: 's_wait', to: 's_end' },
      ],
    }),
  });
  assert.equal(created.status, 201, created.text);
  const workflowId = created.json().id;
  const published = await call(`/api/v1/workflows/${workflowId}/publish?revision=1`, {
    method: 'POST',
    headers,
  });
  assert.equal(published.status, 200, published.text);
  const started = await through('start', () =>
    call('/api/v1/instances', { method: 'POST', headers, body: JSON.stringify({ workflowId }) }),
  );
  assert.equal(started.status, 201, started.text);
  const { id } = started.json();

  const read = () => call(`/api/v1/instances/${id}`, { headers });
  const until = async (what, ok, budgetMs = 240_000) => {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const res = await through('read', read);
      if (res.status === 200 && ok(res.json())) return res.json();
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}: ${res.text}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  };
  await until('the timer to be running', (i) => i.currentSteps.includes('s_hold'), 60_000);

  // The crash: both, at once, no grace.
  const t0 = Date.now();
  kubectl(
    'delete',
    'pod',
    '-l',
    'app.kubernetes.io/name=temporal',
    '--grace-period=0',
    '--force',
    '--wait=false',
  );
  kubectl(
    'delete',
    'pod',
    '-l',
    'app.kubernetes.io/name=bms',
    '--grace-period=0',
    '--force',
    '--wait=false',
  );
  kubectl('rollout', 'status', 'deployment/temporal', '--timeout=240s');
  kubectl('rollout', 'status', 'deployment/bms', '--timeout=240s');
  console.log(`  both back in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

  // The timer was Temporal's: it fires after the crash, and the instance reaches its wait.
  await until('the wait, reached by the timer after the crash', (i) =>
    i.currentSteps.includes('s_wait'),
  );
  const signalled = await through('signal', () =>
    call(`/api/v1/instances/${id}/signal`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ stepId: 's_wait', payload: { verdict: 'approved' } }),
    }),
  );
  assert.equal(signalled.status, 202, signalled.text);
  const done = await until('the end', (i) => i.state === 'completed');
  assert.equal(done.endStepId, 's_end');
  assert.equal(done.vars.verdict, 'approved');

  // Gapless: every step event once, in order — none lost, none doubled by a retried activity.
  assert.deepEqual(
    done.history.map((h) => h.seq),
    done.history.map((_, n) => n + 1),
  );
  const events = done.history.map((h) => `${h.stepId}:${h.event}`);
  assert.equal(new Set(events).size, events.length, `a step event was recorded twice: ${events}`);
  for (const expected of [
    's_hold:completed',
    's_wait:awaiting',
    's_wait:completed',
    's_end:completed',
  ])
    assert.ok(events.includes(expected), `missing ${expected} in ${events}`);
});
