// The render (EP-26.6; media-editor.md §5.1): `editor.render.requested` becomes a job like any
// other, cut from the SOURCE asset's file in HSM, encoded with the output profile, and placed as the
// RENDERED asset's `original` (the command's `outputAssetId`). Its completion names the project and
// queues the new asset's first renditions in the same transaction; a command MTS cannot carry out is
// answered, and a render that fails for good says which project it was. The FFmpeg arguments are
// pure and tested here too — and against the real binary, frame by frame.

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildEnvelope, ulid, type Envelope, type EventPayloads } from '@atlas/contracts';
import { InMemoryBroker, OutboxRelay, type Message } from '@atlas/messaging';
import { SqliteOutboxStore } from '@atlas/data';
import { compile } from '@atlas/policy';
import {
  ffmpegTranscoder,
  fakeTranscoder,
  memoryFileStore,
  MtsService,
  parseRenditionRef,
  presetById,
  renderArgs,
  renderRefusal,
  sqliteJobStore,
  timelineSec,
  type FileStore,
} from '../src/index.ts';

const CH = 'ch12';
const run = promisify(execFile);

// --- the pure half ---------------------------------------------------------------------------

test('renditionRef names a media file of the source by kind, optionally kind/variant', () => {
  assert.deepEqual(parseRenditionRef('original'), { kind: 'original' });
  assert.deepEqual(parseRenditionRef('proxy/edit'), { kind: 'proxy', variant: 'edit' });
  assert.equal(parseRenditionRef('thumbnail'), undefined, 'a still is not something to cut from');
  assert.equal(parseRenditionRef('vtt-filmstrip/sprite'), undefined);
  assert.equal(parseRenditionRef('../original'), undefined);
  assert.equal(parseRenditionRef(''), undefined);
});

test('a render the command makes impossible is refused, each for its own reason', () => {
  const clip = { renditionRef: 'original', inSec: 1, outSec: 2 };
  const video = { mediaKind: 'video', clips: [clip] };
  const proxy = presetById('proxy')!;
  assert.equal(renderRefusal(video, proxy, 'proxy'), undefined);
  assert.match(renderRefusal({ ...video, mediaKind: 'photo' }, proxy, 'proxy')!, /photo/);
  assert.match(renderRefusal({ ...video, clips: [] }, proxy, 'proxy')!, /no clips/);
  assert.match(
    renderRefusal({ ...video, clips: [clip, { ...clip, renditionRef: 'broadcast' }] }, proxy, 'p')!,
    /same file/,
  );
  assert.match(
    renderRefusal({ ...video, clips: [{ ...clip, renditionRef: 'thumbnail' }] }, proxy, 'p')!,
    /not a file a render can cut from/,
  );
  assert.match(
    renderRefusal({ ...video, clips: [{ ...clip, outSec: 1 }] }, proxy, 'p')!,
    /outSec must be after/,
  );
  assert.match(
    renderRefusal({ ...video, clips: [{ ...clip, transitionIn: 'dissolve' }] }, proxy, 'p')!,
    /first clip has nothing to transition from/,
  );
  assert.match(renderRefusal(video, undefined, 'nope')!, /unknown output profile nope/);
  assert.match(renderRefusal(video, presetById('thumbnail')!, 'thumbnail')!, /makes a thumbnail/);
  assert.match(renderRefusal(video, presetById('filmstrip')!, 'filmstrip')!, /vtt-filmstrip/);
  assert.match(renderRefusal(video, presetById('audio-proxy')!, 'audio-proxy')!, /needs audio/);
  assert.equal(
    renderRefusal({ ...video, mediaKind: 'audio' }, presetById('audio-proxy')!, 'audio-proxy'),
    undefined,
  );
});

