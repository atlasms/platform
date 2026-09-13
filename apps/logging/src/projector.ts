// The projector (EP-07.4): copies the audit log into the hot index, in chain order, and never
// loses its place.
//
// No checkpoint table. The index IS the checkpoint: per channel, the highest seq it holds is where
// the next copy starts, and the store's `heads()` says how far there is to go. That is what makes
// the index a derived view in fact and not just in name — delete it and the next tick rebuilds it
// from the log; nothing else has to be reset. The in-memory copy of the index's heads is only a
// saving of one aggregation per tick, and it is re-read from the index whenever a tick fails.
//
// Why this cannot skip a row: `seq` is gapless per channel and N+1 is computed from a committed N
// (the append reads the head inside its own transaction), so a channel whose head is 12 has rows
// 1..12 all committed. A global serial would not give that — a later id can commit first, and a
// cursor that moved past it would never look back.

import type { AuditIndex } from './index-opensearch.ts';
import type { AuditStore } from './store.ts';

export interface ProjectorOptions {
  store: AuditStore;
  index: AuditIndex;
  /** How often to look for new rows. The browse's freshness is this plus the bulk refresh. */
  intervalMs?: number;
  /** Rows per bulk request. */
  batch?: number;
  onIndexed?: (count: number) => void;
  /** Every failed tick, with what failed. The next tick retries from the index's own heads. */
  onError?: (err: unknown) => void;
}

export interface Projector {
  /**
   * One pass: every channel behind the log is caught up, in batches. Resolves with how many rows
   * were indexed. Exposed so a test can drive the projector deterministically; the timer calls
   * exactly this.
   */
  tick(): Promise<number>;
  /** The rows the log has that the index does not, as of the last tick. Gauge material. */
  lag(): number;
  stop(): void;
}

export function startProjector(options: ProjectorOptions): Projector {
  const { store, index } = options;
  const batch = options.batch ?? 500;
  let indexed: Map<string, number> | undefined; // channel -> highest seq known to be in the index
  let lag = 0;
  let running = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  async function tick(): Promise<number> {
    // Ticks never overlap: a slow bulk under a fast timer would otherwise index the same rows
    // twice in flight and, worse, race on `indexed`.
    if (running) return 0;
    running = true;
    try {
      if (!indexed) {
        await index.ready();
        indexed = new Map((await index.heads()).map((h) => [h.channelId, h.seq]));
      }
      let total = 0;
      let behind = 0;
      for (const head of await store.heads()) {
        let from = indexed.get(head.channelId) ?? 0;
        while (from < head.seq) {
          const rows = await store.chainSince(head.channelId, from, batch);
          if (rows.length === 0) break;
          await index.index(rows);
          from = rows[rows.length - 1]!.seq;
          indexed.set(head.channelId, from);
          total += rows.length;
        }
        behind += Math.max(0, head.seq - from);
      }
      lag = behind;
      if (total > 0) options.onIndexed?.(total);
      return total;
    } catch (err) {
      // Whatever was or was not indexed, the index knows better than we do now.
      indexed = undefined;
      options.onError?.(err);
      return 0;
    } finally {
      running = false;
    }
  }

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick().finally(schedule);
    }, options.intervalMs ?? 1_000);
  };
  schedule();

  return {
    tick,
    lag: () => lag,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
