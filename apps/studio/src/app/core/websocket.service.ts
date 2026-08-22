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
  private readonly destroy$ = new Subject<void>();
  private readonly pending = new Map<number, PendingSubscription>();
  private pendingId = 0;
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
    this.open();
  }

  /** Disconnect and clear state. */
  disconnect(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.cleanup();
    this.state.set('disconnected');
    this.subscriptions.clear();
    this.reconnectAttempt = 0;
  }

  /** Subscribe to a pattern. Returns a promise that resolves when the server confirms. */
  subscribe(pattern: string): Promise<{ ok: boolean; reason?: string }> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ ok: false, reason: 'Not connected' });
    }
    if (this.subscriptions.has(pattern)) {
      return Promise.resolve({ ok: true });
    }
    const id = ++this.pendingId;
    return new Promise((resolve) => {
      this.pending.set(id, { pattern, resolve });
      this.ws!.send(JSON.stringify({ type: 'subscribe', pattern }));
    });
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
      if (!this.destroy$.closed) {
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
          this.subscriptions.delete(frame.subject);
          this.permissionsChanged$.next({ pattern: frame.subject, message: frame.message ?? 'Subscription dropped' });
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
    if (ok) {
      this.subscriptions.add(pattern);
    } else {
      this.subscriptions.delete(pattern);
    }
    this.subscribed$.next({ pattern, ok });
  }

  private handleError(message: string, subject?: string): void {
    this.lastError.set(message);
    if (subject) {
      const pending = [...this.pending.entries()].find(([, v]) => v.pattern === subject);
      if (pending) {
        const [id, { resolve }] = pending;
        this.pending.delete(id);
        resolve({ ok: false, reason: message });
      }
    }
  }

  private scheduleReconnect(_reason: string | null): void {
    if (this.destroy$.closed) return;
    this.state.set('reconnecting');
    this.cleanup();

    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, this.maxReconnectDelay);
    this.reconnectAttempt++;

    timer(delay)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => {
          if (!this.destroy$.closed && this.auth.token() && this.session.isAuthenticated()) {
            this.open();
          }
        },
        error: () => {
          // destroyed
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