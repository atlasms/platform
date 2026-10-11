import { compile, type EffectivePolicy, type Rule } from '@atlas/policy';

/** A compiled policy granting exactly these permissions, unscoped. */
export function policyOf(permissions: string[]): EffectivePolicy {
  const rules: Rule[] = permissions.map((p) => ({ id: `r-${p}`, permissions: [p] }));
  return compile({ subjectId: 'user-1', permVersion: 1, rules, roles: [], groups: [] });
}
