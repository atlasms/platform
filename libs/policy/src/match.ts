// The matching primitives. Kept separate from `can` so each is independently testable —
// this is correctness-critical code (docs/roadmap/20-delivery-process.md#7-definition-of-done).

import type { Rule, ResourceContext } from './types.ts';

/**
 * Does a granted permission cover the requested one?
 * `*` is allowed for either half: `asset:*`, `*:read`, `*:*`.
 *
 * The REQUESTED permission is treated as literal — asking for `asset:*` does not match a
 * grant of `asset:read`, because "may I do everything to assets?" is a different question
 * from "may I read assets?".
 */
export function permissionMatches(granted: string, requested: string): boolean {
  const g = granted.split(':');
  const r = requested.split(':');
  if (g.length !== 2 || r.length !== 2) return false;
  const [gRes, gAct] = g as [string, string];
  const [rRes, rAct] = r as [string, string];
  return (gRes === '*' || gRes === rRes) && (gAct === '*' || gAct === rAct);
}

/**
 * Normalize a materialized category path so prefix matching cannot cross a segment boundary.
 *
 * Without this, a grant on `/sports/foot` would match `/sports/football/` — silently widening
 * a grant to a sibling subtree. Both sides are forced to end with `/` before comparison.
 */
function normalizePath(path: string): string {
  if (path === '') return '/';
  return path.endsWith('/') ? path : path + '/';
}

/** Is `grantPath` an ancestor-or-self of `resourcePath`? Segment-boundary safe. */
export function pathCovers(grantPath: string, resourcePath: string): boolean {
  return normalizePath(resourcePath).startsWith(normalizePath(grantPath));
}

/**
 * Does the rule's scope admit this context?
 *
 * Two rules, both from authorization-model.md §5:
 *  - an **omitted predicate** is "any";
 *  - a predicate whose context value is **absent** is not evaluated. That is what makes
 *    `can(policy, 'asset:write')` with no resource answer the broad question *"could this
 *    subject write any asset?"*. The resource-specific check still runs at the point of
 *    action and on the server.
 */
export function scopeMatches(
  rule: Rule,
  ctx: ResourceContext | undefined,
  subjectId: string,
  strict = false,
): boolean {
  const scope = rule.scope;
  if (!scope) return true;
  const c = ctx ?? {};

  // In STRICT mode a declared predicate with no supplied value cannot be satisfied.
  //
  // This exists because the lenient rule is a genuine footgun: omitting `channelId` from the
  // context makes the answer MORE permissive, since a channel-scoped rule then matches
  // everywhere. Studio wants the lenient behaviour (it asks broad questions to render nav);
  // a service enforcing a decision must not get a wider grant by forgetting a field.
  const missing = (v: unknown): boolean => v === undefined;

  if (scope.channelIds) {
    if (missing(c.channelId)) {
      if (strict) return false;
    } else if (!scope.channelIds.includes(c.channelId as string)) {
      return false;
    }
  }

  if (scope.categoryPaths) {
    if (missing(c.categoryPath)) {
      if (strict) return false;
    } else {
      const path = c.categoryPath as string;
      if (!scope.categoryPaths.some((p) => pathCovers(p, path))) return false;
    }
  }

  if (scope.states) {
    if (missing(c.state)) {
      if (strict) return false;
    } else if (!scope.states.includes(c.state as string)) {
      return false;
    }
  }

  if (scope.ownedOnly === true) {
    if (missing(c.ownerId)) {
      if (strict) return false;
    } else if (c.ownerId !== subjectId) {
      return false;
    }
  }

  return true;
}

/**
 * Does the rule cover the asked-for field group?
 * A rule declaring **no** `fieldGroups` grants **all** of them.
 */
export function fieldGroupMatches(rule: Rule, fieldGroup: string | undefined): boolean {
  if (fieldGroup === undefined) return true;
  if (!rule.fieldGroups || rule.fieldGroups.length === 0) return true;
  return rule.fieldGroups.includes(fieldGroup);
}

/** Does this rule match the request in full? */
export function ruleMatches(
  rule: Rule,
  permission: string,
  ctx: ResourceContext | undefined,
  subjectId: string,
  strict = false,
): boolean {
  if (!rule.permissions.some((p) => permissionMatches(p, permission))) return false;
  if (!scopeMatches(rule, ctx, subjectId, strict)) return false;
  return fieldGroupMatches(rule, ctx?.fieldGroup);
}