test('the arguments: one input-seeked input per clip, concat, and the profile’s -vf after the join', () => {
  const clips = [
    { renditionRef: 'original', inSec: 1, outSec: 3 },
    { renditionRef: 'original', inSec: 6.04, outSec: 7 },
  ];
  assert.equal(timelineSec(clips), 2.96);
  const { inputs, args } = renderArgs(clips, '/s/src', presetById('proxy')!.args, {
    mediaKind: 'video',
    sourceHasAudio: true,
  });
  assert.deepEqual(inputs, [
    { path: '/s/src', seekSec: 1, durationSec: 2 },
    { path: '/s/src', seekSec: 6.04, durationSec: 7 - 6.04 },
  ]);
  assert.equal(args[0], '-filter_complex');
  assert.equal(
    args[1],
    '[0:v:0][0:a:0][1:v:0][1:a:0]concat=n=2:v=1:a=1[cv][ca];[cv]scale=-2:min(720\\,ih)[v]',
  );
  assert.deepEqual(args.slice(2, 6), ['-map', '[v]', '-map', '[ca]']);
  assert.ok(!args.includes('-vf'), 'the profile’s -vf is folded into the graph, not passed twice');
  assert.ok(args.includes('libx264'), 'the rest of the profile is untouched');

  const silent = renderArgs(clips, '/s/src', presetById('proxy')!.args, {
    mediaKind: 'video',
    sourceHasAudio: false,
  });
  assert.equal(
    silent.args[1],
    '[0:v:0][1:v:0]concat=n=2:v=1:a=0[cv];[cv]scale=-2:min(720\\,ih)[v]',
    'a silent source renders a silent video rather than asking for audio it does not have',
  );
  assert.deepEqual(silent.args.slice(2, 4), ['-map', '[v]']);

  const audio = renderArgs(clips, '/s/src', presetById('audio-proxy')!.args, {
    mediaKind: 'audio',
    sourceHasAudio: true,
  });
  assert.equal(audio.args[1], '[0:a:0][1:a:0]concat=n=2:v=0:a=1[ca]');
  assert.deepEqual(audio.args.slice(2, 4), ['-map', '[ca]']);
});

// --- the service -------------------------------------------------------------------------------

