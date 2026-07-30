import type { WorkflowDefinition, ValidationIssue, ValidationResult, Step } from './types.ts';
import { validateSchema } from './schema.ts';
import { feelParseError, referencedVars } from './feel.ts';

/** Collect every FEEL expression ('='-prefixed string) with its JSON-pointer path. */
function collectFeel(node: unknown, path: string, out: { path: string; expr: string }[]): void {
  if (typeof node === 'string') {
    if (/^\s*=/.test(node)) out.push({ path, expr: node });
  } else if (Array.isArray(node)) {
    node.forEach((v, i) => collectFeel(v, `${path}/${i}`, out));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) collectFeel(v, `${path}/${k}`, out);
  }
}

/**
 * Tier-1 (schema) + Tier-2 (graph & semantic) validation.
 * Mirrors docs/architecture/bms-workflow-dsl-and-designer.md §6.
 */
export function validateDefinition(def: WorkflowDefinition): ValidationResult {
  const issues: ValidationIssue[] = [];

  // Tier-1: schema.
  const schema = validateSchema(def);
  if (!schema.valid) {
    for (const e of schema.errors)
      issues.push({ severity: 'error', code: 'SCHEMA', message: e.message, path: e.path });
    // Graph checks assume a well-formed shape; bail if the shape is broken.
    return { valid: false, issues };
  }

  const steps = def.steps ?? [];
  const transitions = def.transitions ?? [];
  const stepIds = new Set(steps.map((s) => s.id));
  const declaredVars = new Set((def.vars ?? []).map((v) => v.name));

  // Unique ids.
  const dupStep = firstDuplicate(steps.map((s) => s.id));
  if (dupStep) issues.push({ severity: 'error', code: 'DUP_STEP_ID', message: `duplicate step id "${dupStep}"`, stepId: dupStep });
  const dupTr = firstDuplicate(transitions.map((t) => t.id));
  if (dupTr) issues.push({ severity: 'error', code: 'DUP_TRANSITION_ID', message: `duplicate transition id "${dupTr}"`, transitionId: dupTr });

  // Exactly one start; >= 1 end.
  const starts = steps.filter((s) => s.kind === 'start');
  const ends = steps.filter((s) => s.kind === 'end');
  if (starts.length !== 1) issues.push({ severity: 'error', code: 'START_COUNT', message: `must have exactly one start (found ${starts.length})` });
  if (ends.length < 1) issues.push({ severity: 'error', code: 'END_COUNT', message: 'must have at least one end' });

  // Transition endpoints resolve.
  for (const t of transitions) {
    if (!stepIds.has(t.from)) issues.push({ severity: 'error', code: 'BAD_FROM', message: `transition "${t.id}" from unknown step "${t.from}"`, transitionId: t.id });
    if (!stepIds.has(t.to)) issues.push({ severity: 'error', code: 'BAD_TO', message: `transition "${t.id}" to unknown step "${t.to}"`, transitionId: t.id });
  }

  // Adjacency + degrees.
  const outAdj = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  for (const t of transitions) {
    if (stepIds.has(t.from) && stepIds.has(t.to)) {
      (outAdj.get(t.from) ?? outAdj.set(t.from, []).get(t.from)!).push(t.to);
      inDeg.set(t.to, (inDeg.get(t.to) ?? 0) + 1);
    }
  }

  // Reachability from start (BFS).
  if (starts.length === 1) {
    const seen = new Set<string>();
    const q = [starts[0].id];
    while (q.length) {
      const n = q.shift()!;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const m of outAdj.get(n) ?? []) q.push(m);
    }
    for (const s of steps) if (!seen.has(s.id)) issues.push({ severity: 'error', code: 'UNREACHABLE_STEP', message: `step "${s.id}" is unreachable from start`, stepId: s.id });
  }

  // Non-end steps need an outgoing edge.
  for (const s of steps) {
    if (s.kind !== 'end' && !(outAdj.get(s.id)?.length)) issues.push({ severity: 'error', code: 'NO_OUTGOING', message: `step "${s.id}" (${s.kind}) has no outgoing transition`, stepId: s.id });
  }

  // Branch: default or full coverage. We require a default (coverage can't be proven statically).
  for (const s of steps.filter((s) => s.kind === 'branch')) {
    const outs = transitions.filter((t) => t.from === s.id);
    const cfg = (s.config ?? {}) as { default?: string };
    const hasDefault = !!cfg.default || outs.some((t) => t.isDefault);
    const allConditioned = outs.every((t) => !!t.when);
    if (!hasDefault && allConditioned) issues.push({ severity: 'error', code: 'BRANCH_NO_DEFAULT', message: `branch "${s.id}" has no default and every outgoing edge is conditional`, stepId: s.id });
    if (cfg.default && !outs.some((t) => t.id === cfg.default)) issues.push({ severity: 'error', code: 'BRANCH_DEFAULT_MISSING', message: `branch "${s.id}" default "${cfg.default}" is not one of its outgoing transitions`, stepId: s.id });
  }

  // Parallel gateways: split needs >1 out; join needs >1 in.
  for (const s of steps.filter((s) => s.kind === 'parallel')) {
    const mode = (s.config as { mode?: string })?.mode;
    if (mode === 'split' && (outAdj.get(s.id)?.length ?? 0) < 2) issues.push({ severity: 'warning', code: 'PARALLEL_SPLIT_DEGREE', message: `parallel split "${s.id}" has < 2 outgoing edges`, stepId: s.id });
    if (mode === 'join' && (inDeg.get(s.id) ?? 0) < 2) issues.push({ severity: 'warning', code: 'PARALLEL_JOIN_DEGREE', message: `parallel join "${s.id}" has < 2 incoming edges`, stepId: s.id });
  }

  // compensation / onError.transitionTo reference existing steps.
  for (const s of steps) {
    if (s.compensation && !stepIds.has(s.compensation)) issues.push({ severity: 'error', code: 'BAD_COMPENSATION', message: `step "${s.id}" compensation "${s.compensation}" is not a step`, stepId: s.id });
    if (s.onError && typeof s.onError === 'object' && !stepIds.has(s.onError.transitionTo)) issues.push({ severity: 'error', code: 'BAD_ONERROR_TARGET', message: `step "${s.id}" onError.transitionTo "${s.onError.transitionTo}" is not a step`, stepId: s.id });
  }

  // FEEL: every expression parses; referenced vars are declared (warning).
  const exprs: { path: string; expr: string }[] = [];
  collectFeel(def, '', exprs);
  for (const { path, expr } of exprs) {
    const err = feelParseError(expr);
    const anchor = anchorFromPath(path, def);
    if (err) issues.push({ severity: 'error', code: 'FEEL_PARSE', message: `${err} in "${expr}"`, path, ...anchor });
    for (const v of referencedVars(expr)) {
      if (!declaredVars.has(v)) issues.push({ severity: 'warning', code: 'UNBOUND_VAR', message: `expression references undeclared var "${v}"`, path, ...anchor });
    }
  }

  const valid = !issues.some((i) => i.severity === 'error');
  return { valid, issues };
}

function firstDuplicate(xs: string[]): string | null {
  const seen = new Set<string>();
  for (const x of xs) { if (seen.has(x)) return x; seen.add(x); }
  return null;
}

/** Map a JSON pointer like /steps/3/config/... back to the owning step or transition. */
function anchorFromPath(path: string, def: WorkflowDefinition): { stepId?: string; transitionId?: string } {
  const m = path.match(/^\/(steps|transitions)\/(\d+)/);
  if (!m) return {};
  const idx = Number(m[2]);
  if (m[1] === 'steps') return { stepId: def.steps[idx]?.id };
  return { transitionId: def.transitions[idx]?.id };
}
