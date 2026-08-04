import { inject, Injectable } from '@angular/core';
import { can, type Decision, type ResourceContext } from '@atlas/policy';
import { SessionStore } from './session.store.ts';

/**
 * Permission checks for rendering.
 *
 * ## Studio decides what to SHOW. The server decides what HAPPENS.
 *
 * Every answer here is UX only. The owning service re-checks with `canEnforce()` on every request
 * ([authorization-model.md §1](../../../../../docs/architecture/authorization-model.md)), so a
 * wrong answer here is a cosmetic bug, never a security hole. That asymmetry is what makes the
 * next paragraph safe.
 *
 * ## Why lenient `can()` is correct here — and `canEnforce()` is not
 *
 * `can()` is deliberately permissive: a channel-scoped rule matches when no `channelId` is
 * supplied, so **an incomplete context yields a WIDER answer** (§5.1). Services must therefore use
 * `canEnforce()`. Studio must not:
 *
 * - hiding a control the user *could* have used is a real failure — they cannot discover the
 *   feature, and it looks broken;
 * - showing one they cannot use costs a rejected request and an error message.
 *
 * The failure modes are not symmetric, and the server is backstopping either way. So the default
 * is lenient, and `decideStrict()` exists for the rare case where full context is genuinely known
 * and a false affordance would be actively harmful (a destructive action, say).
 *
 * **Do not "fix" this to `canEnforce`.** It would hide legitimate UI whenever a check is asked
 * before the resource is loaded, which is most of them.
 */
@Injectable({ providedIn: 'root' })
export class PermissionService {
  private readonly session = inject(SessionStore);

  /** The full decision, including the reason — useful for tooltips explaining *why* not. */
  decide(permission: string, resource?: ResourceContext): Decision {
    const policy = this.session.policy();
    if (!policy) return { allowed: false, reason: 'no session' };
    return can(policy, permission, this.withChannel(resource));
  }

  /** `true` if the user may do this. The everyday check. */
  can(permission: string, resource?: ResourceContext): boolean {
    return this.decide(permission, resource).allowed;
  }

  /**
   * Strict evaluation: every declared scope predicate must be satisfied by a supplied value.
   *
   * Only meaningful when the full resource context is known. Use for irreversible actions, where
   * offering a control the server will refuse is worse than hiding one it would have allowed.
   */
  decideStrict(permission: string, resource: ResourceContext): Decision {
    const policy = this.session.policy();
    if (!policy) return { allowed: false, reason: 'no session' };
    return can(policy, permission, this.withChannel(resource), { strict: true });
  }

  canStrict(permission: string, resource: ResourceContext): boolean {
    return this.decideStrict(permission, resource).allowed;
  }

  /**
   * Default the resource to the signed-in channel.
   *
   * Studio only ever shows one tenant at a time, and omitting `channelId` under lenient evaluation
   * means "any channel" — which would light up controls for tenants the user cannot actually
   * reach. Supplying it narrows every check to the one that is on screen.
   */
  private withChannel(resource?: ResourceContext): ResourceContext | undefined {
    const channelId = this.session.channelId();
    if (channelId === null) return resource;
    return { ...resource, channelId: resource?.channelId ?? channelId };
  }
}
