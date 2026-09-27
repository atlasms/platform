// A capturer the worker's suite drives: each run writes a few bytes and then waits for the test to
// say how it ends — at the end of its window (exit 0), in a crash (exit 1), or empty (a feed that
// never arrived). Nothing about timing is real; the suite's clock is.

import { writeFile } from 'node:fs/promises';
import type { CaptureResult, CaptureRun, Capturer } from './capturer.ts';

export interface PendingCapture {
  run: CaptureRun;
  /** End it: `bytes` written (0 is an empty file), then the exit code. */
  end(exitCode: number, bytes?: number, stderrTail?: string): Promise<void>;
}

export function fakeCapturer(): Capturer & { pending: PendingCapture[] } {
  const pending: PendingCapture[] = [];
  return {
    pending,
    run(run) {
      return new Promise<CaptureResult>((resolve) => {
        const entry: PendingCapture = {
          run,
          async end(exitCode, bytes = 3000, stderrTail = '') {
            await writeFile(run.file, Buffer.alloc(bytes, 7));
            pending.splice(pending.indexOf(entry), 1);
            resolve({ exitCode, stderrTail });
          },
        };
        pending.push(entry);
        run.signal?.addEventListener(
          'abort',
          () => void entry.end(255, 1000, 'Exiting normally, received signal 2.'),
          { once: true },
        );
      });
    },
  };
}
