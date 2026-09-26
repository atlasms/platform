# ADR-0007 — Recorders: record IP streams, copy them into segments, hand them to ingest

- **Status:** Proposed — **five decisions below are the product owner's** (§ Needs a decision)
- **Date:** 2026-09-26
- **Epic:** EP-39 — RIM v2, stream recording & segmentation (#39), Phase 3 (v1.0)
- **Requirement:** [FR-ING-3](../requirements/05-functional-requirements.md#ingest) — record
  streams/broadcasts and segment recordings into files of a configurable duration (24 h → 1 h files)
- **Design it refines:** [rim.md §6.2](../architecture/services/rim.md#62-recording--segmentation),
  §8 ("recorders scale per capture channel"), §9 ("recorder crash mid-segment")
- **Evidence harness:** [`scripts/spikes/recorder-segmenting.mjs`](../../scripts/spikes/recorder-segmenting.mjs)

## Context

rim.md §6.2 says a recorder "captures an SDI/stream input via an FFmpeg process, writing rolling
segments", each completed segment becoming an ingest job, and that segmentation is "crash-safe: a
partially written segment is finalized or discarded on restart". That sentence hides five choices
with lasting cost, and none of them has been made:

- **what a recorder listens to** — "SDI" and "stream" are different problems: one is a PCIe card in
  a specific machine, the other a network address;
- **what it writes** — the input as it arrives, or a house format made at capture time;
- **when a segment is finished** — the moment the platform may hand it on;
- **what a crash leaves** — and whether a partial segment is kept;
- **where the process runs** — RIM today is ONE replica on a ReadWriteOnce staging volume, and a
  recording is 24/7.

What is already built constrains the answers usefully. A completed upload (EP-15.1) and a settled
watched file (EP-15.2) both become the same `IngestJob` — staged, checksummed on assembly, probed,
held to the channel's acceptance rules, reviewed. `sourceKind: recorder` is already in the
contract, the `/recorders` paths are stubbed in `rim.yaml`, and `recording.segment.completed`
has a schema. A recorder that ends in that same job needs nothing new downstream.

Two platform constraints bind: the image must be **redistributable** and run **air-gapped** (A9),
and the deployment target is Kubernetes (ADR-0002) — a pod, not a named machine.

## Options

### 1. What a recorder listens to

- **(a) IP only, in the cluster.** SRT, UDP/RTP (multicast) MPEG-TS, RTMP — addresses FFmpeg reads
  from a pod. Nothing about the node matters.
- **(b) SDI in the cluster.** FFmpeg reading a Blackmagic DeckLink (or AJA) card. FFmpeg's DeckLink
  input needs the vendor SDK at build time and is on FFmpeg's `nonfree` list: a binary built with
  it **cannot be redistributed**, so it could not ship in our image. The pod also needs the device
  (`/dev/blackmagic/*`) passed through — a device plugin or a privileged pod — and is pinned to the
  node with the card.
- **(c) SDI at the edge, IP in the cluster.** An SDI→IP encoder (a hardware gateway, or a small
  capture machine running FFmpeg with the SDK under the SITE's licence) contributes SRT or
  multicast TS; the platform records (a). This is how most IP-era facilities already bridge SDI.

### 2. What it writes

- **(a) Stream copy** (`-c copy`) into MPEG-TS segments — the contribution as it arrived; the house
  formats are MTS's (EP-16), made from the segment like any ingested file.
- **(b) Transcode at capture** into a house format (XDCAM MXF, ProRes). A CPU (or GPU) per channel,
  around the clock, and a generation of quality loss on material that has not been judged yet.

### 3. When a segment is finished

- **(a) The segment muxer's list** (`-segment_list … -segment_list_type csv`): FFmpeg appends a
  segment to it when it closes that segment and opens the next.
- **(b) The directory**, with a settle rule like the watcher's.
- **(c) Parsing FFmpeg's log** for "Opening 'seg-003.ts' for writing".

### 4. What a crash leaves

- **(a) Default buffering**: FFmpeg writes a segment in 256 KiB blocks.
- **(b) `flush_packets=1` on the segment's muxer**: every packet written as it arrives.

…and then, for the file a crash leaves: **register it as a partial segment**, or **discard it**.

### 5. Where the process runs

- **(a) A child of RIM.** Simplest. But RIM is one replica on ReadWriteOnce staging, so every RIM
  rollout — every deploy — cuts every recording on the site at once.
- **(b) A `rim-recorder` Deployment**, separate from RIM: N replicas, each LEASING recorders
  exactly as watchers are leased (EP-15.2 — a lease row, compare-and-set, renewed), running one
  FFmpeg per recorder, and handing each finished segment to RIM **through the chunked upload API**
  (EP-15.1) as an internal client. No shared volume: RIM assembles and checksums the segment in
  its own staging, and it becomes an `IngestJob` with `sourceKind: recorder`. A rollout of the
  recorder workers cuts only their recordings, briefly, and not RIM's.
- **(c) One Deployment per recorder**, created by a controller. Full isolation, at the cost of an
  operator to write and run.

## Evidence

`node scripts/spikes/recorder-segmenting.mjs` — a sender streams a test pattern as MPEG-TS over UDP
in real time (25 fps, GOP 2 s), as an encoder or an SDI→IP gateway would; a recorder takes it with
`-c copy -f segment -segment_time 5`; ffprobe reads what was written. FFmpeg 8.1.2, measured on
Windows (see the caveat).

| Run | Segments (duration · frames) | Gap between segments | Listed at end |
|---|---|---|---|
| stop at 17 s | 6.023 s · 150 — 4.000 s · 100 — 5.880 s · 147 | 0 ms, 0 ms | 2 of 3 |
| hard kill at 12 s, default | 6.023 s · 150 — 4.000 s · 100 — **0 bytes, unreadable** | 0 ms | 2 of 3 |
| hard kill, `-flush_packets 1` on the output | same — **0 bytes, unreadable** | 0 ms | 2 of 3 |
| hard kill, `-segment_format_options flush_packets=1` | 6.023 · 150 — 4.000 · 100 — **1.920 s · 48 of 2 s** | 0 ms, 0 ms | 2 of 3 |

What it shows:

1. **Segmenting a live input is gapless.** The next segment starts exactly where the previous one
   ended (0 ms, every run). Recording 24 h as 1 h files loses nothing at the cuts.
2. **With stream copy, cuts land on keyframes.** Asked for 5 s, the segments were 6.0 s, 4.0 s,
   5.9 s: a cut waits for the next keyframe, and the timeline catches up. A "1 h" segment is 1 h
   **± one GOP** — frame-accurate hour boundaries would need a re-encode (option 2b).
3. **The segment list is a truthful "finished" signal.** Sampled every 500 ms through every run,
   it never named more files than were on disk, and at the end the one file it did not name was
   the one being written when the recorder stopped. Neither the directory nor the log is needed.
4. **A hard kill loses FFmpeg's unwritten buffer — up to 256 KiB — and at a low bit rate that is
   the whole segment so far.** Killed 2 s into a segment, the file was **empty**. The output-level
   `-flush_packets 1` does NOT reach the file: the segment muxer writes each segment through an
   inner muxer, and only `-segment_format_options flush_packets=1` does — with it the same crash
   left **1.92 of 2.0 s**, readable. (At a 50 Mb/s contribution 256 KiB is ~40 ms, at 5 Mb/s
   ~0.4 s; at the test's rate it was more than the 2 s written.)

**Caveat — platform.** On Windows a process gets no signals: Node's `kill('SIGINT')` is the same
abrupt termination as `SIGKILL`, so the "stop" run above was a hard kill too, and its last segment
survived only because it had passed 256 KiB. A graceful stop on Linux (SIGINT lets FFmpeg finish
the segment) is **not measured here**; the design below does not rely on it. Re-running the harness
on Linux is the check, and is worth doing before the implementation.

Not measured: SRT and multicast inputs (the harness uses unicast UDP), a 24 h run, the recovery gap
when a recorder worker restarts, and a source that drops and returns.

## Decision (proposed)

1. **Record IP streams only — SRT, UDP/RTP MPEG-TS (multicast included), RTMP — in the cluster
   (1a); SDI arrives through an edge encoder (1c).** Recording SDI in a pod (1b) would put a
   non-redistributable FFmpeg in the image and tie the pod to a machine; a site with SDI already
   owns, or can buy, the encoder that ends that problem at the wall.
2. **Stream copy into MPEG-TS segments (2a).** House formats are MTS's, from the segment, as for
   any ingested file. Segment boundaries are therefore on keyframes: **1 h ± one GOP**.
3. **A segment is finished when the segment list names it (3a)** — and only then is it handed on.
4. **Always `-segment_format_options flush_packets=1` (4b)**, and on restart **register the
   partial segment** the crash left — marked partial — rather than discard it: recorded air that
   exists is worth more than a tidy segment list. An empty or unreadable file is logged and removed.
5. **A `rim-recorder` Deployment (5b)**: recorders leased like watchers; one FFmpeg per recorder;
   each finished segment uploaded to RIM through the chunked upload API, becoming an `IngestJob`
   with `sourceKind: recorder` — staged, checksummed, probed, held to the acceptance rules, like
   everything else — and `recording.segment.completed` emitted with the job.

**Also proposed, smaller:** `tcIn`/`tcOut` from the recorder's (NTP) clock at the segment's start,
in the channel's zone and frame rate — embedded SMPTE timecode when the stream carries it is later;
a recorder is **always-on + `enabled`** in the first slice, recording windows next, windows driven by
Scheduling/BMS commands (rim.md §5) after; an SRT passphrase is a reference to a Kubernetes Secret,
never a field — the audit delta of a recorder would otherwise publish it into the log.

## Needs a decision

These are the product owner's — they trade things a customer will notice:

1. **SDI in the cluster: out (1c)?** If a launch customer cannot place an SDI→IP encoder, 1b comes
   back, with a site-built FFmpeg image and a pinned node — a real cost, worth knowing now.
2. **Keyframe-accurate hours (± one GOP) acceptable?** Frame-exact boundaries mean re-encoding
   every channel around the clock.
3. **Keep partial segments?** Proposed: yes, marked. The alternative is a hole in the recording.
4. **A worker restart is a gap of seconds in that worker's recordings.** Proposed: accept it for
   v1.0; redundant A/B recorders (two workers, one input, the pair de-duplicated) are a later step
   if a customer's compliance recording cannot have a gap.
5. **Scope of the first slice:** always-on recorders only, windows later — or windows from the start?

## Consequences

- **Nothing downstream changes.** A segment is an `IngestJob`; acceptance rules can already scope
  to `sourceKind: recorder` or to one recorder by id; the Ingest panel shows it; MTS and (after
  EP-14) HSM treat it like any file.
- **RIM stays one replica.** The recorders scale separately, and the upload path is the only
  interface between them — no shared volume to provision, and no second writer in RIM's staging.
- **The recorder image carries FFmpeg** (as RIM's and MTS's do: `APK_PACKAGES=ffmpeg`); SRT support
  in that FFmpeg build must be checked when the image is built (`ffmpeg -protocols | grep srt`).
- **Contracts to add:** the `Recorder` schema and `/recorders` operations in `rim.yaml`; `partial`
  (and the wall-clock start) on `recording.segment.completed`; a `recorder` entity for logging's
  read rule (`ingest:admin`, as watchers — EP-15.2).
- **Tests the implementation needs:** the harness's four findings as automated checks in the
  worker's suite (a real FFmpeg on a generated stream, skipped without the binary and FAILED in CI,
  as MTS's are), plus a lease hand-over between two workers.

## Revisit when

- A customer needs SDI recorded without an edge encoder (→ option 1b, with its costs).
- Frame-accurate segment boundaries become a requirement (→ 2b for those channels).
- Compliance recording demands no gap across a worker restart (→ A/B redundancy).
- The Linux graceful-stop behaviour, or SRT/multicast input, differs from what is measured here.
