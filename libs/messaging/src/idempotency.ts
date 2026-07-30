import type { Handler, Message } from './types.ts';

// At-least-once delivery means consumers must be idempotent. Wrap a handler so a message id is
// processed at most once. In production back SeenStore with Redis/Postgres (with a TTL).
//
// NOTE: safe for *sequential* redelivery (the real model — a message is redelivered after the prior
// attempt settles). Under *concurrent* duplicate delivery the check-then-set below can race, so a
// production SeenStore should make it atomic (Redis `SET NX`, or Postgres `INSERT ... ON CONFLICT`).
export interface SeenStore {
  seen(id: string): Promise<boolean>;
  remember(id: string): Promise<void>;
}

export class InMemorySeenStore implements SeenStore {
  private ids = new Set<string>();
  async seen(id: string): Promise<boolean> {
    return this.ids.has(id);
  }
  async remember(id: string): Promise<void> {
    this.ids.add(id);
  }
}

/** Returns a handler that skips messages whose id was already processed. */
export function idempotent(
  handler: Handler,
  store: SeenStore,
  keyOf: (m: Message) => string = (m) => m.id,
): Handler {
  return async (msg: Message) => {
    const key = keyOf(msg);
    if (await store.seen(key)) return; // duplicate — no-op
    await handler(msg); // process first (so a failure lets redelivery retry)
    await store.remember(key);
  };
}
