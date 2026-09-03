import { inject, Injectable, signal } from '@angular/core';
import { Subject, timer } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { AuthService } from './auth.service.ts';
import { SessionStore } from './session.store.ts';
import { API_BASE_URL } from './api.ts';

export type ClientFrameType = 'subscribe' | 'unsubscribe';

export interface ClientFrame {
  type: ClientFrameType;
  pattern: string;
}

export interface ServerFrame {
  type: 'event' | 'subscribed' | 'unsubscribed' | 'error' | 'permissions-changed';
  subject?: string;
  payload?: unknown;
  message?: string;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

interface PendingSubscription {
  pattern: string;
  resolve: (value: { ok: boolean; reason?: string }) => void;
}

/**
 * WebSocket client for live updates (EP-11.4).
 *
 * The protocol matches the server's ConnectionRegistry:
 * - Client sends: { type: 'subscribe' | 'unsubscribe', pattern: string }
 * - Server sends: { type: 'subscribed' | 'unsubscribed' | 'event' | 'error' | 'permissions-changed', subject?, payload?, message? }
 *
 * Subject format: atlas.<channelId>.<domain>.<entity>.<action>  or  user.<userId>.<...>
 * Subscription patterns support wildcards: atlas.ch12.asset.>  or  user.user-123.>
 *
 * Reconnection uses exponential backoff (1s, 2s, 4s, 8s, max 30s).
 * All subscriptions are re-sent after reconnect.
 *
 * The access token is sent as a query parameter: ?token=<accessToken>
 * (IAM refreshes the token; this client does NOT hold the refresh token.)
 */
@Injectable({ providedIn: 'root' })
export class WebSocketService {
  private readonly auth = inject(AuthService);
  private readonly session = inject(SessionStore);
  private readonly baseUrl = inject(API_BASE_URL);

  private ws: WebSocket | null = null;
  // Never completed for the service's lifetime: `disconnect()` is a pause, not the end of the
  // app — completing this made every reconnect after a sign-out/sign-in cycle silently dead.
  private readonly destroy$ = new Subject<void>();
  /** True once disconnect() was called explicitly; suppresses the reconnect that an onclose would start. */
  private intentionalClose = false;
  private readonly pending = new Map<number, PendingSubscription>();
  private pendingId = 0;
  /**
   * The DESIRED subscription set — what the UI asked for, confirmed or not. subscribe() records
   * here immediately so a pattern requested while connecting (or during a reconnect gap) is sent
   * the moment the socket opens rather than being silently dropped.
   */
  private subscriptions = new Set<string>();
  private reconnectAttempt = 0;
  private readonly maxReconnectDelay = 30_000;

  readonly state = signal<ConnectionState>('disconnected');
  readonly lastError = signal<string | null>(null);

  /** Emits every event frame received from the server. */
  readonly events$ = new Subject<{ subject: string; payload: unknown }>();

  /** Emits when a subscription is confirmed. */
  readonly subscribed$ = new Subject<{ pattern: string; ok: boolean; reason?: string }>();

  /** Emits when permissions change and a subscription is dropped. */
  readonly permissionsChanged$ = new Subject<{ pattern: string; message: string }>();

  /** Connect if authenticated. Call once on app startup. */
  connect(): void {
    if (this.state() === 'connected' || this.state() === 'connecting') return;
    if (!this.auth.token() || !this.session.isAuthenticated()) {
      this.lastError.set('Not authenticated');
      return;
    }
    this.intentionalClose = false;
    this.open();
  }

  /** Disconnect and clear state. The desired set survives, so a later connect() restores it. */
  disconnect(): void {
    this.intentionalClose = true;
    this.destroy$.next(); // cancel any pending reconnect timer; the subject stays open for next time
    this.cleanup();
    this.state.set('disconnected');
    this.reconnectAttempt = 0;
  }

