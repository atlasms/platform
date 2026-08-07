// Runs the shared broker conformance suite against a REAL JetStream server.
//
// CI runs this — the workflow starts a JetStream container and sets ATLAS_NATS_URL. Locally it
// skips unless you point it at one:
//
//   docker compose -f infra/docker-compose.dev.yml up -d
//   ATLAS_NATS_URL=nats://localhost:54222 npm test -w @atlas/messaging-nats
//
// This file used to argue that skipping in CI was the honest default, because "the in-memory
// broker already covers the behaviour". That reasoning does not survive the principle the
// conformance suites exist for: the double is what the suite DISTRUSTS. Dedupe being stream-wide,
// two instances of one service sharing a cursor while a second service gets its own copy — those
// are properties of JetStream, and the in-memory broker asserts only that we implemented our own
// double consistently. The objection it raised was really about cost, and a container declared by
// the workflow costs a developer nothing and the job about five seconds.

import test from 'node:test';
import assert from 'node:assert/strict';
import { brokerConformance } from '@atlas/messaging/conformance';
import type { Broker } from '@atlas/messaging';
import { NatsBroker, durableName } from '../src/index.ts';

const URL = process.env['ATLAS_NATS_URL'];

// --- pure unit tests, always run ---------------------------------------------

test('durable names are scoped to the service, not just the pattern', () => {
  // Two services on the same subject must NOT share a cursor, or each steals half the other's
  // events. This is the single most damaging thing to get wrong in a JetStream deployment.
  assert.notEqual(durableName('mam', 'atlas.>'), durableName('scheduler', 'atlas.>'));

  // Stable across restarts: a changed durable name is a new cursor that replays the whole stream.
  assert.equal(durableName('mam', 'atlas.ch12.asset.>'), durableName('mam', 'atlas.ch12.asset.>'));

  // Legal for NATS: no '.', '*', '>' or whitespace.
  assert.doesNotMatch(durableName('mam', 'atlas.ch12.*.created'), /[.*>\s]/);
});

// --- conformance against a real server ---------------------------------------

