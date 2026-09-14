import { TestBed } from '@angular/core/testing';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { API_BASE_URL } from './api.ts';
import { AuthService } from './auth.service.ts';
import { SessionStore } from './session.store.ts';
import { WEBSOCKET_TUNING, WebSocketService, type WebSocketTuning } from './websocket.service.ts';

class FakeAuth {
  tokenValue: string | null = 'test-access-token';
  token() {
    return this.tokenValue;
  }
}

class FakeSession {
  authenticated = true;
  userIdValue = 'user-1';
  channelIdValue = 'ch12';
  policyValue = { subjectId: 'user-1', permVersion: 1, rules: [] };
  isAuthenticated() {
    return this.authenticated;
  }
  userId() {
    return this.userIdValue;
  }
  channelId() {
    return this.channelIdValue;
  }
  policy() {
    return this.policyValue;
  }
}

/**
 * A WebSocket that never opens, never errors and never closes — a connection attempt to a dead
 * port would fire onerror/onclose eventually and start a real reconnect-timer chain the test
 * process would then wait on forever. Events are fired by hand where a test needs them.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  /**
   * The readyState constants, which a stand-in for `globalThis.WebSocket` MUST carry.
   *
   * Without them every `readyState === WebSocket.OPEN` guard in the service compares against
   * `undefined` and is therefore always false — so the fake reported "socket closed" no matter
   * what the test had set, and every open-socket path was quietly unreachable. A double that
   * cannot be in the state under test does not test it.
   */
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly url: string;
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { wasClean: boolean; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(frame: string) {
    this.sent.push(frame);
  }
  close() {
    this.readyState = 3; // CLOSED
  }
}