  /**
   * Subscribe to a pattern. The pattern joins the DESIRED set immediately and is (re)sent on
   * every open, so calling before the socket is ready is fine — nothing is silently dropped.
   * The returned promise only reports registration, not server confirmation: a refusal arrives
   * later as an `error` frame and drops the pattern from the set (see `subscribed$`/`lastError`).
   */
  subscribe(pattern: string): Promise<{ ok: boolean; reason?: string }> {
    if (this.subscriptions.has(pattern)) {
      return Promise.resolve({ ok: true });
    }
    this.subscriptions.add(pattern);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const id = ++this.pendingId;
      return new Promise((resolve) => {
        this.pending.set(id, { pattern, resolve });
        this.ws!.send(JSON.stringify({ type: 'subscribe', pattern }));
      });
    }
    // Not open: onopen sends every desired pattern, this one included. Resolving `ok` here means
    // "queued", not "confirmed" — the server has not seen it yet.
    return Promise.resolve({ ok: true });
  }

  /** Unsubscribe from a pattern. */
  unsubscribe(pattern: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.subscriptions.has(pattern)) return;
    this.ws.send(JSON.stringify({ type: 'unsubscribe', pattern }));
  }

  /** Check if currently subscribed to a pattern. */
  isSubscribed(pattern: string): boolean {
    return this.subscriptions.has(pattern);
  }

  private open(): void {
    this.state.set('connecting');
    this.lastError.set(null);

    const token = this.auth.token();
    const url = `${this.baseUrl.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token ?? '')}`;

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      this.handleError(err instanceof Error ? err.message : 'WebSocket construction failed');
      return;
    }

    this.ws.onopen = () => {
      this.state.set('connected');
      this.reconnectAttempt = 0;
      // Re-send all subscriptions
      for (const pattern of this.subscriptions) {
        this.ws!.send(JSON.stringify({ type: 'subscribe', pattern }));
      }
    };

    this.ws.onmessage = (event) => this.handleMessage(event.data);

    this.ws.onclose = (event) => {
      if (!this.intentionalClose) {
        this.scheduleReconnect(event.wasClean ? null : event.reason || 'Connection closed');
      }
    };

    this.ws.onerror = () => {
      // onclose will fire with wasClean=false after this
    };
  }

  private handleMessage(data: string): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }

    switch (frame.type) {
      case 'subscribed':
        this.handleSubscribed(frame.subject!, true);
        break;
      case 'unsubscribed':
        this.handleSubscribed(frame.subject!, false);
        break;
      case 'event':
        if (frame.subject !== undefined) {
          this.events$.next({ subject: frame.subject, payload: frame.payload ?? {} });
        }
        break;
      case 'error':
        this.handleError(frame.message ?? 'Server error', frame.subject);
        break;
      case 'permissions-changed':
        if (frame.subject !== undefined) {
          // The server dropped it, so it leaves the desired set too — a reconnect must not
          // resurrect a subscription the server has ruled ineligible.
          this.subscriptions.delete(frame.subject);
          this.permissionsChanged$.next({
            pattern: frame.subject,
            message: frame.message ?? 'Subscription dropped',
          });
        }
        break;
    }
  }

  private handleSubscribed(pattern: string, ok: boolean): void {
    const pending = [...this.pending.entries()].find(([, v]) => v.pattern === pattern);
    if (pending) {
      const [id, { resolve }] = pending;
      this.pending.delete(id);
      if (ok) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, reason: 'Subscription refused' });
      }
    }
    if (!ok) {
      // Refused server-side — drop it from the desired set or every reconnect re-asks.
      this.subscriptions.delete(pattern);
    }
    this.subscribed$.next({ pattern, ok });
  }

  private handleError(message: string, subject?: string): void {
    this.lastError.set(message);
    if (subject) {
      // An error for a subscribe (e.g. forbidden pattern) is a refusal — drop it like one.
      this.subscriptions.delete(subject);
      const pending = [...this.pending.entries()].find(([, v]) => v.pattern === subject);
      if (pending) {
        const [id, { resolve }] = pending;
        this.pending.delete(id);
        resolve({ ok: false, reason: message });
      }
    }
  }

  private scheduleReconnect(_reason: string | null): void {
    if (this.intentionalClose) return;
    this.state.set('reconnecting');
    this.cleanup();

    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, this.maxReconnectDelay);
    this.reconnectAttempt++;

    timer(delay)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => {
          if (!this.intentionalClose && this.auth.token() && this.session.isAuthenticated()) {
            this.open();
          }
        },
      });
  }

  private cleanup(): void {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, 'Client disconnect');
      }
      this.ws = null;
    }
  }
}
