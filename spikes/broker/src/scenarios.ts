// The measurements. Each scenario runs identically against both candidates and reports facts,
// not preferences — the ADR does the judging.

import { matchSubject, type Message } from '@atlas/messaging';
import type { SpikeBroker, SpikeMessageBody } from './types.ts';

export interface ScenarioResult {
  name: string;
  pass: boolean | undefined;
  detail: string;
  metrics: Record<string, string | number>;
}

const now = (): number => performance.timeOrigin + performance.now();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}

function percentiles(values: number[]): Record<string, number> {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0 };
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number): number =>
    Math.round((s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0) * 100) / 100;
  return {
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: Math.round((s.at(-1) ?? 0) * 100) / 100,
  };
}

const body = (seq: number, payload = 'x'.repeat(200)): SpikeMessageBody => ({
  seq,
  sentAt: now(),
  payload,
});

// =============================================================================
// T1 — does the broker's wildcard model agree with matchSubject()?
// =============================================================================

const T1_SUBJECTS = [
  'atlas.ch12.asset.created',
  'atlas.ch12.asset.approved',
  'atlas.ch12.schedule.updated',
  'atlas.ch99.asset.created',
  'atlas.ch12.asset.rendition.ready',
  'atlas.ch12', // the zero-vs-one-token edge; not a legal Atlas subject, included on purpose
];

const T1_PATTERNS = ['atlas.ch12.>', 'atlas.*.asset.created', 'atlas.ch12.asset.>'];

export async function t1SubjectFidelity(broker: SpikeBroker): Promise<ScenarioResult> {
  const received = new Map<string, Set<string>>(T1_PATTERNS.map((p) => [p, new Set<string>()]));
  const subs = T1_PATTERNS.map((pattern) =>
    broker.subscribe(pattern, (m: Message) => {
      received.get(pattern)?.add(m.subject);
    }),
  );

  await sleep(1_000); // let consumers attach before publishing

  for (const [i, subject] of T1_SUBJECTS.entries()) {
    await broker.publish({ id: `t1-${i}-${Date.now()}`, subject, body: body(i) });
  }

  const expected = new Map(
    T1_PATTERNS.map((p) => [p, new Set(T1_SUBJECTS.filter((s) => matchSubject(p, s)))]),
  );
  const total = [...expected.values()].reduce((n, s) => n + s.size, 0);
  await waitFor(() => [...received.values()].reduce((n, s) => n + s.size, 0) >= total, 10_000);
  await sleep(750); // give any EXTRA (over-matching) deliveries a chance to show up

  const divergences: string[] = [];
  for (const pattern of T1_PATTERNS) {
    const got = received.get(pattern) ?? new Set<string>();
    const want = expected.get(pattern) ?? new Set<string>();
    for (const s of want) if (!got.has(s)) divergences.push(`${pattern} MISSED ${s}`);
    for (const s of got) if (!want.has(s)) divergences.push(`${pattern} OVER-MATCHED ${s}`);
  }

  for (const s of subs) s.unsubscribe();

  return {
    name: 'T1 subject fidelity vs matchSubject()',
    pass: divergences.length === 0,
    detail: divergences.length === 0 ? 'exact agreement on every pattern' : divergences.join('; '),
    metrics: {
      patterns: T1_PATTERNS.length,
      subjects: T1_SUBJECTS.length,
      divergences: divergences.length,
    },
  };
}

// =============================================================================
// T2 — the load spike named in the story
// =============================================================================

export async function t2LoadSpike(broker: SpikeBroker, count: number): Promise<ScenarioResult> {
  const latencies: number[] = [];
  const seen = new Set<string>();

  const sub = broker.subscribe('atlas.ch12.load.>', (m: Message) => {
    const b = m.body as SpikeMessageBody;
    latencies.push(now() - b.sentAt);
    seen.add(`${m.subject}#${b.seq}`);
  });

  await sleep(1_000);

  // --- phase A: sequential, awaiting each confirm ---------------------------
  // Exactly what OutboxRelay.drain() does today, so this is the number that actually bounds
  // Atlas' event throughput as currently written.
  const seqStart = now();
  for (let i = 0; i < count; i++) {
    await broker.publish({
      id: `t2s-${i}-${seqStart}`,
      subject: 'atlas.ch12.load.seq',
      body: body(i),
    });
  }
  const seqMs = now() - seqStart;
  const seqLatencies = [...latencies];

  await waitFor(() => seen.size >= count, 60_000);

  // --- phase B: pipelined, 100 confirms in flight ---------------------------
  // The same broker, the same durability promise — only the client's concurrency changes. The gap
  // between A and B is headroom the relay could claim without weakening any guarantee.
  latencies.length = 0;
  const pipeStart = now();
  const inflight: Promise<void>[] = [];
  for (let i = 0; i < count; i++) {
    inflight.push(
      broker.publish({
        id: `t2p-${i}-${pipeStart}`,
        subject: 'atlas.ch12.load.pipe',
        body: body(i),
      }),
    );
    if (inflight.length >= 100) {
      await Promise.all(inflight.splice(0));
    }
  }
  await Promise.all(inflight);
  const pipeMs = now() - pipeStart;

  const complete = await waitFor(() => seen.size >= count * 2, 90_000);
  sub.unsubscribe();

  const p = percentiles(seqLatencies);
  return {
    name: `T2 load spike (${count.toLocaleString()} msgs × 2 modes, confirmed)`,
    pass: complete,
    detail: complete
      ? `all ${count * 2} delivered`
      : `INCOMPLETE — ${seen.size}/${count * 2} delivered before timeout`,
    metrics: {
      'publish msg/s (sequential)': Math.round(count / (seqMs / 1000)),
      'publish msg/s (pipelined ×100)': Math.round(count / (pipeMs / 1000)),
      'latency p50 ms': p.p50 ?? 0,
      'latency p95 ms': p.p95 ?? 0,
      'latency p99 ms': p.p99 ?? 0,
      'latency max ms': p.max ?? 0,
      delivered: seen.size,
    },
  };
}

