import { inject, Injectable, signal } from '@angular/core';
import { HttpClient, HttpContext, HttpContextToken } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { CompileInput } from '@atlas/policy';
import { API_BASE_URL, type TokenPair } from './api.ts';
import { SessionStore } from './session.store.ts';

/**
 * Marks a request that must NOT be retried through the refresh flow.
 *
 * The auth endpoints themselves carry it: a 401 from `/auth/refresh` means the session is over, and
 * refreshing in response to it would recurse.
 */
export const SKIP_AUTH = new HttpContextToken<boolean>(() => false);
export const skipAuth = (): HttpContext => new HttpContext().set(SKIP_AUTH, true);

/**
 * The sign-in flow (EP-11.2).
 *
 * ## Tokens live in MEMORY, and only in memory
 *
 * Not `localStorage`, not `sessionStorage`. Both are readable by any script on the origin, so a
 * single XSS hands over the **refresh** token — the long-lived credential, good for minting access
 * tokens until it expires. Keeping it in a closure means an attacker has to exfiltrate during the
 * session rather than harvesting one later.
 *
 * The cost is real and deliberate: a page reload signs the user out. The fix is not to persist the
 * token where script can read it — it is for IAM to set an **httpOnly, SameSite=Strict cookie**, so
 * the browser can present the refresh token without Studio ever holding it. That is a server change
 * (IAM returns tokens in the response body today) and it is the follow-up this file is waiting for.
 * Until then, losing a session on reload is the safer of two bad options.
 *
 * ## Refresh is SINGLE-FLIGHT, and that is a correctness requirement
 *
 * IAM rotates refresh tokens and treats a **reused** one as a breach signal: it revokes the entire
 * token family, signing the user out of every session. Two requests refreshing concurrently — which
 * is the normal case when a token expires while a screen is loading — would present the same token
 * twice and trigger exactly that. So a refresh in progress is shared, never started twice.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);
  private readonly session = inject(SessionStore);

  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private inFlight: Promise<string | null> | null = null;

  /** Set while a sign-in or refresh is running, so the shell can show it. */
  readonly busy = signal(false);

  /** The bearer for the next request, or null when there is no session. */
  token(): string | null {
    return this.accessToken;
  }

  async signIn(username: string, password: string): Promise<void> {
    this.busy.set(true);
    try {
      const pair = await firstValueFrom(
        this.http.post<TokenPair>(
          `${this.base}/auth/login`,
          { username, password },
          { context: skipAuth() },
        ),
      );
      this.accessToken = pair.accessToken;
      this.refreshToken = pair.refreshToken;
      await this.loadSession();
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Exchange the refresh token for a new pair. Resolves to the new access token, or null when the
   * session is over.
   *
   * Callers share one in-flight attempt — see the class comment: concurrent refreshes are what
   * trigger IAM's reuse detection and revoke the whole family.
   */
  async refresh(): Promise<string | null> {
    if (this.inFlight) return this.inFlight;
    if (this.refreshToken === null) return null;

    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doRefresh(): Promise<string | null> {
    const token = this.refreshToken;
    if (token === null) return null;
    try {
      const pair = await firstValueFrom(
        this.http.post<TokenPair>(
          `${this.base}/auth/refresh`,
          { refreshToken: token },
          { context: skipAuth() },
        ),
      );
      this.accessToken = pair.accessToken;
      this.refreshToken = pair.refreshToken;
      return pair.accessToken;
    } catch {
      // A refresh that fails ends the session. Keeping the old tokens would mean retrying a
      // credential IAM has already rejected — and if the rejection was reuse detection, retrying is
      // what turns one revoked family into a loop.
      this.clear();
      return null;
    }
  }

  /**
   * Fetch the compiled policy and open the session.
   *
   * Separate from `signIn` because a token alone is not a usable session: Studio renders from the
   * policy, and a signed-in user with no policy would see an empty shell with no explanation.
   */
  private async loadSession(): Promise<void> {
    const policy = await firstValueFrom(
      this.http.get<CompileInput>(`${this.base}/api/v1/users/me/effective-permissions`),
    );
    const claims = readClaims(this.accessToken);
    this.session.signIn({
      userId: policy.subjectId,
      // The channel the token was minted for. Studio shows one tenant at a time and every
      // permission check is scoped to it (permission.service.ts), so a session without one would
      // silently ask every question too broadly.
      channelId: claims?.channelId ?? '',
      policy,
    });
  }

  async signOut(): Promise<void> {
    const token = this.refreshToken;
    this.clear();
    if (token === null) return;
    try {
      await firstValueFrom(
        this.http.post(
          `${this.base}/auth/logout`,
          { refreshToken: token },
          { context: skipAuth() },
        ),
      );
    } catch {
      // Local state is already cleared. A failed server-side revocation must not leave the browser
      // looking signed in — the user asked to leave, and the token dies on its own anyway.
    }
  }

  private clear(): void {
    this.accessToken = null;
    this.refreshToken = null;
    this.session.signOut();
  }
}

interface AccessClaims {
  sub?: string;
  channelId?: string;
  permVersion?: number;
}

/**
 * Read the claims out of an access token.
 *
 * DECODING IS NOT VERIFYING. There is no signature check here and there must not be one — the
 * browser holds no verification key, and a token Studio "verified" itself would prove nothing. Only
 * the gateway's verdict counts. This exists so the UI can label the session, never to make a
 * security decision.
 */
export function readClaims(token: string | null): AccessClaims | null {
  if (token === null) return null;
  const payload = token.split('.')[1];
  if (payload === undefined) return null;
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json) as AccessClaims;
  } catch {
    return null;
  }
}