async function harness(files: FileStore | undefined, opts: { maxAttempts?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mts-render-'));
  const store = sqliteJobStore();
  const transcoder = fakeTranscoder();
  const service = new MtsService({
    store,
    transcoder,
    workRoot: root,
    retryBaseMs: 0,
    ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
    ...(files !== undefined ? { files } : {}),
  });
  const broker = new InMemoryBroker();
  const relay = new OutboxRelay(new SqliteOutboxStore(store.db), broker);
  const drain = async (): Promise<Envelope[]> => {
    await relay.drain();
    return broker.published.map((m) => m.body as Envelope);
  };
  return {
    root,
    service,
    store,
    transcoder,
    drain,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** A source asset with an original in (memory) HSM. */
async function sourceIn(hsm: ReturnType<typeof memoryFileStore>, root: string): Promise<string> {
  const sourceAssetId = ulid();
  const path = join(root, 'master.mxf');
  await writeFile(path, 'the source master');
  await hsm.place(
    { channelId: CH, assetId: sourceAssetId, kind: 'original', jobId: ulid(), profile: 'ingest' },
    path,
    createHash('sha256').update('the source master').digest('hex'),
  );
  return sourceAssetId;
}

function renderCommand(
  payload: Partial<EventPayloads['editor.render.requested']> &
    Pick<EventPayloads['editor.render.requested'], 'sourceAssetId'>,
): Message {
  const envelope = buildEnvelope({
    type: 'editor.render.requested',
    channelId: CH,
    actor: { kind: 'service', id: 'mam' },
    payload: {
      editProjectId: ulid(),
      outputAssetId: ulid(),
      mediaKind: 'video',
      timeline: {
        clips: [
          { renditionRef: 'original', inSec: 1, outSec: 3 },
          { renditionRef: 'original', inSec: 5, outSec: 6.5 },
        ],
      },
      outputProfile: 'proxy',
      requestedBy: 'u-editor',
      ...payload,
    },
  });
  return {
    id: envelope.messageId,
    subject: `atlas.${CH}.editor.render.requested`,
    body: envelope,
  };
}

test('a render: queued from the command, cut from the source, placed as the NEW asset’s original, its first renditions queued', async () => {
  const hsm = memoryFileStore();
  const h = await harness(hsm);
  try {
    const sourceAssetId = await sourceIn(hsm, h.root);
    const msg = renderCommand({ sourceAssetId });
    const command = (msg.body as Envelope<EventPayloads['editor.render.requested']>).payload;
    assert.equal(await h.service.consumeRenderRequested(msg), 'applied');
    assert.equal(await h.service.consumeRenderRequested(msg), 'duplicate', 'the seen-mark');

    const [job] = await h.store.jobs({ channelId: CH });
    assert.equal(job!.assetId, command.outputAssetId, 'the job is the asset the render becomes');
    assert.deepEqual(job!.presetIds, ['proxy']);
    assert.equal(job!.createdBy, 'u-editor', 'whoever asked, for Notifications');
    assert.equal(job!.causationId, msg.id);
    assert.deepEqual(job!.render, {
      editProjectId: command.editProjectId,
      sourceAssetId,
      mediaKind: 'video',
      clips: command.timeline.clips,
    });

    assert.equal(await h.service.runNext(), 'completed');
    const call = h.transcoder.calls.at(-1)!;
    assert.deepEqual(
      call.inputs?.map((i) => [i.seekSec, i.durationSec]),
      [
        [1, 2],
        [5, 1.5],
      ],
      'one input per clip, seeked at the input',
    );
    assert.equal(call.durationSec, 3.5, 'progress is measured against the whole timeline');
    assert.equal(call.args[0], '-filter_complex');

    const placed = hsm.files.get(`${command.outputAssetId}/original/`);
    assert.ok(placed, 'the render is the new asset’s original, in HSM');
    assert.equal(placed.meta.producedBy, 'editor');
    assert.equal(placed.meta.profile, 'proxy');

    const events = await h.drain();
    const completed = events.find((e) => e.type === 'transcode.completed')!
      .payload as unknown as EventPayloads['transcode.completed'];
    assert.equal(completed.assetId, command.outputAssetId);
    assert.equal(completed.editProjectId, command.editProjectId);
    assert.deepEqual(
      completed.renditions.map((r) => [r.kind, r.fileType]),
      [['original', 'mp4']],
      'its container named, since HSM’s path names none',
    );

    // The new asset's first renditions, from that original — like an ingest's.
    const followUp = (await h.store.jobs({ channelId: CH })).find((j) => j.id !== job!.id)!;
    assert.equal(followUp.assetId, command.outputAssetId);
    assert.deepEqual(followUp.presetIds, ['proxy', 'edit-proxy', 'thumbnail']);
    assert.deepEqual(followUp.inputFile, { kind: 'original' });
    assert.equal(followUp.state, 'queued');
    assert.equal(followUp.correlationId, job!.correlationId, 'the same chain');
    assert.equal(await h.service.runNext(), 'completed');
    assert.ok(hsm.files.has(`${command.outputAssetId}/proxy/`));
  } finally {
    await h.cleanup();
  }
});

test('a render MTS cannot carry out is answered transcode.failed naming the project — nothing queued', async () => {
  const hsm = memoryFileStore();
  const h = await harness(hsm);
  try {
    const msg = renderCommand({ sourceAssetId: ulid(), outputProfile: 'thumbnail' });
    const command = (msg.body as Envelope<EventPayloads['editor.render.requested']>).payload;
    assert.equal(await h.service.consumeRenderRequested(msg), 'refused');
    assert.equal(await h.service.consumeRenderRequested(msg), 'duplicate');
    assert.deepEqual(await h.store.jobs({ channelId: CH }), []);
    const failed = (await h.drain()).filter((e) => e.type === 'transcode.failed');
    assert.equal(failed.length, 1, 'answered once');
    const payload = failed[0]!.payload as unknown as EventPayloads['transcode.failed'];
    assert.equal(payload.editProjectId, command.editProjectId);
    assert.equal(payload.assetId, command.outputAssetId);
    assert.equal(payload.requestedBy, 'u-editor');
    assert.equal(payload.error.code, 'COMMAND_REFUSED');
    assert.match(payload.error.message, /makes a thumbnail/);
    assert.equal(failed[0]!.correlationId, msg.id, 'under the command’s chain');
  } finally {
    await h.cleanup();
  }
});

test('without HSM there is no source to read: the render is refused, not queued to fail', async () => {
  const h = await harness(undefined);
  try {
    assert.equal(
      await h.service.consumeRenderRequested(renderCommand({ sourceAssetId: ulid() })),
      'refused',
    );
    const [failed] = (await h.drain()).filter((e) => e.type === 'transcode.failed');
    assert.match(
      (failed!.payload as unknown as EventPayloads['transcode.failed']).error.message,
      /HSM/,
    );
  } finally {
    await h.cleanup();
  }
});

test('a render that fails for good says which project it was; it queues no first renditions', async () => {
  const hsm = memoryFileStore();
  const h = await harness(hsm, { maxAttempts: 1 });
  try {
    // A source HSM does not have — another channel's, or nobody's: the fetch fails.
    const msg = renderCommand({ sourceAssetId: ulid() });
    const command = (msg.body as Envelope<EventPayloads['editor.render.requested']>).payload;
    assert.equal(await h.service.consumeRenderRequested(msg), 'applied');
    assert.equal(await h.service.runNext(), 'dead-letter');
    const failed = (await h.drain()).find((e) => e.type === 'transcode.failed')!
      .payload as unknown as EventPayloads['transcode.failed'];
    assert.equal(failed.editProjectId, command.editProjectId);
    assert.equal(failed.error.code, 'TRANSCODE_FAILED');
    assert.equal((await h.store.jobs({ channelId: CH })).length, 1, 'no follow-up job');
  } finally {
    await h.cleanup();
  }
});

test('an ordinary transcode’s answers carry no editProjectId', async () => {
  const hsm = memoryFileStore();
  const h = await harness(hsm);
  try {
    const assetId = await sourceIn(hsm, h.root);
    await h.service.enqueue(
      {
        userId: 'u1',
        channelId: CH,
        policy: compile({
          subjectId: 'u1',
          permVersion: 1,
          rules: [{ id: 'r', permissions: ['asset:read', 'asset:write'] }],
          roles: [],
          groups: [],
        }),
      },
      { assetId, presetIds: ['proxy'], inputFile: { kind: 'original' } },
    );
    assert.equal(await h.service.runNext(), 'completed');
    const completed = (await h.drain()).find((e) => e.type === 'transcode.completed')!;
    assert.equal('editProjectId' in completed.payload, false);
  } finally {
    await h.cleanup();
  }
});

// --- the real binary ---------------------------------------------------------------------------

async function haveFfmpeg(t: TestContext): Promise<boolean> {
  const ok = await ffmpegTranscoder().available();
  if (ok) return true;
  if (process.env['CI']) assert.fail('ffmpeg is required in CI: install it in the workflow');
  t.skip('ffmpeg not on the PATH');
  return false;
}

/** PSNR between frame `a` of one file and frame `b` of another — higher is more alike. */
async function psnr(x: string, a: number, y: string, b: number): Promise<number> {
  const { stderr } = await run('ffmpeg', [
    '-hide_banner',
    '-i',
    x,
    '-i',
    y,
    '-filter_complex',
    `[0:v]select=eq(n\\,${a}),setpts=PTS-STARTPTS[a];[1:v]select=eq(n\\,${b}),setpts=PTS-STARTPTS[b];[a][b]psnr`,
    '-frames:v',
    '1',
    '-f',
    'null',
    '-',
  ]);
  const m = /average:([0-9.]+|inf)/.exec(stderr);
  assert.ok(m, `no PSNR in: ${stderr}`);
  return m[1] === 'inf' ? Infinity : Number(m[1]);
}

test('real ffmpeg: a two-clip render is frame-exact at every cut, with and without audio', async (t) => {
  if (!(await haveFfmpeg(t))) return;
  const dir = await mkdtemp(join(tmpdir(), 'mts-render-real-'));
  try {
    const src = join(dir, 'src.mp4');
    // A frame counter that changes every frame, 25 fps, with a tone.
    await run('ffmpeg', [
      '-nostdin', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=8',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-c:a', 'aac', '-shortest', src,
    ]); // prettier-ignore
    const transcoder = ffmpegTranscoder();
    // Frames 25..74, then 151..174 (6.04 s = frame 151 — not on a keyframe, GOP 50).
    const clips = [
      { renditionRef: 'original', inSec: 1, outSec: 3 },
      { renditionRef: 'original', inSec: 6.04, outSec: 7 },
    ];
    for (const sourceHasAudio of [true, false]) {
      const out = join(dir, `out-${sourceHasAudio}.mp4`);
      const { inputs, args } = renderArgs(clips, src, presetById('proxy')!.args, {
        mediaKind: 'video',
        sourceHasAudio,
      });
      await transcoder.run({ inputPath: src, inputs, outputPath: out, args });
      const duration = (await transcoder.probeDuration(out))!;
      assert.ok(Math.abs(duration - 2.96) < 0.05, `the timeline's length, got ${duration}`);
      assert.equal(await transcoder.hasAudio(out), sourceHasAudio);
      // Each boundary frame is most like the source frame it should be — not its neighbours.
      for (const [outFrame, srcFrame] of [
        [0, 25],
        [49, 74],
        [50, 151],
      ] as const) {
        const right = await psnr(out, outFrame, src, srcFrame);
        for (const wrong of [srcFrame - 1, srcFrame + 1]) {
          const other = await psnr(out, outFrame, src, wrong);
          assert.ok(
            right > other,
            `output frame ${outFrame} is source frame ${srcFrame} (${right} dB), not ${wrong} (${other} dB)`,
          );
        }
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- EP-26.5: transitions and filters ---------------------------------------------------------

test('EP-26.5: a transition or filter outside the Tier-0 set, or one that cannot be, is refused', () => {
  const proxy = presetById('proxy')!;
  const two = (second: object, first: object = {}) => ({
    mediaKind: 'video',
    clips: [
      { renditionRef: 'original', inSec: 0, outSec: 2, ...first },
      { renditionRef: 'original', inSec: 5, outSec: 7, ...second },
    ],
  });
  const why = (cmd: { mediaKind: string; clips: object[] }) =>
    renderRefusal(cmd as Parameters<typeof renderRefusal>[0], proxy, 'proxy');
  assert.equal(why(two({ transitionIn: 'dissolve', filters: ['sepia', 'mute'] })), undefined);
  assert.match(why(two({ transitionIn: 'spin' }))!, /not a transition/);
  assert.match(why(two({ filters: ['ffmpeg -vf x'] }))!, /not a filter/);
  assert.match(why(two({ filters: ['blur', 'blur'] }))!, /named twice/);
  assert.match(why(two({ transitionIn: 'dissolve', transitionSec: 2 }))!, /shorter than both/);
  assert.match(why(two({ transitionSec: 1 }))!, /only for a clip with a transition/);
  const audio = presetById('audio-proxy')!;
  const sound = (second: object) =>
    renderRefusal(
      { ...two(second), mediaKind: 'audio' } as Parameters<typeof renderRefusal>[0],
      audio,
      'audio-proxy',
    );
  assert.match(sound({ transitionIn: 'wipe-left' })!, /no meaning for audio/);
  assert.match(sound({ filters: ['grayscale'] })!, /picture filter on an audio timeline/);
  assert.equal(sound({ transitionIn: 'fade-black', filters: ['mute'] }), undefined);
});

test('EP-26.5: the graph — per-clip filters first, then pairwise xfade/acrossfade at the running offset, a cut a concat', () => {
  const clips = [
    { renditionRef: 'original', inSec: 1, outSec: 3, filters: ['grayscale'] },
    { renditionRef: 'original', inSec: 4, outSec: 6, transitionIn: 'dissolve' },
    { renditionRef: 'original', inSec: 7, outSec: 9 },
    {
      renditionRef: 'original',
      inSec: 10,
      outSec: 12,
      transitionIn: 'fade-black',
      transitionSec: 1,
      filters: ['mute'],
    },
  ];
  assert.equal(timelineSec(clips), 8 - 0.5 - 1, 'each transition overlaps two clips');
  const { args } = renderArgs(clips, '/s', presetById('broadcast')!.args, {
    mediaKind: 'video',
    sourceHasAudio: true,
  });
  const graph = args[1]!.split(';');
  assert.deepEqual(graph.slice(0, 2), ['[0:v:0]hue=s=0[vf0]', '[3:a:0]volume=0[af3]']);
  assert.deepEqual(graph.slice(2, 8), [
    '[vf0][1:v:0]xfade=transition=dissolve:duration=0.5:offset=1.5[vx1]',
    '[0:a:0][1:a:0]acrossfade=d=0.5[ax1]',
    '[vx1][2:v:0]concat=n=2:v=1:a=0[vx2]',
    '[ax1][2:a:0]concat=n=2:v=0:a=1[ax2]',
    '[vx2][3:v:0]xfade=transition=fadeblack:duration=1:offset=4.5[cv]',
    '[ax2][af3]acrossfade=d=1[ca]',
  ]);
  assert.match(graph[8]!, /^\[cv\]scale=1920:1080/, 'the profile’s -vf after the join');
});

test('real ffmpeg: transitions shorten the timeline by their overlaps, and a filter reaches the frames it covers', async (t) => {
  if (!(await haveFfmpeg(t))) return;
  const dir = await mkdtemp(join(tmpdir(), 'mts-effects-real-'));
  try {
    const src = join(dir, 'src.mp4');
    await run('ffmpeg', [
      '-nostdin', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', src,
    ]); // prettier-ignore
    const clips = [
      { renditionRef: 'original', inSec: 1, outSec: 3, filters: ['grayscale'] },
      { renditionRef: 'original', inSec: 4, outSec: 6, transitionIn: 'dissolve' },
      {
        renditionRef: 'original',
        inSec: 7,
        outSec: 9,
        transitionIn: 'fade-black',
        filters: ['mute'],
      },
    ];
    const out = join(dir, 'out.mp4');
    const transcoder = ffmpegTranscoder();
    const { inputs, args } = renderArgs(clips, src, presetById('proxy')!.args, {
      mediaKind: 'video',
      sourceHasAudio: true,
    });
    await transcoder.run({ inputPath: src, inputs, outputPath: out, args });
    const duration = (await transcoder.probeDuration(out))!;
    assert.ok(Math.abs(duration - 5) < 0.06, `6 s of clips less two 0.5 s overlaps: ${duration}`);

    /** Mean saturation of the frame at `atSec` — 0 for grayscale, well above for testsrc's colours. */
    const saturation = async (atSec: number) => {
      const { stderr } = await run('ffmpeg', [
        '-hide_banner', '-ss', String(atSec), '-i', out, '-frames:v', '1',
        '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.SATAVG', '-f', 'null', '-',
      ]); // prettier-ignore
      const m = /SATAVG=([0-9.]+)/.exec(stderr);
      assert.ok(m, stderr);
      return Number(m[1]);
    };
    assert.ok((await saturation(0.4)) < 1, 'the first clip is grayscale');
    assert.ok((await saturation(2.6)) > 20, 'the second is in colour');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
