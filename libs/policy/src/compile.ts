// effective(U) = rules(U) ∪ rules(groups(U)), flattened through roles.
// Compiled ONCE per permVersion, never per request (authorization-model.md §6).

import type { CompileInput, EffectivePolicy, Rule } from './types.ts';

/**
 * Flatten every rule reachable from the subject into one list.
 *
 * Grants are **additive** — the union of the user's own rules and all their groups' rules
 * ([FR-IAM-4]). Rules are de-duplicated by `id`, because the same role can be reached through
 * several groups and counting it twice would be meaningless.
 *
 * Deny rules (the optional extension) are preserved and sorted **first**, purely so a reader
 * scanning a compiled policy sees the overrides before the grants; `can()` does not depend on
 * ordering.
 */
export function compile(input: CompileInput): EffectivePolicy {
  const byId = new Map<string, Rule>();

  const addAll = (rules: Rule[] | undefined): void => {
    for (const rule of rules ?? []) {
      if (!byId.has(rule.id)) byId.set(rule.id, rule);
    }
  };

  addAll(input.rules);
  for (const role of input.roles ?? []) addAll(role.rules);

  for (const group of input.groups ?? []) {
    addAll(group.rules);
    for (const role of group.roles ?? []) addAll(role.rules);
  }

  const rules = [...byId.values()].sort((a, b) => {
    const aDeny = a.effect === 'deny' ? 0 : 1;
    const bDeny = b.effect === 'deny' ? 0 : 1;
    return aDeny - bDeny;
  });

  return { subjectId: input.subjectId, permVersion: input.permVersion, rules };
}
