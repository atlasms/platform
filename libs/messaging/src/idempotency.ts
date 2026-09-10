import type { Handler, Message } from './types.ts';

// At-least-once delivery means consumers must be idempotent: a message WILL arrive twice, and the
// second arrival must not apply the effect twice.
//
// THE RACE WAS IN THE INTERFACE. This port used to be `seen(id)` then `remember(id)` — two calls
// with a gap between them. No backing store can make that pair atomic, because by the time
// `remember` runs the decision has already been taken on stale information: two concurrent
// deliveries both observe "not seen", both proceed, and both apply the effect. Redis `SET NX` and
// Postgres `INSERT ... ON CONFLICT DO NOTHING` exist precisely because the check and the write have
// to be ONE operation, so that is what the port asks for now.

export interface SeenStore {
  /**
   * Atomically record `id`, and report whether THIS caller was the one that recorded it.
   *
   * `true` — the id was new, and this caller owns processing it.
   * `false` — someone already recorded it; this caller must skip.
   *
   * Must be atomic against concurrent callers: given N simultaneous calls for the same id, exactly
   * one returns `true`. That is the single property the whole port exists for, and the conformance
   * suite asserts it directly rather than trusting an implementation to have thought about it.
   */
  markSeen(id: string): Promise<boolean>;

  /**
   * Release a mark, so a redelivery is processed rather than suppressed.
   *
   * Needed because {@link idempotent} claims BEFORE it processes. A handler that throws has not
   * applied its effect, so leaving the id marked would convert a transient failure into permanent
   * message loss: the broker redelivers and the consumer skips it forever.
   */
  forget(id: string): Promise<void>;
}

/**
 * Per-process dedup. Correct for ONE replica, and deliberately not shared between replicas.
 *
 * Atomic because `has` and `add` happen in the same synchronous block, with no `await` between
 * them — no other turn of the event loop can interleave. An implementation that awaited anything
 * in the middle would reintroduce exactly the race this port was reshaped to remove.
 *
 * It grows without bound, which is fine for a bounded run and a leak for a long-lived consumer.
 * A durable store with a TTL (`SqliteSeenStore` / `PgSeenStore` in `@atlas/data`) is what a
 * long-running service should use.
 */
export class InMemorySeenStore implements SeenStore {
  private ids = new Set<string>();

  async markSeen(id: string): Promise<boolean> {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    return true;
  }

  async forget(id: string): Promise<void> {
    this.ids.delete(id);
  }

  /** Current size — for tests and for an operator wanting to see the leak before it bites. */
  get size(): number {
    return this.ids.size;
  }
}

/**
 * Wrap a handler so a message id is processed at most once.
 *
 * CLAIM, then process, then RELEASE ON FAILURE — in that order, and the order is the design:
 *
 * - Claiming first is what makes concurrent duplicates safe. Processing first and marking after
 *   (the previous shape) lets both copies through, because neither has marked anything yet when
 *   the other checks.
 * - Releasing on failure is what keeps a claim from becoming message loss. Without it a handler
 *   that throws leaves the id marked, and every redelivery is skipped by a consumer that never
 *   actually did the work.
 *
 * ⚠️ **There is still a crash window, and it cannot be closed here.** If the process dies after the
 * claim commits but before the handler's own writes do, the id is marked and the effect never
 * happened — redelivery will skip it. Closing that requires the mark and the handler's writes to
 * commit in the SAME transaction, which is the dual of the outbox pattern and needs a store that
 * can join a caller's unit of work. `SqliteSeenStore` and `PgSeenStore` accept a transaction handle
 * for exactly that; see `@atlas/data`. Use this wrapper for consumers whose effects are not
 * transactional, and the transactional form for consumers that write to a database.
 */
// Returns `Promise<void>` rather than the broader `Handler` (`Promise<void> | void`): the wrapper
// always awaits the store, so it is always async, and saying so lets a caller await the result —
// including a test asserting that a failing handler rejects. Still assignable to `Handler`.
export function idempotent(
  handler: Handler,
  store: SeenStore,
  keyOf: (m: Message) => string = (m) => m.id,
): (msg: Message) => Promise<void> {
  return async (msg: Message) => {
    const key = keyOf(msg);
    if (!(await store.markSeen(key))) return; // duplicate — no-op
    try {
      await handler(msg);
    } catch (err) {
      // The effect did not happen, so the claim must not survive to suppress the retry.
      await store.forget(key);
      throw err;
    }
  };
}
