// Acceptance rules (EP-15.3; FR-ING-4, FR-ING-5) — the model, the parser, and the engine.
//
// A channel has rule SETS. Each set has a scope — every job, one source kind, or one source — and
// rules; a job is validated against every enabled set whose scope matches it. The engine is
// PURE: it takes the sets and what is known about the job and returns a verdict, so it is tested
// exhaustively without a store, and the service's only job is to apply the verdict in a
// transaction.
//
// The worst failure decides. `reject` beats `quarantine`, and a rule that cannot be evaluated
// from what is known — an aspect-ratio rule before the file has been probed (EP-15.4) —
// quarantines the job for review rather than letting it through: a rule an operator wrote is
// never silently skipped. No applicable rule set means accepted; there is nothing to fail.
//
// `kind` is the rule vocabulary and this file branches on it: a Tier-0 enum, declared in
// rim.yaml. It grows with what is known about a job, not ahead of it.

import { isUlid, ulid } from '@atlas/contracts';
import { ValidationError } from '@atlas/service-kit';
import type { SourceKind } from './upload.ts';

export const RULE_KINDS = ['container', 'minSizeBytes', 'maxSizeBytes', 'aspectRatio'] as const;
export type RuleKind = (typeof RULE_KINDS)[number];
export const ON_FAIL = ['reject', 'quarantine'] as const;
export type OnFail = (typeof ON_FAIL)[number];
const SOURCE_KINDS: readonly SourceKind[] = ['upload', 'ftp', 'watch', 'recorder'];

export interface AcceptanceRule {
  id: string;
  kind: RuleKind;
  onFail: OnFail;
  label?: string;
  /** `container`: accepted file extensions, lowercase, no dot. */
  containers?: string[];
  /** `minSizeBytes` / `maxSizeBytes`: the bound, inclusive. */
  bytes?: number;
  /** `aspectRatio`: W:H. */
  aspectRatio?: string;
}

export interface RuleScope {
  sourceKind?: SourceKind;
  sourceId?: string;
}

export interface AcceptanceRuleSetInput {
  name: string;
  scope: RuleScope;
  rules: AcceptanceRule[];
  enabled: boolean;
}

