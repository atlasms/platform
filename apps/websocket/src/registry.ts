// EP-09.1/09.2 — the connection + subscription registry.
//
// A `Connection` is anything with a `send`. That keeps the registry testable without sockets,
// and means the same logic serves ws, SSE or the polling fallback (NFR-AVAIL-7) unchanged.

import { matchSubject } from '@atlas/messaging';
import type { EffectivePolicy } from '@atlas/policy';
import { mayReceive, maySubscribe, type Subscriber } from './eligibility.ts';

export interface ServerFrame {
  type: 'event' | 'subscribed' | 'unsubscribed' | 'error' | 'permissions-changed';
  subject?: string;
  payload?: unknown;
  message?: string;
}

export interface Connection {
  id: string;
  userId: string;
  channelId: string;
  policy: EffectivePolicy;
  send: (frame: ServerFrame) => void;
  close?: (reason: string) => void;
}

interface Entry {
  conn: Connection;
  /** Subject patterns the client asked for, e.g. `atlas.ch12.asset.>`. */
  patterns: Set<string>;
}

export class ConnectionRegistry {
  #entries = new Map<string, Entry>();

  get size(): number {
    return this.#entries.size;
  }

  add(conn: Connection): void {
    this.#entries.set(conn.id, { conn, patterns: new Set() });
  }

  remove(connectionId: string): void {
    this.#entries.delete(connectionId);
  }

  get(connectionId: string): Connection | undefined {
    return this.#entries.get(connectionId)?.conn;
  }

  subscriptionsOf(connectionId: string): string[] {
    return [...(this.#entries.get(connectionId)?.patterns ?? [])];
  }

  /**
   * Subscribe, if permitted.
   *
   * Eligibility is checked **at subscribe time against the pattern itself**, so an ineligible
   * client is refused once at the door rather than being filtered on every published message.
   */
  subscribe(connectionId: string, pattern: string): { ok: boolean; reason?: string } {
    const entry = this.#entries.get(connectionId);
    if (!entry) return { ok: false, reason: 'unknown connection' };

    const decision = maySubscribe(subscriberOf(entry.conn), pattern);
    if (!decision.allowed) {
      entry.conn.send({ type: 'error', subject: pattern, message: decision.reason ?? 'forbidden' });
      return { ok: false, ...(decision.reason !== undefined ? { reason: decision.reason } : {}) };
    }

    entry.patterns.add(pattern);
    entry.conn.send({ type: 'subscribed', subject: pattern });
    return { ok: true };
  }

  unsubscribe(connectionId: string, pattern: string): void {
    const entry = this.#entries.get(connectionId);
    if (!entry) return;
    entry.patterns.delete(pattern);
    entry.conn.send({ type: 'unsubscribed', subject: pattern });
  }

  /**
   * Deliver a published message to every eligible, subscribed connection.
   *
   * **Eligibility is re-checked per message, not trusted from subscribe time.** A grant can be
   * revoked between the two, and a wildcard subscription can match subjects that were not
   * evaluated when it was created — so the subscribe-time check is an early refusal, never the
   * security boundary. Returns how many connections were delivered to.
   */
  publish(subject: string, payload: unknown): number {
    let delivered = 0;
    for (const entry of this.#entries.values()) {
      const matches = [...entry.patterns].some((p) => matchSubject(p, subject));
      if (!matches) continue;
      if (!mayReceive(subscriberOf(entry.conn), subject).allowed) continue;
      entry.conn.send({ type: 'event', subject, payload });
      delivered++;
    }
    return delivered;
  }

  /**
   * Apply a new effective policy to every live connection for a user.
   *
   * Subscriptions the user may no longer see are **dropped immediately**, without waiting for a
   * reconnect — otherwise a revoked grant would keep streaming until the client happened to
   * disconnect ([FR-IAM-8](../../../docs/requirements/05-functional-requirements.md#iam)).
   */
  applyPolicyChange(userId: string, policy: EffectivePolicy): { dropped: string[] } {
    const dropped: string[] = [];

    for (const entry of this.#entries.values()) {
      if (entry.conn.userId !== userId) continue;
      entry.conn.policy = policy;

      for (const pattern of [...entry.patterns]) {
        if (!maySubscribe(subscriberOf(entry.conn), pattern).allowed) {
          entry.patterns.delete(pattern);
          dropped.push(pattern);
          entry.conn.send({
            type: 'permissions-changed',
            subject: pattern,
            message: 'subscription dropped: no longer permitted',
          });
        }
      }
    }

    return { dropped };
  }

  stats(): { connections: number; subscriptions: number } {
    let subscriptions = 0;
    for (const e of this.#entries.values()) subscriptions += e.patterns.size;
    return { connections: this.#entries.size, subscriptions };
  }
}

const subscriberOf = (c: Connection): Subscriber => ({
  userId: c.userId,
  channelId: c.channelId,
  policy: c.policy,
});
