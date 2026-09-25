// The encoder's test double. Like RIM's `fakeProbe`, it decides by the file NAME: the same port,
// no binary, deterministic — so the service's own tests are about the job, the states and the
// events, and the adapter's tests (transcoder.test.ts) are about FFmpeg.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { TranscodeRefusal, type Transcoder, type TranscodeSpec } from './transcoder.ts';

export interface FakeTranscoder extends Transcoder {
  /** Every spec it was asked to run, in order. */
  readonly calls: TranscodeSpec[];
}

/**
 * By input name: `unreadable` is a refusal (the bytes), `toolfail` is the tool failing (ENOENT),
 * `slow` never finishes on its own and must be cancelled. Anything else writes a small file whose
 * CONTENTS depend on the output path, so two presets of one job have different checksums — a
 * double that returned identical bytes would hide a job that wrote every rendition to one place.
 */
export function fakeTranscoder(options: { available?: boolean } = {}): FakeTranscoder {
  const calls: TranscodeSpec[] = [];
  return {
    calls,
    async run(spec, runOptions = {}) {
      calls.push(spec);
      const name = spec.inputPath.toLowerCase();
      if (name.includes('unreadable')) {
        throw new TranscodeRefusal('Invalid data found when processing input');
      }
      if (name.includes('toolfail')) {
        throw Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
      }
      // Progress only with a known duration — the adapter's own rule. A fake that reported it
      // regardless is what let a service that never asked for the duration look fine (#349).
      const report = (percent: number) =>
        spec.durationSec !== undefined ? runOptions.onProgress?.(percent, 2.5) : undefined;
      if (name.includes('slow')) {
        report(10);
        await new Promise<void>((resolve, reject) => {
          if (runOptions.signal?.aborted) {
            reject(new Error('transcode cancelled'));
            return;
          }
          runOptions.signal?.addEventListener(
            'abort',
            () => reject(new Error('transcode cancelled')),
            { once: true },
          );
        });
      }
      report(100);
      const body = `fake rendition of ${spec.inputPath} at ${spec.outputPath}`;
      await mkdir(dirname(spec.outputPath), { recursive: true });
      await writeFile(spec.outputPath, body);
      return { sizeBytes: Buffer.byteLength(body), durationSec: 12.5 };
    },
    async available() {
      return options.available ?? true;
    },
    // No GPU, like CI and most laptops: a profile asking for one falls back to the CPU.
    async encoderUsable(encoder) {
      return !/nvenc|qsv/.test(encoder);
    },
    async probeDuration(inputPath) {
      return inputPath.toLowerCase().includes('noduration') ? undefined : 12.5;
    },
  };
}