describe('WebSocketService', () => {
  let fakeAuth: FakeAuth;
  let fakeSession: FakeSession;
  let service: WebSocketService;
  let realWebSocket: typeof WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    realWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    fakeAuth = new FakeAuth();
    fakeSession = new FakeSession();
    TestBed.configureTestingModule({
      providers: [
        WebSocketService,
        { provide: AuthService, useValue: fakeAuth },
        { provide: SessionStore, useValue: fakeSession },
        { provide: API_BASE_URL, useValue: 'http://localhost:30080' },
      ],
    });
    service = TestBed.inject(WebSocketService);
  });

  afterEach(() => {
    service.disconnect();
    globalThis.WebSocket = realWebSocket;
  });

  it('does not connect when not authenticated', () => {
    fakeAuth.tokenValue = null;
    service.connect();
    expect(service.state()).toBe('disconnected');
    expect(service.lastError()).toBe('Not authenticated');
  });

  it('does not connect when session not authenticated', () => {
    fakeSession.authenticated = false;
    service.connect();
    expect(service.state()).toBe('disconnected');
    expect(service.lastError()).toBe('Not authenticated');
  });

  it('subscribe QUEUES while the socket is not open — the pattern is not lost', async () => {
    // Panels mount before the connection lands; a subscription made then must go out on open,
    // not vanish. Registration reports ok (queued), and the pattern is visible immediately.
    const result = await service.subscribe('atlas.ch12.asset.>');
    expect(result).toEqual({ ok: true });
    expect(service.isSubscribed('atlas.ch12.asset.>')).toBe(true);
  });

  it('isSubscribed returns false for unknown pattern', () => {
    expect(service.isSubscribed('atlas.ch12.asset.>')).toBe(false);
  });

  it('disconnect clears state', () => {
    service.disconnect();
    expect(service.state()).toBe('disconnected');
  });

  it('reconnect is still armed after a disconnect/connect cycle', async () => {
    // Regression: disconnect() used to COMPLETE the lifecycle subject, so every reconnect after
    // a sign-out/sign-in cycle was silently dead. The desired set survives disconnect on purpose.
    await service.subscribe('atlas.ch12.asset.>');
    service.disconnect();
    expect(service.state()).toBe('disconnected');

    service.connect();
    expect(service.state()).toBe('connecting');
    expect(service.isSubscribed('atlas.ch12.asset.>')).toBe(true);

    service.disconnect(); // leave no reconnect timer running into the next test
  });

  it('a pattern subscribed BEFORE connect is sent when the socket opens', async () => {
    // The EP-20.9 bug this guards: panels mount before the connection lands, and a subscription
    // made then used to be silently dropped, so "live" panels never received a single event.
    await service.subscribe('atlas.ch12.asset.>');
    service.connect();

    const socket = FakeWebSocket.instances[0]!;
    expect(socket.url).toContain('/ws?token=test-access-token');
    expect(socket.sent).toEqual([]); // still CONNECTING — nothing may be sent before open

    socket.readyState = 1; // OPEN
    socket.onopen?.();
    expect(socket.sent).toEqual([
      JSON.stringify({ type: 'subscribe', pattern: 'atlas.ch12.asset.>' }),
    ]);
  });

  it('desired patterns are re-sent after a reconnect', async () => {
    await service.subscribe('atlas.ch12.asset.>');
    service.connect();
    const first = FakeWebSocket.instances[0]!;
    first.readyState = 1;
    first.onopen?.();

    // The connection drops; the reconnect opens a NEW socket and re-sends the desired set.
    first.onclose?.({ wasClean: false, reason: 'lost' });
    expect(service.state()).toBe('reconnecting');

    // Fire the pending reconnect immediately rather than waiting out the backoff.
    service.disconnect(); // cancel the timer — the assertion drives a manual reconnect instead
    service.connect();
    const second = FakeWebSocket.instances[1]!;
    second.readyState = 1;
    second.onopen?.();
    expect(second.sent).toEqual([
      JSON.stringify({ type: 'subscribe', pattern: 'atlas.ch12.asset.>' }),
    ]);
  });

  it('unsubscribe leaves the desired set even while the socket is DOWN', async () => {
    // The mirror of the queueing test above. unsubscribe() used to return early whenever the
    // socket was not open, so a panel destroyed during a reconnect gap kept its pattern in the
    // desired set — and the reconnect resubscribed on behalf of a component that no longer
    // existed, forever. Letting go must work in every state that asking for it works in.
    await service.subscribe('atlas.ch12.asset.>');
    expect(service.isSubscribed('atlas.ch12.asset.>')).toBe(true);

    service.unsubscribe('atlas.ch12.asset.>');
    expect(service.isSubscribed('atlas.ch12.asset.>')).toBe(false);

    service.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.readyState = 1;
    socket.onopen?.();
    expect(socket.sent).toEqual([]); // nothing was left to re-ask for
  });

  it('unsubscribe sends the frame when the socket IS open', async () => {
    service.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.readyState = 1;
    socket.onopen?.();
    // On an OPEN socket the promise settles on the server's ack, not on registration — so ack it
    // rather than awaiting a frame nobody is going to send.
    const subscribed = service.subscribe('atlas.ch12.asset.>');
    socket.onmessage?.({
      data: JSON.stringify({ type: 'subscribed', subject: 'atlas.ch12.asset.>' }),
    });
    await expect(subscribed).resolves.toEqual({ ok: true });
    socket.sent.length = 0;

    service.unsubscribe('atlas.ch12.asset.>');
    expect(socket.sent).toEqual([
      JSON.stringify({ type: 'unsubscribe', pattern: 'atlas.ch12.asset.>' }),
    ]);

    // A second call is a no-op: the pattern is already gone, so there is nothing to tell the
    // server about and no frame to send.
    socket.sent.length = 0;
    service.unsubscribe('atlas.ch12.asset.>');
    expect(socket.sent).toEqual([]);
  });

  it('an `unsubscribed` ack does not resolve a pending SUBSCRIBE as refused', async () => {
    // The two acknowledgements shared one handler, which read `unsubscribed` as ok=false — the
    // same value a refusal carries. So unsubscribing one pattern while subscribing to it again
    // reported the new subscription denied, and told subscribed$ a confirmation had failed.
    service.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.readyState = 1;
    socket.onopen?.();

    const seen: { pattern: string; ok: boolean }[] = [];
    service.subscribed$.subscribe((s) => seen.push({ pattern: s.pattern, ok: s.ok }));

    const pending = service.subscribe('atlas.ch12.asset.>');
    socket.onmessage?.({
      data: JSON.stringify({ type: 'unsubscribed', subject: 'atlas.ch12.asset.>' }),
    });
    expect(seen).toEqual([]); // an ack for letting go is not a confirmation of anything

    socket.onmessage?.({
      data: JSON.stringify({ type: 'subscribed', subject: 'atlas.ch12.asset.>' }),
    });
    await expect(pending).resolves.toEqual({ ok: true });
    expect(seen).toEqual([{ pattern: 'atlas.ch12.asset.>', ok: true }]);
  });

  it('a refusal is what makes subscribed$ report ok:false', async () => {
    // A denied pattern arrives as an `error` frame, and that branch never emitted on subscribed$ —
    // so the one stream a panel can watch to learn it was denied stayed silent on every denial.
    service.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.readyState = 1;
    socket.onopen?.();

    const seen: { pattern: string; ok: boolean; reason?: string }[] = [];
    service.subscribed$.subscribe((s) => seen.push(s));

    const pending = service.subscribe('atlas.ch99.asset.>');
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'error',
        subject: 'atlas.ch99.asset.>',
        message: 'Forbidden pattern',
      }),
    });

    await expect(pending).resolves.toEqual({ ok: false, reason: 'Forbidden pattern' });
    expect(seen).toEqual([
      { pattern: 'atlas.ch99.asset.>', ok: false, reason: 'Forbidden pattern' },
    ]);
    // Refused server-side, so it must not come back on the next reconnect.
    expect(service.isSubscribed('atlas.ch99.asset.>')).toBe(false);
  });
});

