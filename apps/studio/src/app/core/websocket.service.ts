import { computed, inject, Injectable, InjectionToken, signal } from '@angular/core';
import { Subject, timer } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { AuthService } from './auth.service.ts';
import { SessionStore } from './session.store.ts';
import { API_BASE_URL } from './api.ts';

export type ClientFrameType = 'subscribe' | 'unsubscribe' | 'ping';

export interface ClientFrame {
  type: ClientFrameType;
  pattern?: string;
}

export interface ServerFrame {
  type: 'event' | 'subscribed' | 'unsubscribed' | 'error' | 'permissions-changed' | 'pong';
  subject?: string;
  payload?: unknown;
  message?: string;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/**
 * Why a consumer is being told to refetch (EP-09.4).
 *
 * `reconnected`: the socket came back after a gap, and there is no replay window (websocket.md
 * §6.2 — `resume` needs Redis, which is not built), so anything published during the gap is gone.
 * The only honest recovery is a re-sync via REST, which is what §6.2 prescribes when the gap
 * exceeds the window — and with no window, every gap does.
 *
 * `poll`: the socket has been down for a while. Live panels degrade to polling
 * (NFR-AVAIL-7) rather than sitting on data that stopped changing when the connection did.
 */
export type ResyncReason = 'reconnected' | 'poll';

export interface WebSocketTuning {
  /** First reconnect delay; doubles per attempt up to `maxDelayMs`, with jitter. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** Client-side heartbeat period; a ping unanswered by the next tick means the socket is dead. */
  heartbeatMs: number;
  /** How often `resync$` fires `poll` while the socket is down and something is subscribed. */
  pollIntervalMs: number;
  /** The jitter source — injectable so a test can pin it. */
  random: () => number;
}

export const WEBSOCKET_TUNING = new InjectionToken<WebSocketTuning>('WEBSOCKET_TUNING', {
  providedIn: 'root',
  factory: () => ({
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    heartbeatMs: 30_000,
    pollIntervalMs: 30_000,
    random: Math.random,
  }),
});

interface PendingSubscription {
  pattern: string;
  resolve: (value: { ok: boolean; reason?: string }) => void;
}

/**
 * WebSocket client for live updates (EP-11.4).
 *
 * The protocol matches the server's ConnectionRegistry:
 * - Client sends: { type: 'subscribe' | 'unsubscribe', pattern: string } and { type: 'ping' }
 * - Server sends: { type: 'subscribed' | 'unsubscribed' | 'event' | 'error' | 'permissions-changed' | 'pong', subject?, payload?, message? }
 *
 * Subject format: atlas.<channelId>.<domain>.<entity>.<action>  or  user.<userId>.<...>
 * Subscription patterns support wildcards: atlas.ch12.asset.>  or  user.user-123.>
 *
 * Reconnection uses exponential backoff (1s, 2s, 4s, 8s, max 30s) with jitter — equal jitter,
 * `[cap/2, cap)`: a server restart otherwise brings every open Studio back in lockstep, at the
 * same second, forever. All subscriptions are re-sent after reconnect, and `resync$` then tells
 * every live consumer to refetch, because there is no replay of the gap (see `ResyncReason`).
 *
 * The client heartbeats too. The server pings sockets, but the browser answers those without
 * telling the page, so page script cannot tell a server that died from one with nothing to say.
 * A `ping` frame every `heartbeatMs` with no `pong` (or any other frame) by the next tick closes
 * the socket, which is what starts the reconnect that would otherwise never come.
 *
 * The access token is sent as a query parameter: ?token=<accessToken>
 * (IAM refreshes the token; this client does NOT hold the refresh token.)
 */
@Injectable({ providedIn: 'root' })
export class WebSocketService {
  private readonly auth = inject(AuthService);
  private readonly session = inject(SessionStore);
  private readonly baseUrl = inject(API_BASE_URL);
  private readonly tuning = inject(WEBSOCKET_TUNING);

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
  /** True once a socket has opened in this session: the next open is a RE-connect. */
  private everConnected = false;
  /** Set when a ping goes out; cleared by any frame. Still set at the next tick = dead socket. */
  private awaitingPong = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Ends the current poll loop; a new one starts with the next degradation. */
  private readonly stopPolling$ = new Subject<void>();

  readonly state = signal<ConnectionState>('disconnected');
  readonly lastError = signal<string | null>(null);
  /**
   * Live updates are not arriving and the panels are polling instead (NFR-AVAIL-7). `connecting`
   * is not degraded: nothing has been missed yet, and the first connect is the normal path.
   */
  readonly degraded = computed(() => this.state() === 'reconnecting');

  /** Emits every event frame received from the server. */
  readonly events$ = new Subject<{ subject: string; payload: unknown }>();

  /**
   * "Refetch what you show." Emitted once on every reconnect after a gap, and every
   * `pollIntervalMs` while the socket is down and at least one pattern is desired — nobody is
   * polled for a panel that is not open. A hidden tab is not polled either; it catches up on the
   * reconnect, or the first tick after it is shown.
   */
  readonly resync$ = new Subject<ResyncReason>();

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
    // A connect() while a reconnect is pending (the session re-authenticated) takes over from the
    // timer; otherwise the timer would open a SECOND socket next to this one.
    this.destroy$.next();
    this.stopPolling$.next();
    this.open();
  }

