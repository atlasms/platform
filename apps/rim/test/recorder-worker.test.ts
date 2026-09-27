// The recorder worker (EP-39; ADR-0007): what it does with every way a capture can end, driven
// with a fake capturer (the test says how each run ends) against a real store, a real disk and a
// controlled clock. The real FFmpeg is capturer.test.ts's; the real hand-off is handoff.test.ts's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '@atlas/policy';
import {
  fakeCapturer,
  fakeProbe,
  fsStaging,
  RecorderWorker,
  RimService,
  sqliteRimStore,
  type Capture,
  type HandOff,
} from '../src/index.ts';

const CH = 'ch12';
const DAY = '2026-09-14';

async function harness() {
  const store = sqliteRimStore();
  const clock = { now: Date.parse(`${DAY}T12:00:00.000Z`) };
  const staging = await mkdtemp(join(tmpdir(), 'rim-rec-staging-'));
  const service = new RimService({
    store,
    staging: fsStaging(staging),
    probe: fakeProbe(),
    now: () => new Date(clock.now),
    defer: () => undefined,
  });
  const admin = {
    userId: 'admin',
    channelId: CH,
    policy: compile({
      subjectId: 'admin',
      permVersion: 1,
      rules: [{ id: 'r', permissions: ['ingest:admin'] }],
    }),
  };
  const recorder = await service.createRecorder(admin, {
    name: 'air',
    input: { url: 'udp://239.1.1.1:5000' },
    timezone: 'UTC',
    windows: [
      { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '13:00', to: '15:00' },
    ],
  });
  const handed: { captureId: string; part: number; state: string }[] = [];
  const handOff: HandOff = {
    async handOver(c: Capture) {
      handed.push({ captureId: c.id, part: c.part, state: c.state });
      const jobId = `job-${handed.length}`;
      // What RIM's completion does to the row (handoff.test.ts proves it on the real routes).
      await store.transaction((tx) => tx.putCapture({ ...c, jobId }, c.state));
      return { jobId };
    },
  };
  const dirs: string[] = [staging];
  const worker = async (holder: string) => {
    const workDir = await mkdtemp(join(tmpdir(), `rim-rec-${holder}-`));
    dirs.push(workDir);
    const capturer = fakeCapturer();
    const w = new RecorderWorker({
      store,
      capturer,
      handOff,
      holder,
      workDir,
      now: () => new Date(clock.now),
    });
    return { w, capturer, workDir };
  };
  const captures = async () =>
    store
      .captures(recorder.id, '2000-01-01T00:00:00.000Z', 50)
      .then((all) => all.filter((c) => c.fileStart.startsWith(DAY)));
  const at = (hhmmss: string) => {
    clock.now = Date.parse(`${DAY}T${hhmmss}.000Z`);
  };
  const close = async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  };
  return { store, clock, recorder, handed, worker, captures, at, close };
}

test('a capture runs for the rest of its span, completes at its end, is handed over, and its file goes', async () => {
  const h = await harness();
  try {
    const a = await h.worker('rec-0');
    h.at('12:59:56');
    await a.w.tick();
    assert.equal(a.capturer.pending.length, 1);
    const run = a.capturer.pending[0]!.run;
    // 12:59:56 → 14:00:05: the span less the second the tick was late.
    assert.equal(run.durationMs, 3_609_000);
    assert.equal(run.url, 'udp://239.1.1.1:5000');

    h.at('14:00:05');
    await a.capturer.pending[0]!.end(0);
    await a.w.settled();
    const [first] = await h.captures();
    assert.equal(first!.state, 'completed');
    await a.w.tick();
    assert.deepEqual(
      h.handed.map((x) => [x.part, x.state]),
      [[1, 'completed']],
    );
    assert.deepEqual(await readdir(a.workDir), [], 'the file is deleted once RIM has it');
  } finally {
    await h.close();
  }
});