export interface AcceptanceRuleSet extends AcceptanceRuleSetInput {
  id: string;
  channelId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** What the engine knows about a job. `technicalMetadata` arrives with the probe (EP-15.4). */
export interface Facts {
  source: string;
  sourceKind: SourceKind;
  filename: string;
  sizeBytes: number;
  technicalMetadata?: { aspectRatio?: string };
}

export type Outcome = 'accepted' | 'quarantined' | 'rejected';

export interface Verdict {
  outcome: Outcome;
  /** Present unless accepted: why, in words an operator reads. */
  reason?: string;
  ruleId?: string;
  ruleSetId?: string;
}

const MAX_RULES = 100;
const MAX_NAME = 200;
const MAX_LABEL = 200;
const ASPECT = /^[1-9][0-9]*:[1-9][0-9]*$/;
const EXTENSION = /^[a-z0-9]{1,16}$/;

// --- parsing ------------------------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseRule(raw: unknown, at: string): AcceptanceRule {
  if (!isRecord(raw)) throw new ValidationError(`${at} must be an object`);
  const kind = raw['kind'];
  if (!RULE_KINDS.includes(kind as RuleKind)) {
    throw new ValidationError(`${at}.kind must be one of ${RULE_KINDS.join(', ')}`);
  }
  const onFail = raw['onFail'];
  if (!ON_FAIL.includes(onFail as OnFail)) {
    throw new ValidationError(`${at}.onFail must be one of ${ON_FAIL.join(', ')}`);
  }
  const id = raw['id'] ?? ulid();
  if (typeof id !== 'string' || !isUlid(id)) throw new ValidationError(`${at}.id must be a ULID`);
  const rule: AcceptanceRule = { id, kind: kind as RuleKind, onFail: onFail as OnFail };
  const label = raw['label'];
  if (label !== undefined) {
    if (typeof label !== 'string' || label.length === 0 || label.length > MAX_LABEL) {
      throw new ValidationError(`${at}.label must be 1..${MAX_LABEL} characters`);
    }
    rule.label = label;
  }
  // The parameter a kind needs is required for that kind, and only that one: a rule carrying a
  // parameter it does not read is a rule someone wrote wrongly, refused rather than half-applied.
  const containers = raw['containers'];
  const bytes = raw['bytes'];
  const aspectRatio = raw['aspectRatio'];
  switch (rule.kind) {
    case 'container': {
      if (!Array.isArray(containers) || containers.length === 0) {
        throw new ValidationError(`${at}.containers must list at least one extension`);
      }
      const list = containers.map((c) => (typeof c === 'string' ? c.trim().toLowerCase() : ''));
      if (list.some((c) => !EXTENSION.test(c))) {
        throw new ValidationError(
          `${at}.containers must be extensions: letters and digits, no dot`,
        );
      }
      rule.containers = [...new Set(list)];
      if (bytes !== undefined || aspectRatio !== undefined) {
        throw new ValidationError(`${at}: a container rule takes only \`containers\``);
      }
      break;
    }
    case 'minSizeBytes':
    case 'maxSizeBytes': {
      if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) {
        throw new ValidationError(`${at}.bytes must be a non-negative integer`);
      }
      rule.bytes = bytes;
      if (containers !== undefined || aspectRatio !== undefined) {
        throw new ValidationError(`${at}: a size rule takes only \`bytes\``);
      }
      break;
    }
    case 'aspectRatio': {
      if (typeof aspectRatio !== 'string' || !ASPECT.test(aspectRatio)) {
        throw new ValidationError(`${at}.aspectRatio must be W:H, such as 16:9`);
      }
      rule.aspectRatio = aspectRatio;
      if (containers !== undefined || bytes !== undefined) {
        throw new ValidationError(`${at}: an aspect-ratio rule takes only \`aspectRatio\``);
      }
      break;
    }
  }
  return rule;
}

export function parseRuleSetInput(body: unknown): AcceptanceRuleSetInput {
  if (!isRecord(body)) throw new ValidationError('body must be an object');
  const name = body['name'];
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > MAX_NAME) {
    throw new ValidationError(`name must be 1..${MAX_NAME} characters`);
  }
  const scopeRaw = body['scope'] ?? {};
  if (!isRecord(scopeRaw)) throw new ValidationError('scope must be an object');
  const scope: RuleScope = {};
  if (scopeRaw['sourceKind'] !== undefined) {
    if (!SOURCE_KINDS.includes(scopeRaw['sourceKind'] as SourceKind)) {
      throw new ValidationError(`scope.sourceKind must be one of ${SOURCE_KINDS.join(', ')}`);
    }
    scope.sourceKind = scopeRaw['sourceKind'] as SourceKind;
  }
  if (scopeRaw['sourceId'] !== undefined) {
    const sourceId = scopeRaw['sourceId'];
    if (typeof sourceId !== 'string' || sourceId.length === 0 || sourceId.length > MAX_NAME) {
      throw new ValidationError('scope.sourceId must be a non-empty string');
    }
    scope.sourceId = sourceId;
  }
  const rules = body['rules'];
  if (!Array.isArray(rules)) throw new ValidationError('rules must be an array');
  if (rules.length > MAX_RULES) throw new ValidationError(`rules: at most ${MAX_RULES}`);
  const parsed = rules.map((r, i) => parseRule(r, `rules[${i}]`));
  const ids = new Set(parsed.map((r) => r.id));
  if (ids.size !== parsed.length) throw new ValidationError('rules: ids must be distinct');
  const enabled = body['enabled'] ?? true;
  if (typeof enabled !== 'boolean') throw new ValidationError('enabled must be a boolean');
  return { name: name.trim(), scope, rules: parsed, enabled };
}

// --- the engine ------------------------------------------------------------------------------------------

