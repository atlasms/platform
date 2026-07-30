// The decision function. THE SAME function runs in every service (to enforce) and in Studio
// (to render). A second implementation is the bug — authorization-model.md §11.

import type { Decision, EffectivePolicy, ResourceContext, Rule } from './types.ts';
import { ruleMatches } from './match.ts';

/**
 * May this subject perform `permission` on this resource?
 *
 * ```ts
 * can(policy, 'asset:write', { channelId: 'ch12', categoryPath: '/sports/', fieldGroup: 'rights' })
 * ```
 *
 * **Omitting the resource asks the broad question** — `can(policy, 'asset:write')` means
 * *"could this subject write **any** asset?"*, which is the right question for showing a nav
 * item. It is NOT a substitute for the resource-specific check at the point of action.
 *
 * **The server is the authority.** A decision made in the browser is UX only; every request is
 * re-checked server-side (authorization-model.md §1).
 */
export interface CanOptions {
  /**
   * Require every declared scope predicate to be **satisfied by a supplied value**.
   *
   * Default `false` (lenient) so Studio can ask broad questions. **Services enforcing a
   * decision should pass `true`** — or better, use {@link canEnforce}. Lenient mode is
   * deliberately permissive: a channel-scoped rule matches when no `channelId` is supplied,
   * so an incomplete context yields a WIDER answer, not a narrower one.
   */
  strict?: boolean;
}

export function can(
  policy: EffectivePolicy,
  permission: string,
  resource?: ResourceContext,
  options?: CanOptions,
): Decision {
  const strict = options?.strict === true;
  const allows: Rule[] = [];

  for (const rule of policy.rules) {
    if (!ruleMatches(rule, permission, resource, policy.subjectId, strict)) continue;

    // Deny overrides allow and short-circuits: no allow can rescue a matched deny
    // (authorization-model.md §7). Honoured whenever a deny rule is present, so a policy
    // containing one is never silently treated as additive-only.
    if (rule.effect === 'deny') {
      return {
        allowed: false,
        reason: `denied by rule ${rule.id}`,
      };
    }

    allows.push(rule);
  }

  if (allows.length === 0) {
    return {
      allowed: false,
      reason: `no rule grants "${permission}"${resource?.fieldGroup ? ` on field group "${resource.fieldGroup}"` : ''}`,
    };
  }

  const fieldGroups = unionFieldGroups(allows);
  // Omit the key rather than set it to undefined (exactOptionalPropertyTypes), so
  // `'fieldGroups' in decision` is a meaningful "is this write narrowed?" test.
  return {
    allowed: true,
    ...(fieldGroups !== undefined ? { fieldGroups } : {}),
  };
}

/**
 * The server-side form. Identical to `can(..., { strict: true })`, named so that an
 * enforcement path reads as one at the call site and a reviewer can grep for it.
 *
 * Use this in services. Use plain `can` in Studio, where the question is often broad
 * ("should this nav item show at all?") and a partial context is intentional.
 */
export function canEnforce(
  policy: EffectivePolicy,
  permission: string,
  resource: ResourceContext,
): Decision {
  return can(policy, permission, resource, { strict: true });
}

/**
 * Union of the field groups granted by the matching rules.
 *
 * Returns `undefined` when ANY matching rule declares no `fieldGroups`, because such a rule
 * grants all of them — and "all" cannot be honestly expressed as a finite list here, since the
 * evaluator does not know the full set of groups for the resource type.
 */
export function unionFieldGroups(rules: Rule[]): string[] | undefined {
  const out = new Set<string>();
  for (const rule of rules) {
    if (!rule.fieldGroups || rule.fieldGroups.length === 0) return undefined; // grants all
    for (const g of rule.fieldGroups) out.add(g);
  }
  return [...out].sort();
}
