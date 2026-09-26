import type {
  AcceptanceRuleInput,
  AcceptanceRuleSet,
  AcceptanceRuleSetInput,
} from '../core/generated/rim.types.ts';
import type { Problems } from '../core/problems.ts';
import { ulid } from '../core/ulid.ts';

/**
 * The acceptance rule-set form's model (EP-15.3 in Studio), pure so it is tested without a DOM.
 *
 * RIM owns the rules and judges a set: it refuses one with a 422 naming the first thing wrong,
 * prefixed with where (`rules[2].bytes must be…`, `name must be…`). This file does not re-check
 * that; it turns the form into the body RIM reads and puts RIM's answer next to the row it is about.
 */

type Kind = AcceptanceRuleInput['kind'];
type OnFail = AcceptanceRuleInput['onFail'];
type SourceKind = NonNullable<NonNullable<AcceptanceRuleSetInput['scope']>['sourceKind']>;

/** From the generated union, so a kind the contract gains is a compile error here. */
const keys = <T extends string>(record: Record<T, true>): readonly T[] =>
  Object.keys(record) as T[];
export const RULE_KINDS = keys<Kind>({
  container: true,
  minSizeBytes: true,
  maxSizeBytes: true,
  aspectRatio: true,
});
export const ON_FAIL = keys<OnFail>({ quarantine: true, reject: true });
export const SOURCE_KINDS = keys<SourceKind>({
  upload: true,
  watch: true,
  ftp: true,
  recorder: true,
});

const MIB = 1024 * 1024;

/** One rule as the form holds it: every kind's parameter kept, so switching kind loses nothing. */
export interface RuleDraft {
  /** Kept across saves — a job's `ruleId` names the rule that held it, and must still. */
  id: string;
  kind: Kind;
  onFail: OnFail;
  label: string;
  /** `mxf, mov` — what the operator types. */
  containers: string;
  /** Sizes in MiB: nobody types 52428800. */
  mebibytes: number | null;
  aspectRatio: string;
}

/**
 * Which jobs the set applies to, as one select's value: every job, one source kind, or one
 * source by id (`source:<watcherId>`).
 */
export type ScopeChoice = 'all' | `kind:${SourceKind}` | `source:${string}`;

export interface RuleSetDraft {
  name: string;
  enabled: boolean;
  scope: ScopeChoice;
  rules: RuleDraft[];
}

export function newRule(kind: Kind = 'container'): RuleDraft {
  return {
    id: ulid(),
    kind,
    onFail: 'quarantine',
    label: '',
    containers: '',
    mebibytes: null,
    aspectRatio: '16:9',
  };
}

export function scopeOf(scope: AcceptanceRuleSetInput['scope']): ScopeChoice {
  // `upload` is the one upload source there is: "that source" and "that kind" are the same set.
  if (scope?.sourceId === 'upload') return 'kind:upload';
  if (scope?.sourceId) return `source:${scope.sourceId}`;
  if (scope?.sourceKind) return `kind:${scope.sourceKind}`;
  return 'all';
}

export function draftOfSet(set: AcceptanceRuleSet): RuleSetDraft {
  return {
    name: set.name,
    enabled: set.enabled,
    scope: scopeOf(set.scope),
    rules: set.rules.map((r) => ({
      ...newRule(r.kind),
      // Always present on a stored rule; the generated type sees the input shape through `allOf`.
      id: r.id ?? ulid(),
      onFail: r.onFail,
      label: r.label ?? '',
      containers: (r.containers ?? []).join(', '),
      mebibytes: r.bytes !== undefined ? r.bytes / MIB : null,
      aspectRatio: r.aspectRatio ?? '16:9',
    })),
  };
}

/**
 * The body RIM is sent: the whole set. Each rule carries only its kind's parameter (RIM refuses a
 * rule carrying one it does not read), a label only when there is one (RIM refuses an empty one),
 * and its id — so a replaced set's rules are still the rules jobs name. A size the form cannot
 * express (an empty box) is sent as nothing, and RIM says the bound is missing.
 */
export function inputOfSet(d: RuleSetDraft): AcceptanceRuleSetInput {
  return {
    name: d.name.trim(),
    enabled: d.enabled,
    scope: scopeInput(d.scope),
    rules: d.rules.map(ruleInput),
  };
}

function scopeInput(choice: ScopeChoice): NonNullable<AcceptanceRuleSetInput['scope']> {
  if (choice === 'all') return {};
  if (choice.startsWith('kind:')) return { sourceKind: choice.slice(5) as SourceKind };
  // One watcher: its kind too, so the set reads right in any tool that shows only the kind.
  return { sourceKind: 'watch', sourceId: choice.slice(7) };
}

function ruleInput(r: RuleDraft): AcceptanceRuleInput {
  const label = r.label.trim();
  const base: AcceptanceRuleInput = {
    id: r.id,
    kind: r.kind,
    onFail: r.onFail,
    ...(label ? { label } : {}),
  };
  switch (r.kind) {
    case 'container':
      return {
        ...base,
        containers: r.containers
          .split(/[\s,]+/)
          .map((c) => c.trim().replace(/^\./, '').toLowerCase())
          .filter(Boolean),
      };
    case 'minSizeBytes':
    case 'maxSizeBytes':
      return r.mebibytes === null ? base : { ...base, bytes: Math.round(r.mebibytes * MIB) };
    case 'aspectRatio':
      return { ...base, aspectRatio: r.aspectRatio.trim() };
  }
}

/**
 * RIM's refusal, placed. A problem about rule N (`rules[N]…`) goes under that rule — keyed
 * `rules.N` — one about the name under the name, and the rest above the form. RIM stops at the
 * first problem, so there is one; the next save shows the next.
 */
export function placeRuleSetProblems(message: string): Problems {
  const rule = /^rules\[(\d+)\]/.exec(message);
  if (rule) return { fields: { [`rules.${rule[1]}`]: [message] }, general: [] };
  if (/^name\b/.test(message)) return { fields: { name: [message] }, general: [] };
  return { fields: {}, general: [message] };
}

/** What a set's scope says, in the words the list shows. */
export function describeScope(
  scope: AcceptanceRuleSetInput['scope'],
  t: (key: string) => string,
  watcherName: (id: string) => string | undefined,
): string {
  const choice = scopeOf(scope);
  if (choice === 'all') return t('rules.scope.all');
  if (choice.startsWith('kind:')) return t(`rules.scope.kind.${choice.slice(5)}`);
  const id = choice.slice(7);
  return watcherName(id) ?? `${t('rules.scope.kind.watch')} (${id})`;
}