/** Does this set apply to this job. An empty scope is every job in the channel. */
export function applies(
  set: AcceptanceRuleSet,
  facts: Pick<Facts, 'source' | 'sourceKind'>,
): boolean {
  if (!set.enabled) return false;
  if (set.scope.sourceKind !== undefined && set.scope.sourceKind !== facts.sourceKind) return false;
  if (set.scope.sourceId !== undefined && set.scope.sourceId !== facts.source) return false;
  return true;
}

type Check = { ok: true } | { ok: false; reason: string; decided: boolean };

const formatBytes = (n: number): string => `${n.toLocaleString('en-US')} bytes`;

function extensionOf(filename: string): string | undefined {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return undefined;
  return filename.slice(dot + 1).toLowerCase();
}

function check(rule: AcceptanceRule, facts: Facts): Check {
  const name = rule.label ?? rule.kind;
  switch (rule.kind) {
    case 'container': {
      const ext = extensionOf(facts.filename);
      const allowed = rule.containers ?? [];
      if (ext !== undefined && allowed.includes(ext)) return { ok: true };
      return {
        ok: false,
        decided: true,
        reason:
          ext === undefined
            ? `"${facts.filename}" has no container extension; ${name} accepts ${allowed.join(', ')}`
            : `container "${ext}" is not one of ${allowed.join(', ')} (${name})`,
      };
    }
    case 'minSizeBytes': {
      const min = rule.bytes ?? 0;
      if (facts.sizeBytes >= min) return { ok: true };
      return {
        ok: false,
        decided: true,
        reason: `${formatBytes(facts.sizeBytes)} is under the minimum of ${formatBytes(min)} (${name})`,
      };
    }
    case 'maxSizeBytes': {
      const max = rule.bytes ?? 0;
      if (facts.sizeBytes <= max) return { ok: true };
      return {
        ok: false,
        decided: true,
        reason: `${formatBytes(facts.sizeBytes)} is over the maximum of ${formatBytes(max)} (${name})`,
      };
    }
    case 'aspectRatio': {
      const actual = facts.technicalMetadata?.aspectRatio;
      if (actual === undefined) {
        // Not a failure — an unknown. The job is held for a person until the probe (EP-15.4)
        // can answer; passing it would be skipping a rule an operator wrote.
        return {
          ok: false,
          decided: false,
          reason: `aspect ratio ${rule.aspectRatio} required (${name}) and the file has not been probed`,
        };
      }
      if (actual === rule.aspectRatio) return { ok: true };
      return {
        ok: false,
        decided: true,
        reason: `aspect ratio ${actual} is not ${rule.aspectRatio} (${name})`,
      };
    }
  }
}

const SEVERITY: Record<Outcome, number> = { accepted: 0, quarantined: 1, rejected: 2 };

/**
 * Validate a job against the sets that apply to it. Sets are taken in id order and rules in
 * their written order, so the reason names the FIRST rule at the worst severity — stable across
 * runs, whatever order the store returned the sets in.
 */
export function evaluate(sets: readonly AcceptanceRuleSet[], facts: Facts): Verdict {
  let verdict: Verdict = { outcome: 'accepted' };
  const applicable = [...sets]
    .filter((s) => applies(s, facts))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const set of applicable) {
    for (const rule of set.rules) {
      const result = check(rule, facts);
      if (result.ok) continue;
      const outcome: Outcome =
        result.decided && rule.onFail === 'reject' ? 'rejected' : 'quarantined';
      if (SEVERITY[outcome] <= SEVERITY[verdict.outcome]) continue;
      verdict = { outcome, reason: result.reason, ruleId: rule.id, ruleSetId: set.id };
      if (outcome === 'rejected') return verdict;
    }
  }
  return verdict;
}

export function newRuleSet(
  input: AcceptanceRuleSetInput,
  by: { userId: string; channelId: string },
  now: string,
): AcceptanceRuleSet {
  return {
    id: ulid(),
    channelId: by.channelId,
    ...input,
    createdBy: by.userId,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}
