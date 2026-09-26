# ADR-0007 — Recorders: padded, overlapping hour files captured from IP feeds, handed to ingest

- **Status:** Accepted — decisions by the product owner, 2026-09-26 (§ Decision records which are
  theirs and which are engineering's)
- **Date:** 2026-09-26
- **Epic:** EP-39 — RIM v2, stream recording & segmentation (#39), Phase 3 (v1.0)
- **Requirement:** [FR-ING-3](../requirements/05-functional-requirements.md#ingest) — record
  streams/broadcasts and segment recordings into files of a configurable duration (24 h → 1 h files)
- **Design it refines:** [rim.md §6.2](../architecture/services/rim.md#62-recording--segmentation),
  §8 ("recorders scale per capture channel"), §9 ("recorder crash mid-segment")
- **Evidence harnesses:** [`scripts/spikes/recorder-segmenting.mjs`](../../scripts/spikes/recorder-segmenting.mjs),
  [`scripts/spikes/recorder-windows.mjs`](../../scripts/spikes/recorder-windows.mjs)

## Context

rim.md §6.2 said a recorder "captures an SDI/stream input via an FFmpeg process, writing rolling
segments", and that segmentation is "crash-safe: a partially written segment is finalized or
discarded on restart". That sentence hid choices with lasting cost: what a recorder listens to,
what it writes, when a file is finished, what a crash leaves, and where the process runs — against
a RIM that is ONE replica on ReadWriteOnce staging.

What is already built constrains the answers usefully. A completed upload (EP-15.1) and a settled
watched file (EP-15.2) both become the same `IngestJob` — staged, checksummed on assembly, probed,
held to the channel's acceptance rules, reviewed. `sourceKind: recorder` is in the contract, the
`/recorders` paths are stubbed in `rim.yaml`, `recording.segment.completed` has a schema. A recorder
that ends in that same job needs nothing new downstream.

Two platform constraints bind: the image must be **redistributable** and run **air-gapped** (A9),
and the target is Kubernetes (ADR-0002) — a pod, not a named machine.

A first draft of this ADR proposed one long-running segmenter per recorder and put five questions
to the product owner. Their answers reshaped it; the draft's evidence stays below because it is
still what the crash handling rests on.

## Decision

### From the product owner

1. **A built-in capture system — and third-party recorders too.** Atlas records feeds itself; a
   site's own recorders are supported through **folder watchers** (EP-15.2, built), which take what
   they write like any dropped file. Built-in capture takes **IP feeds now**; **SDI later**, through
   a capture helper (below) that the recorder sees as one more IP feed.
2. **Channels do not all run around the clock.** A recorder records inside **recording windows**
   (days and times, in the channel's zone), not always. Always-on is the window 00:00–24:00.
3. **A crash's partial file is kept**, marked partial — never discarded.
4. **Blank intervals are not acceptable.** Every hour is recorded as **its own file, from 5 s before
   the hour to 5 s after it**, by **two recorder workers taking turns**, so neighbouring files
   overlap by 10 s and for those 10 s both workers are capturing. The product owner's example — a
   recording from 01:00:00 to 03:00:00:

   | | starts | stops | file covers |
   |---|---|---|---|
   | worker 1 | 00:59:55 | 02:00:05 | the 01:00 hour, ±5 s |
   | worker 2 | 01:59:55 | 03:00:05 | the 02:00 hour, ±5 s |

   Between 01:59:55 and 02:00:05 both run; then worker 1 stops. The pad and the file length are
   per recorder (5 s and 60 min by default); a window's first file starts `pad` before the window
   and its last ends `pad` after it.
5. The first slice's scope was left to engineering (§ Delivery).

### From engineering, on those answers

6. **One capture = one FFmpeg process bounded to its window** (`-t`), stream copy (`-c copy`), into
   MPEG-TS, the muxer flushing every packet. Its file is finished when the process exits 0 at the
   end of its window — no segment muxer, no list to read. Two **capture slots** per recorder
   alternate — hour N in slot A, hour N+1 in slot B — and the two slots are held by **different
   worker pods** (decision 10), so the overlap is two workers, as decision 4 requires, and a worker
   lost at a boundary takes one hour's capture with it, never both sides of the cut.
7. **Stream copy, no transcode at capture.** The feed is recorded as it arrived; house formats are
   MTS's (EP-16), from the file, like any ingested file. Keyframe-accurate cuts no longer matter:
   the pad contains the hour whatever GOP the feed has (evidence: start cost 0.8–1.2 s with a 2 s
   GOP, against a 5 s pad).
8. **A crash inside a window**: the partial file is kept, and a **continuation** capture starts at
   once — on another worker if the one that crashed is gone — for the rest of that file's window,
   as part 2 of the same file. **What remains** is the time between the crash and the
   continuation's first frame: the restart plus one GOP (the start cost measured below, ~1 s).
   Padding covers the hour boundaries and every capture's start; it cannot cover a crash in the
   middle of an hour. That residue is known and accepted, and it is measured by the first slice's
   tests rather than assumed.
9. *(Withdrawn.)* The first acceptance of this ADR proposed capturing every file twice, on two
   workers, to cover the mid-hour crash. The product owner's design is the two workers taking
   turns (decision 4), not a mirror; it is not part of this decision. Should the mid-hour residue
   of decision 8 become unacceptable, a mirror is the documented next step (§ Revisit when).
10. **Where it runs: a `rim-recorder` Deployment**, separate from RIM, with at least two replicas —
    one per slot. A capture is a leased work item, as an MTS job is: a scheduler writes the next
    files' captures (recorder, file window, slot) ahead of time; workers lease them by
    compare-and-set; a capture is never leased by the pod holding the same recorder's other slot
    while that pod has a capture running in its overlap (the two sides of a cut are two workers).
    Each finished file is uploaded to RIM through the chunked upload API (EP-15.1) — RIM assembles
    and checksums it in its own staging and it becomes an `IngestJob` with `sourceKind: recorder`
    and `source` the recorder's id; `recording.segment.completed` is emitted with it. No shared
    volume; RIM stays one replica; a recorder worker's rollout touches only the captures it holds,
    and a rollout is ordered one pod at a time so both slots are never down together.
11. **The feed must serve more than one reader.** For the 10 s of every overlap two workers read the
    feed at once. **Multicast** does that (every member receives; measured) and so does **SRT** from
    an encoder in listener mode that accepts several callers. A **unicast UDP push** does not — the
    second reader receives nothing (measured) — so a unicast recorder needs a relay (one receiver
    re-publishing to both workers), which is then a single point of failure; the recorder says so.
    The site guidance is: send multicast, or SRT that serves several callers.
12. **SDI later, without changing the recorder:** a **capture helper** on a node with a capture
    card reads SDI through the vendor SDK directly (not through FFmpeg, whose DeckLink input is on
    its `nonfree` list and could not ship in our image), ENCODES it — SDI is uncompressed — and
    serves a contribution transport stream by multicast or SRT listener. The recorder records it as
    any IP feed. The helper is its own image, built under the site's SDK licence, pinned to the
    node with the card; it is later work.
13. **Smaller:** `tcIn`/`tcOut` from the worker's (NTP) clock at the file's first and last frame, in
    the channel's zone and frame rate (embedded SMPTE timecode later); an SRT passphrase is a
    reference to a Kubernetes Secret, never a field, so no audit delta can carry it.

## Evidence

### Crash behaviour and segmenting — `node scripts/spikes/recorder-segmenting.mjs`

A sender streams a test pattern as MPEG-TS over UDP in real time (25 fps, GOP 2 s); a recorder
takes it with `-c copy -f segment -segment_time 5`. FFmpeg 8.1.2, measured on Windows.

| Run | Segments (duration · frames) | Gap between segments | Listed at end |
|---|---|---|---|
| stop at 17 s | 6.023 s · 150 — 4.000 s · 100 — 5.880 s · 147 | 0 ms, 0 ms | 2 of 3 |
| hard kill at 12 s, default | 6.023 s · 150 — 4.000 s · 100 — **0 bytes, unreadable** | 0 ms | 2 of 3 |
| hard kill, `-flush_packets 1` on the output | same — **0 bytes, unreadable** | 0 ms | 2 of 3 |
| hard kill, `-segment_format_options flush_packets=1` | 6.023 · 150 — 4.000 · 100 — **1.920 s · 48 of 2 s** | 0 ms, 0 ms | 2 of 3 |

1. Cutting a live input into consecutive files is **gapless** (0 ms at every cut).
2. With stream copy, cuts land on **keyframes** (5 s asked; 6.0 / 4.0 / 5.9 s written) — which the
   padded windows of decision 7 make irrelevant.
3. **A hard kill loses FFmpeg's unwritten buffer — up to 256 KiB — and at a low bit rate that is the
   whole file so far.** rim.md's "crash-safe" assumption does not hold by default. Packet flushing
   must reach the muxer that WRITES the file: through a segment muxer only the inner option works;
   with a plain muxer (decision 6) that muxer is the output's own, so `-flush_packets 1` is the
   option — the implementation's tests must show the crash case on that path, not assume it.

### Window captures and two readers — `node scripts/spikes/recorder-windows.mjs`

A new capture joins a stream already running, bounded by `-t 8`; a second joins 1.7 s later, as
at an overlap. Stream copy, `-flush_packets 1`, into MPEG-TS.

| Feed | First capture (decoded of 200 frames · lost) | Second capture |
|---|---|---|
| unicast UDP | 180 · **0.80 s** | **nothing — 0 bytes, timed out** |
| multicast (TTL 1) | 180 · **0.80 s** | 171 · **1.16 s** |

4. **A capture's start costs about one GOP or less** — the wait for a keyframe. A 5 s pad covers it
   with room for a 4 s GOP.
5. **Unicast UDP serves one reader; multicast serves each.** Hence decision 11.

**Caveats.** Measured on Windows: a process gets no signals there (every kill is abrupt, which is the
case the design must survive anyway), and binding a multicast group to the loopback address
delivered nothing at all — the harness uses the default interface with TTL 1. Not measured: SRT
(with several callers), RTP, a full hour, a 24 h window, a pod restart's continuation gap, and a
feed that drops and returns. The first slice's tests cover the crash case on the plain muxer and a
continuation; a Linux run of both harnesses is the check before the first slice ships.

## Delivery (decision 5)

- **Slice 1:** the `Recorder` (input, windows, file length, pad, enabled) in `rim.yaml` with its
  admin API (`ingest:admin`, audited, disabled not deleted) and Studio; the scheduler and the
  `rim-recorder` worker (two replicas); padded captures alternating between two workers; crash →
  partial kept + continuation; hand-off through the upload API; `recording.segment.completed`.
- **Slice 2:** the unicast relay; the recorder's health in Studio (the next file's worker, the last
  file, a continuation's gap).
- **Later:** windows driven by Scheduling/BMS (rim.md §5), embedded timecode, the SDI capture
  helper (decision 12).

## Consequences

- **Nothing downstream changes.** A file is an `IngestJob`; acceptance rules can scope to
  `sourceKind: recorder` or one recorder; the Ingest panel shows it; MTS and (after EP-14) HSM
  treat it like any file. Third-party recorders already work, through watchers.
- **Overlaps are recorded twice on purpose.** Consecutive files share 10 s: storage is ~1.003× the
  channel's recorded air time (10 s an hour).
- **RIM stays one replica**; recorders scale on their own, and the upload path is their only
  interface to RIM.
- **The recorder image carries FFmpeg** (`APK_PACKAGES=ffmpeg`, as RIM's and MTS's); its SRT
  support must be checked when the image is built (`ffmpeg -protocols | grep srt`).
- **Contracts to add:** the `Recorder` schema and `/recorders` operations; on
  `recording.segment.completed` the window's start and end, the file's wall-clock start, `partial`,
  the continuation part, the slot and the copy; a `recorder` entity in logging's read rule
  (`ingest:admin`, as watchers).
- **Tests the worker needs:** a real FFmpeg on a generated feed (skipped without the binary, FAILED
  in CI, as MTS's are) — the window's bound, the crash leaving a readable partial on the plain
  muxer, a continuation and the gap it leaves, and two overlapping captures from a multicast feed;
  the two sides of a cut never leased by one pod.

## Revisit when

- The seconds a mid-hour crash costs (decision 8) become unacceptable for a channel — a mirror
  (every file captured twice, the complete copy kept) is the step, at twice the network and
  in-flight disk, not CPU.

- A site needs SDI recorded before the capture helper exists — a third-party recorder writing to a
  watch folder is the interim answer.
- A feed can only be unicast and the site cannot duplicate it — the relay's single point of failure
  becomes the constraint.
- A Linux run, an SRT feed, or a full-hour window measures differently from the above.