test('two workers take turns: the one recording 13:00 cannot take 14:00 at the cut, so the other does', async () => {
  const h = await harness();
  try {
    const a = await h.worker('rec-0');
    const b = await h.worker('rec-1');
    h.at('12:59:56');
    await a.w.tick();
    h.at('13:59:56');
    await a.w.tick(); // 14:00's capture is due — and overlaps what rec-0 is running
    assert.equal(a.capturer.pending.length, 1, 'rec-0 still has only its own hour');
    await b.w.tick();
    assert.equal(b.capturer.pending.length, 1, 'rec-1 takes the next hour');
    const [h13, h14] = await h.captures();
    assert.deepEqual([h13!.holder, h14!.holder], ['rec-0', 'rec-1']);
    assert.deepEqual([h13!.slot, h14!.slot], [0, 1]);
    // For those seconds both are recording — the overlap — then rec-0 stops.
    h.at('14:00:05');
    await a.capturer.pending[0]!.end(0);
    await a.w.settled();
    assert.equal((await h.captures())[0]!.state, 'completed');
    assert.equal((await h.captures())[1]!.state, 'running');
  } finally {
    await h.close();
  }
});

test('a crash mid-hour keeps the partial file and CONTINUES the file at once as part 2', async () => {
  const h = await harness();
  try {
    const a = await h.worker('rec-0');
    h.at('12:59:56');
    await a.w.tick();
    h.at('13:20:00');
    await a.capturer.pending[0]!.end(1, 3000, 'udp://…: Connection timed out');
    await a.w.settled();
    let [p1, p2] = await h.captures();
    assert.equal(p1!.state, 'partial');
    assert.match(p1!.reason!, /ffmpeg exited 1: udp/);
    assert.deepEqual(
      [p2!.part, p2!.state, p2!.captureFrom.slice(11, 19), p2!.fileStart],
      [2, 'planned', '13:20:00', p1!.fileStart],
    );

    h.at('13:20:01');
    await a.w.tick();
    [p1, p2] = await h.captures();
    assert.equal(
      p2!.state,
      'running',
      'the same worker continues — its failed capture is no longer running',
    );
    assert.equal(a.capturer.pending[0]!.run.durationMs, Date.parse(p2!.captureTo) - h.clock.now);
    assert.deepEqual(
      h.handed.map((x) => [x.part, x.state]),
      [[1, 'partial']],
    );
  } finally {
    await h.close();
  }
});

test('a worker that restarts marks what it was recording partial, continues it, and hands the file over', async () => {
  const h = await harness();
  try {
    const before = await h.worker('rec-0');
    h.at('12:59:56');
    await before.w.tick();
    const [running] = await h.captures();
    // The process dies mid-capture: the worker is simply abandoned, its file left on the disk.
    await writeFile(join(before.workDir, `${running!.id}.ts`), Buffer.alloc(4000, 1));

    // The same pod name and the same disk (a StatefulSet), a new process.
    h.at('13:15:00');
    const capturer = fakeCapturer();
    const after = new RecorderWorker({
      store: h.store,
      capturer,
      handOff: {
        async handOver(c) {
          h.handed.push({ captureId: c.id, part: c.part, state: c.state });
          await h.store.transaction((tx) => tx.putCapture({ ...c, jobId: `job-${c.id}` }, c.state));
          return { jobId: `job-${c.id}` };
        },
      },
      holder: 'rec-0',
      workDir: before.workDir,
      now: () => new Date(h.clock.now),
    });
    await after.tick();
    const [p1, p2] = await h.captures();
    assert.deepEqual([p1!.state, p1!.reason], ['partial', 'recorder worker restarted']);
    assert.deepEqual(
      [p2!.part, p2!.state, p2!.captureFrom.slice(11, 19)],
      [2, 'running', '13:15:00'],
    );
    assert.equal(capturer.pending.length, 1, 'the rest of the hour is being recorded again');
    assert.deepEqual(
      h.handed.map((x) => [x.part, x.state]),
      [[1, 'partial']],
    );
  } finally {
    await h.close();
  }
});

test("a worker LOST mid-hour: another marks its capture partial and continues it; the lost one's file is handed over when it returns", async () => {
  const h = await harness();
  try {
    const a = await h.worker('rec-0');
    const b = await h.worker('rec-1');
    h.at('12:59:56');
    await a.w.tick();
    // rec-0 goes silent: no more ticks, so no renewals. Its lease lapses.
    h.at('13:10:00');
    await b.w.tick();
    const [p1, p2] = await h.captures();
    assert.deepEqual([p1!.state, p1!.holder], ['partial', 'rec-0']);
    assert.match(p1!.reason!, /recorder worker rec-0 lost/);
    assert.deepEqual([p2!.part, p2!.state, p2!.holder], [2, 'running', 'rec-1']);
    assert.equal(b.capturer.pending.length, 1);

    // rec-0's process ends (its FFmpeg was still writing): the row is no longer its — the
    // compare-and-set does not apply — and the file is handed over as the partial part 1.
    await a.capturer.pending[0]!.end(0, 4000);
    await a.w.settled();
    await a.w.tick();
    assert.deepEqual(
      h.handed.map((x) => [x.part, x.state]),
      [[1, 'partial']],
    );
  } finally {
    await h.close();
  }
});

