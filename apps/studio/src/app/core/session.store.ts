import { computed, Injectable, signal } from '@angular/core';
import { compile, type CompileInput, type EffectivePolicy } from '@atlas/policy';

export type { CompileInput, EffectivePolicy };

/**
 * Who is signed in, and what they may do.
 *
 * The policy is stored **compiled** — `compile()` is the same function IAM runs server-side, so
 * Studio and the services are reasoning over an identical structure rather than two hand-rolled
 * interpretations of the same JSON.
 *
 * Populating this from a real `/auth` round trip is EP-11.2; for now it is set explicitly.
 */
@Injectable({ providedIn: 'root' })
export class SessionStore {
  private readonly _policy = signal<EffectivePolicy | null>(null);
  private readonly _userId = signal<string | null>(null);
  private readonly _channelId = signal<string | null>(null);

  readonly policy = this._policy.asReadonly();
  readonly userId = this._userId.asReadonly();
  readonly channelId = this._channelId.asReadonly();

  /** Signed in *and* carrying a policy. A session without one can do nothing. */
  readonly isAuthenticated = computed(() => this._policy() !== null && this._userId() !== null);

  /**
   * The tenant every permission check is implicitly scoped to.
   *
   * Kept here rather than passed around because forgetting it is precisely how a check gets
   * asked too broadly — lenient evaluation treats a missing `channelId` as "any channel"
   * (authorization-model.md §5.1).
   */
  signIn(input: { userId: string; channelId: string; policy: CompileInput }): void {
    // Always compile, never trust a pre-flattened list: compile() unions the subject's own rules
    // with every rule reachable through their groups and roles. Skipping it would silently drop
    // group-derived grants, which look exactly like "the user has no permission".
    this._userId.set(input.userId);
    this._channelId.set(input.channelId);
    this._policy.set(compile(input.policy));
  }

  signOut(): void {
    this._policy.set(null);
    this._userId.set(null);
    this._channelId.set(null);
  }
}