// =============================================================================
// T3 — does a committed message survive a broker restart?
// =============================================================================

export async function t3DurabilityAcrossRestart(
  broker: SpikeBroker,
  count: number,
  restart: () => Promise<void>,
): Promise<ScenarioResult> {
  // Declare the topology first. In production this is a deploy-time step, so skipping it would
  // measure deployment order, not durability — see t5PublishBeforeConsumer for that question.
  await broker.prepare('atlas.ch12.durable.>');

  // Publish with NO consumer attached: the messages exist only in the broker's own storage.
  const start = now();
  for (let i = 0; i < count; i++) {
    await broker.publish({
      id: `t3-${i}-${start}`,
      subject: 'atlas.ch12.durable.tick',
      body: body(i),
    });
  }

  await broker.close();
  await restart();
  await broker.connect();

  const seen = new Set<number>();
  const sub = broker.subscribe('atlas.ch12.durable.>', (m: Message) => {
    seen.add((m.body as SpikeMessageBody).seq);
  });
  const survived = await waitFor(() => seen.size >= count, 30_000);
  sub.unsubscribe();

  return {
    name: 'T3 durability across a broker restart',
    pass: survived,
    detail: survived
      ? `all ${count} messages survived a full restart and were delivered afterwards`
      : `DATA LOSS — only ${seen.size}/${count} survived`,
    metrics: { published: count, recovered: seen.size },
  };
}

// =============================================================================
// T5 — the outbox hazard: publish succeeds, but is anyone listening?
// =============================================================================

/**
 * Publish to a subject with NO topology declared, then subscribe afterwards.
 *
 * This is not a contrived case. `OutboxRelay.drain()` marks a record sent as soon as `publish()`
 * resolves. If the broker accepts and silently discards — because no queue was bound yet, because
 * a consumer service hasn't deployed, because someone renamed a binding — the outbox has already
 * forgotten the event. The state change happened and the notification is gone, which is precisely
 * the drift the outbox pattern exists to prevent.
 */
export async function t5PublishBeforeConsumer(broker: SpikeBroker): Promise<ScenarioResult> {
  const count = 100;
  const start = now();
  for (let i = 0; i < count; i++) {
    await broker.publish({
      id: `t5-${i}-${start}`,
      subject: 'atlas.ch12.orphan.tick',
      body: body(i),
    });
  }

  // Now the consumer arrives — late, as it would after a deploy.
  const seen = new Set<number>();
  const sub = broker.subscribe('atlas.ch12.orphan.>', (m: Message) => {
    seen.add((m.body as SpikeMessageBody).seq);
  });
  const arrived = await waitFor(() => seen.size >= count, 10_000);
  sub.unsubscribe();

  return {
    name: 'T5 publish accepted before any consumer/binding exists',
    pass: arrived,
    detail: arrived
      ? `all ${count} were retained and delivered to the late subscriber`
      : `SILENT LOSS — publish() resolved successfully for all ${count}, but only ${seen.size} reached the later subscriber`,
    metrics: { published: count, 'delivered to late subscriber': seen.size },
  };
}

// =============================================================================
// T4 — at-least-once: redelivery, attempt cap, dead-letter
// =============================================================================

export async function t4RedeliveryAndDlq(broker: SpikeBroker): Promise<ScenarioResult> {
  const maxAttempts = 3;
  let attempts = 0;

  const sub = broker.subscribe(
    'atlas.ch12.poison.>',
    () => {
      attempts++;
      throw new Error('poison message — always fails');
    },
    { maxAttempts },
  );

  await sleep(1_000);
  await broker.publish({
    id: `t4-${Date.now()}`,
    subject: 'atlas.ch12.poison.tick',
    body: body(0),
  });

  await waitFor(() => attempts >= maxAttempts, 30_000);
  await sleep(3_000); // let the attempt cap settle and any DLQ routing land
  const dlq = await broker.deadLettered();
  sub.unsubscribe();

  const capped = attempts === maxAttempts;
  return {
    name: 'T4 redelivery, attempt cap and dead-letter',
    pass: capped && dlq >= 1,
    detail:
      `${attempts} delivery attempts (cap ${maxAttempts})` +
      (dlq >= 1 ? `, dead-lettered` : `, NOT dead-lettered — message dropped silently`),
    metrics: { attempts, 'attempt cap': maxAttempts, 'dead-lettered': dlq },
  };
}
