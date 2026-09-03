import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { API_BASE_URL } from './api.ts';
import { AuthService } from './auth.service.ts';
import { SessionStore } from './session.store.ts';
import { WebSocketService } from './websocket.service.ts';

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
        provideZonelessChangeDetection(),
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
});

// WebSocket integration tests would require a real WebSocket server.
// The walking-skeleton tests cover the full protocol end-to-end.
