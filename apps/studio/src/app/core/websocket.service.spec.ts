import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, beforeEach } from 'vitest';
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

describe('WebSocketService', () => {
  let fakeAuth: FakeAuth;
  let fakeSession: FakeSession;
  let service: WebSocketService;

  beforeEach(() => {
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

  it('subscribe returns not connected when socket not open', async () => {
    const result = await service.subscribe('atlas.ch12.asset.>');
    expect(result).toEqual({ ok: false, reason: 'Not connected' });
  });

  it('isSubscribed returns false for unknown pattern', () => {
    expect(service.isSubscribed('atlas.ch12.asset.>')).toBe(false);
  });

  it('disconnect clears state', () => {
    service.disconnect();
    expect(service.state()).toBe('disconnected');
  });
});

// WebSocket integration tests would require a real WebSocket server.
// The walking-skeleton tests cover the full protocol end-to-end.