if (!URL) {
  // Convenient locally, REFUSED in CI. A skip on a laptop without Docker is right; a skip in CI
  // means the deployed broker adapter stopped being tested and nothing said so.
  if (process.env['CI']) {
    throw new Error(
      'ATLAS_NATS_URL is unset in CI: the JetStream conformance suite would skip, leaving the ' +
        'deployed broker unexercised. Restore the JetStream step in .github/workflows/ci.yml.',
    );
  }
  test('NATS conformance', { skip: 'set ATLAS_NATS_URL to run against a real broker' }, () => {});
} else {
  let n = 0;
  brokerConformance('NatsBroker', {
    timeoutMs: 15_000,
    make: async () => {
      // A distinct service identity per test = a distinct durable = no shared cursor between
      // tests, which would otherwise make them steal each other's messages.
      const broker = await NatsBroker.connect({ servers: URL, service: `spec${n++}` });
      return { broker, cleanup: () => broker.close() };
    },
    deadLetterCount: (broker: Broker) => (broker as NatsBroker).deadLetterCount(),
  });

  // --- JetStream-specific behaviour the Broker interface does not describe --------------------

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const uniq = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  test('publish-side dedupe: the same message id is stored once', async () => {
    // ADR-0001 counts this as a benefit: an outbox relay that crashes between publish() and
    // markSent() republishes the same id, and JetStream collapses it. Consumers still dedupe —
    // the window is finite — but the common case costs nothing.
    const broker = await NatsBroker.connect({ servers: URL, service: `dedupe${uniq()}` });
    const chan = `ch${uniq()}`;
    const got: string[] = [];
    broker.subscribe(`atlas.${chan}.>`, (m) => {
      got.push(m.subject);
    });
    await sleep(500);

    const id = `dup-${uniq()}`;
    await broker.publish({ id, subject: `atlas.${chan}.asset.created`, body: { v: 1 } });
    await broker.publish({ id, subject: `atlas.${chan}.asset.created`, body: { v: 1 } });
    await sleep(2_000);

    assert.equal(got.length, 1, 'a repeated msgID must not produce a second delivery');
    await broker.close();
  });

  test('DANGER: dedupe is stream-wide, so a reused id on a DIFFERENT subject is dropped', async () => {
    // The trap that this suite fell into. `publish()` resolves successfully and the message is
    // silently discarded — which is why every Atlas message id must be a ULID, never a counter
    // or a natural key. Pinned as a test so nobody rediscovers it the slow way.
    const broker = await NatsBroker.connect({ servers: URL, service: `stream${uniq()}` });
    const chan = `ch${uniq()}`;
    const got: string[] = [];
    broker.subscribe(`atlas.${chan}.>`, (m) => {
      got.push(m.subject);
    });
    await sleep(500);

    const id = `shared-${uniq()}`;
    await broker.publish({ id, subject: `atlas.${chan}.asset.created`, body: {} });
    await broker.publish({ id, subject: `atlas.${chan}.schedule.updated`, body: {} });
    await sleep(2_000);

    assert.deepEqual(
      got,
      [`atlas.${chan}.asset.created`],
      'the second subject was swallowed by the dedupe window — ids must be globally unique',
    );
    await broker.close();
  });

  test('a stream whose config has drifted is converged, not a failure to boot', async () => {
    // The path `upsertStream` exists for, and one the conformance suite does NOT reach: adding a
    // stream with an IDENTICAL config is idempotent and returns no error, so only a real drift
    // exercises the recovery. Worth pinning because the detection changed with the @nats-io
    // migration (#207) — a message-text match became an API error-code match, and if that code is
    // ever wrong the symptom is every service failing to start against an existing deployment.
    const stream = `DRIFT${uniq()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')}`;
    // A subject prefix of its OWN, not `atlas.` — JetStream refuses to create a stream whose
    // subjects overlap an existing one's, and the default ATLAS stream already claims `atlas.>`.
    const root = `drift${uniq()}`;

    const first = await NatsBroker.connect({
      servers: URL,
      service: `d${uniq()}`,
      stream,
      subjects: [`${root}.a.>`],
    });
    await first.close();

    // Same stream, wider subject list — a config change, which is what a deployment upgrade looks
    // like. This must connect rather than throw.
    const second = await NatsBroker.connect({
      servers: URL,
      service: `d${uniq()}`,
      stream,
      subjects: [`${root}.a.>`, `${root}.b.>`],
    });

    const got: string[] = [];
    second.subscribe(`${root}.b.>`, (m) => {
      got.push(m.subject);
    });
    await sleep(500);
    await second.publish({ id: `drift-${uniq()}`, subject: `${root}.b.created`, body: {} });
    await sleep(1_500);

    assert.deepEqual(
      got,
      [`${root}.b.created`],
      'the widened subject list took effect — the stream was updated, not left at its old config',
    );
    await second.close();
  });

  test('a connect that fails during stream setup does not leak the connection', async () => {
    // Found by hitting it: JetStream refuses a stream whose subjects overlap an existing one's, so
    // this connect fails AFTER the socket is open. Without the cleanup, nothing holds a reference
    // to that socket and Node keeps the process alive for it — a clear startup error becomes a
    // hang, which is far harder to diagnose in a container than a crash.
    await assert.rejects(
      NatsBroker.connect({
        servers: URL,
        service: `overlap${uniq()}`,
        stream: `OVERLAP${uniq()
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, '')}`,
        subjects: ['atlas.>'], // already claimed by the default ATLAS stream
      }),
      'the overlap must surface as a rejection, not a stall',
    );

    // The proof that the socket was closed is this file exiting at all: node:test cannot end the
    // process while a NATS connection is open, so a leak here would time the whole run out rather
    // than fail this assertion. Recording the intent so the test is not mistaken for redundant.
  });

  test('two instances of ONE service share the work; a second service gets its own copy', async () => {
    // The reason durables are named per (service, pattern). Same service = competing consumers,
    // each event handled once. Different service = independent cursor, its own copy.
    const chan = `ch${uniq()}`;
    const service = `svc${uniq()}`;

    const a = await NatsBroker.connect({ servers: URL, service });
    const b = await NatsBroker.connect({ servers: URL, service }); // second instance, same identity
    const other = await NatsBroker.connect({ servers: URL, service: `other${uniq()}` });

    const seenByService: string[] = [];
    const seenByOther: string[] = [];
    a.subscribe(`atlas.${chan}.>`, (m) => {
      seenByService.push(`a:${m.subject}`);
    });
    b.subscribe(`atlas.${chan}.>`, (m) => {
      seenByService.push(`b:${m.subject}`);
    });
    other.subscribe(`atlas.${chan}.>`, (m) => {
      seenByOther.push(m.subject);
    });
    await sleep(1_000);

    for (let i = 0; i < 6; i++) {
      await a.publish({
        id: `wq-${uniq()}-${i}`,
        subject: `atlas.${chan}.asset.created`,
        body: { i },
      });
    }
    await sleep(3_000);

    assert.equal(
      seenByService.length,
      6,
      'the two instances together handle each event exactly once',
    );
    assert.equal(seenByOther.length, 6, 'a different service receives its own full copy');

    await Promise.all([a.close(), b.close(), other.close()]);
  });
}