test('a feed that is not there is retried with a growing wait, not once a second', async () => {
  const h = await harness();
  try {
    const a = await h.worker('rec-0');
    h.at('13:00:00');
    await a.w.tick();
    const waits: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      await a.capturer.pending[0]!.end(1, 0, 'Connection refused');
      await a.w.settled();
      // The continuation: the latest part of the 13:00 file (the 14:00 file is planned too).
      const all = (await h.captures()).filter((c) => c.fileStart.slice(11, 16) === '13:00');
      const next = all[all.length - 1]!;
      waits.push((Date.parse(next.captureFrom) - h.clock.now) / 1000);
      h.clock.now = Date.parse(next.captureFrom);
      await a.w.tick();
    }
    assert.deepEqual(waits, [2, 4, 8]);
  } finally {
    await h.close();
  }
});

test('an empty file is not handed over: the capture is missed, and says why', async () => {
  const h = await harness();
  try {
    const a = await h.worker('rec-0');
    h.at('12:59:56');
    await a.w.tick();
    h.at('14:00:05');
    await a.capturer.pending[0]!.end(0, 0);
    await a.w.settled();
    await a.w.tick();
    const [c] = await h.captures();
    assert.equal(c!.state, 'missed');
    assert.equal(c!.reason, 'no data received from the feed');
    assert.deepEqual(h.handed, []);
  } finally {
    await h.close();
  }
});

test('a drain stops every capture — partial, continued for another worker — and keeps the files', async () => {
  const h = await harness();
  try {
    const a = await h.worker('rec-0');
    h.at('12:59:56');
    await a.w.tick();
    h.at('13:30:00');
    await a.w.drain();
    const [p1, p2] = await h.captures();
    assert.equal(p1!.state, 'partial');
    assert.equal(p1!.reason, 'recorder worker drained');
    assert.deepEqual([p2!.part, p2!.state], [2, 'planned']);
    assert.equal((await readdir(a.workDir)).length, 1, 'the file waits for the pod to return');
  } finally {
    await h.close();
  }
});

/** The alerts in the outbox — what RIM's relay will publish. */
function alertsIn(
  store: ReturnType<typeof sqliteRimStore>,
): { kind: string; severity: string; message: string }[] {
  const rows = store.db
    .prepare(`SELECT body FROM outbox WHERE subject LIKE '%.alert.raised'`)
    .all() as {
    body: string;
  }[];
  return rows.map(
    (r) =>
      (JSON.parse(r.body) as { payload: { kind: string; severity: string; message: string } })
        .payload,
  );
}

test('a cut capture raises a WARNING alert and an empty file a CRITICAL one — in the same transaction as the state', async () => {
  const h = await harness();
  try {
    const a = await h.worker('rec-0');
    h.at('12:59:56');
    await a.w.tick();
    h.at('13:20:00');
    await a.capturer.pending[0]!.end(1, 3000, 'Connection timed out');
    await a.w.settled();
    let alerts = alertsIn(h.store);
    assert.deepEqual(
      alerts.map((x) => [x.kind, x.severity]),
      [['recording-partial', 'warning']],
    );
    assert.match(
      alerts[0]!.message,
      /^air: 13:00:00–14:00:00 UTC 2026-09-14 was recorded with a gap \(part 1 was cut short\) — ffmpeg exited 1: Connection timed out$/,
    );

    // The continuation records nothing at all: a hole — critical.
    h.at('13:20:01');
    await a.w.tick();
    h.at('14:00:05');
    await a.capturer.pending[0]!.end(0, 0);
    await a.w.settled();
    await a.w.tick();
    alerts = alertsIn(h.store);
    assert.deepEqual(
      alerts.map((x) => [x.kind, x.severity]),
      [
        ['recording-partial', 'warning'],
        ['recording-missed', 'critical'],
      ],
    );
    assert.match(alerts[1]!.message, /no data received from the feed/);
  } finally {
    await h.close();
  }
});