/**
 * EP-09.4 — reconnect, backoff, the heartbeat and the polling fallback, under fake timers with the
 * tuning pinned: a 100 ms base, a 400 ms cap, a 1 s heartbeat, a 2 s poll, and `random` pinned to
 * 0 so a backoff is exactly half its cap (equal jitter's floor).
 */
describe('WebSocketService — reconnect, heartbeat and the polling fallback (EP-09.4)', () => {
  let fakeAuth: FakeAuth;
  let fakeSession: FakeSession;
  let service: WebSocketService;
  let realWebSocket: typeof WebSocket;
  let random = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    random = 0;
    FakeWebSocket.instances = [];
    realWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    fakeAuth = new FakeAuth();
    fakeSession = new FakeSession();
    TestBed.configureTestingModule({
      providers: [
        WebSocketService,
        { provide: AuthService, useValue: fakeAuth },
        { provide: SessionStore, useValue: fakeSession },
        { provide: API_BASE_URL, useValue: 'http://localhost:30080' },
        {
          provide: WEBSOCKET_TUNING,
          useValue: {
            baseDelayMs: 100,
            maxDelayMs: 400,
            heartbeatMs: 1_000,
            pollIntervalMs: 2_000,
            random: () => random,
          } satisfies WebSocketTuning,
        },
      ],
    });
    service = TestBed.inject(WebSocketService);
  });

  afterEach(() => {
    service.disconnect();
    globalThis.WebSocket = realWebSocket;
    vi.useRealTimers();
  });

  /** Open the most recent socket as the server would. */
  function openLatest(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.readyState = 1;
    socket.onopen?.();
    return socket;
  }

  it('backs off exponentially with jitter, up to the cap, and starts over once connected', async () => {
    await service.subscribe('atlas.ch12.asset.>');
    service.connect();
    openLatest().onclose?.({ wasClean: false, reason: 'lost' });
    expect(service.state()).toBe('reconnecting');

    // Attempt 1: cap 100 → delay 50 with random pinned to 0. Not a moment before.
    vi.advanceTimersByTime(49);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Attempt 2: cap 200 → 100. Attempt 3: cap 400 → 200. Attempt 4: capped at 400 → 200 again.
    for (const expected of [100, 200, 200]) {
      const before = FakeWebSocket.instances.length;
      FakeWebSocket.instances.at(-1)!.onclose?.({ wasClean: false, reason: 'lost' });
      vi.advanceTimersByTime(expected - 1);
      expect(FakeWebSocket.instances).toHaveLength(before);
      vi.advanceTimersByTime(1);
      expect(FakeWebSocket.instances).toHaveLength(before + 1);
    }

    // With random at its other extreme the delay is the whole cap: [cap/2, cap).
    random = 0.999;
    FakeWebSocket.instances.at(-1)!.onclose?.({ wasClean: false, reason: 'lost' });
    vi.advanceTimersByTime(398);
    const count = FakeWebSocket.instances.length;
    vi.advanceTimersByTime(2);
    expect(FakeWebSocket.instances).toHaveLength(count + 1);

    // An open resets the ladder: the next drop waits the FIRST delay again.
    random = 0;
    openLatest().onclose?.({ wasClean: false, reason: 'lost' });
    const beforeReset = FakeWebSocket.instances.length;
    vi.advanceTimersByTime(50);
    expect(FakeWebSocket.instances).toHaveLength(beforeReset + 1);
  });

  it('a reconnect tells consumers to re-sync — the first connect does not', async () => {
    const reasons: string[] = [];
    service.resync$.subscribe((r) => reasons.push(r));
    await service.subscribe('atlas.ch12.asset.>');

    service.connect();
    const first = openLatest();
    expect(reasons).toEqual([]); // nothing was missed: there was no "before"

    first.onclose?.({ wasClean: false, reason: 'lost' });
    vi.advanceTimersByTime(50);
    const second = openLatest();
    // Subscriptions go out BEFORE the re-sync signal, so a refetch cannot race a gap it is still in.
    expect(second.sent).toEqual([
      JSON.stringify({ type: 'subscribe', pattern: 'atlas.ch12.asset.>' }),
    ]);
    expect(reasons).toEqual(['reconnected']);

    // A sign-out/sign-in is a fresh session, not a gap: no re-sync on its first open either.
    service.disconnect();
    service.connect();
    openLatest();
    expect(reasons).toEqual(['reconnected']);
  });

  it('while the socket is down, consumers are polled — only if something is subscribed, and never once it is back', async () => {
    const reasons: string[] = [];
    service.resync$.subscribe((r) => reasons.push(r));
    random = 0.999; // keep the reconnect attempts far apart so the poll cadence is what we see
    service.connect();
    openLatest().onclose?.({ wasClean: false, reason: 'lost' });
    expect(service.degraded()).toBe(true);

    // No open panel asked for anything: nobody is polled on their behalf.
    vi.advanceTimersByTime(2_000);
    expect(reasons).toEqual([]);

    await service.subscribe('atlas.ch12.asset.>');
    vi.advanceTimersByTime(2_000);
    expect(reasons).toEqual(['poll']);
    vi.advanceTimersByTime(2_000);
    expect(reasons).toEqual(['poll', 'poll']);

    // Back up: the reconnect re-syncs once, and the polling stops. The server answers the
    // heartbeat, or the client would (rightly) give the socket up as dead and poll again.
    const back = openLatest();
    expect(service.degraded()).toBe(false);
    expect(reasons).toEqual(['poll', 'poll', 'reconnected']);
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(1_000);
      back.onmessage?.({ data: JSON.stringify({ type: 'pong' }) });
    }
    expect(reasons).toEqual(['poll', 'poll', 'reconnected']);
  });

  it('pings the server on a cadence, and treats a silent period as a dead socket', () => {
    service.connect();
    const socket = openLatest();

    vi.advanceTimersByTime(1_000);
    expect(socket.sent).toEqual([JSON.stringify({ type: 'ping' })]);
    socket.onmessage?.({ data: JSON.stringify({ type: 'pong' }) });

    vi.advanceTimersByTime(1_000);
    expect(socket.sent).toHaveLength(2);
    // Any frame proves the peer alive — an event counts as much as a pong.
    socket.onmessage?.({
      data: JSON.stringify({ type: 'event', subject: 'atlas.ch12.asset.updated', payload: {} }),
    });
    vi.advanceTimersByTime(1_000);
    expect(socket.sent).toHaveLength(3);
    expect(service.state()).toBe('connected');

    // Now nothing answers. At the next tick the socket is given up on, closed and reconnected —
    // the TCP connection is still "open", which is exactly why a page needs its own heartbeat.
    vi.advanceTimersByTime(1_000);
    expect(service.state()).toBe('reconnecting');
    expect(socket.readyState).toBe(3); // CLOSED by us
    vi.advanceTimersByTime(50);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('a constructor that throws is a failed attempt that reconnects, not a socket forever "connecting"', () => {
    const original = globalThis.WebSocket;
    let attempts = 0;
    globalThis.WebSocket = class {
      constructor() {
        attempts += 1;
        throw new Error('blocked by page policy');
      }
    } as unknown as typeof WebSocket;

    service.connect();
    expect(service.state()).toBe('reconnecting');
    expect(service.lastError()).toBe('blocked by page policy');
    vi.advanceTimersByTime(50);
    expect(attempts).toBe(2);

    globalThis.WebSocket = original;
  });

  it('connect() while a reconnect is pending takes over from the timer — one socket, not two', async () => {
    service.connect();
    openLatest().onclose?.({ wasClean: false, reason: 'lost' });
    expect(service.state()).toBe('reconnecting');

    service.connect(); // the session re-authenticated, say
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(10_000); // the old timer must not open a third
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

// WebSocket integration tests would require a real WebSocket server.
// The walking-skeleton tests cover the full protocol end-to-end.