  /** Disconnect and clear state. The desired set survives, so a later connect() restores it. */
  disconnect(): void {
    this.intentionalClose = true;
    this.destroy$.next(); // cancel any pending reconnect timer; the subject stays open for next time
    this.stopPolling$.next();
    this.cleanup();
    this.state.set('disconnected');
    this.reconnectAttempt = 0;
    this.everConnected = false;
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

  /**
   * Unsubscribe from a pattern. The mirror of `subscribe()`: the DESIRED set is updated whatever
   * the socket is doing, and the frame goes out only if there is a socket to send it on.
   *
   * Returning early while disconnected — which is what this did — left the pattern in the desired
   * set, so the next reconnect re-subscribed a panel that had already been destroyed, and the
   * events came back to nobody. A subscription must not outlive the thing that asked for it just
   * because the socket happened to be down when it let go.
   */
  unsubscribe(pattern: string): void {
    if (!this.subscriptions.delete(pattern)) return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'unsubscribe', pattern }));
    }
  }

  /** Check if currently subscribed to a pattern. */
  isSubscribed(pattern: string): boolean {
    return this.subscriptions.has(pattern);
  }

  private open(): void {
    // A re-attempt stays `reconnecting`: the socket has been lost since the last open, whatever
    // this particular attempt is doing, and that is what `degraded` and the polling key on. A
    // browser can sit in CONNECTING for tens of seconds; the panels must not stop polling for it.
    if (this.state() !== 'reconnecting') this.state.set('connecting');
    this.lastError.set(null);

    const token = this.auth.token();
    const url = `${this.baseUrl.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token ?? '')}`;

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      // A constructor that throws (a malformed URL, a page policy) is a failed attempt like any
      // other. Leaving the state at `connecting` with no timer, as this did, was a socket that
      // never came back and a UI that said it was on its way.
      this.handleError(err instanceof Error ? err.message : 'WebSocket construction failed');
      this.scheduleReconnect('construction failed');
      return;
    }

    this.ws.onopen = () => {
      const reconnected = this.everConnected;
      this.everConnected = true;
      this.state.set('connected');
      this.reconnectAttempt = 0;
      this.stopPolling$.next();
      // Re-send all subscriptions
      for (const pattern of this.subscriptions) {
        this.ws!.send(JSON.stringify({ type: 'subscribe', pattern }));
      }
      this.startHeartbeat();
      // After the subscriptions, so a consumer's refetch cannot race a gap it is still in.
      if (reconnected) this.resync$.next('reconnected');
    };

    this.ws.onmessage = (event) => {
      this.awaitingPong = false; // any frame proves the peer alive, not only a pong
      this.handleMessage(event.data);
    };

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
        if (frame.subject !== undefined) this.handleSubscribed(frame.subject);
        break;
      case 'unsubscribed':
        // An acknowledgement, not a refusal. Routing it through the subscribe path resolved a
        // pending subscribe as "Subscription refused" and told `subscribed$` a confirmation had
        // failed — for a frame that means the server did exactly what was asked. All that is left
        // to do is make sure the desired set agrees, which it already will when we initiated it.
        if (frame.subject !== undefined) this.subscriptions.delete(frame.subject);
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
      case 'pong':
        break; // already counted in onmessage
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      if (this.awaitingPong) {
        // Nothing — not even the pong — in a whole period. The TCP connection may well still be
        // "open"; that is precisely the case this exists for. Treat it as dropped.
        this.scheduleReconnect('heartbeat missed');
        return;
      }
      this.awaitingPong = true;
      this.ws.send(JSON.stringify({ type: 'ping' }));
    }, this.tuning.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.awaitingPong = false;
  }

  /**
   * The polling fallback. While the socket is down, `resync$` fires `poll` on an interval so the
   * open live panels refetch on a cadence instead of freezing. Stops on open or on disconnect.
   */
  private startPolling(): void {
    this.stopPolling$.next();
    timer(this.tuning.pollIntervalMs, this.tuning.pollIntervalMs)
      .pipe(takeUntil(this.stopPolling$), takeUntil(this.destroy$))
      .subscribe(() => {
        if (this.state() !== 'reconnecting' || this.subscriptions.size === 0) return;
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        this.resync$.next('poll');
      });
  }

  /** A server confirmation that the pattern is now subscribed. Refusals arrive as `error`. */
  private handleSubscribed(pattern: string): void {
    const pending = [...this.pending.entries()].find(([, v]) => v.pattern === pattern);
    if (pending) {
      const [id, { resolve }] = pending;
      this.pending.delete(id);
      resolve({ ok: true });
    }
    this.subscribed$.next({ pattern, ok: true });
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
      // A refusal is the ONLY thing that makes `subscribed$.ok` false. It used to be emitted from
      // the `unsubscribed` branch instead, which meant the one stream a panel can watch to learn
      // it was denied never fired on an actual denial.
      this.subscribed$.next({ pattern: subject, ok: false, reason: message });
    }
  }

  private scheduleReconnect(_reason: string | null): void {
    if (this.intentionalClose) return;
    const wasDegraded = this.state() === 'reconnecting';
    this.state.set('reconnecting');
    this.cleanup();
    if (!wasDegraded) this.startPolling();

    // Equal jitter: half the cap is the floor, the rest is chance. Full jitter can pick ~0 and
    // hammer a server that just came up; no jitter picks the same instant for every client.
    const cap = Math.min(
      this.tuning.baseDelayMs * 2 ** this.reconnectAttempt,
      this.tuning.maxDelayMs,
    );
    const delay = cap / 2 + this.tuning.random() * (cap / 2);
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
    this.stopHeartbeat();
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
