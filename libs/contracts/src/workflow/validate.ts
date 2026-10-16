import { payloadShape, validateDomain } from '../registry.ts';
import { WORKFLOW_COMMANDS } from './commands.ts';
import { feelProblem, referencedVars } from './feel.ts';
import type {
  CommandConfig,
  ValidationIssue,
  ValidationResult,
  WorkflowDefinition,
} from './types.ts';

/**
 * Tier 1 (the schema) and Tier 2 (the graph and its expressions) — the rules of
 * docs/architecture/bms-workflow-dsl-and-designer.md §6, lifted from reference/bms-workflow with
 * one addition: every expression is held to the restricted FEEL subset (§3), so an expression the
 * engine would refuse is refused at publish, named, and anchored to its step or edge.
 *
 * Sub-flow references (`sub-flow.workflowId` exists and is published) need the store, so BMS checks
 * them itself; everything here is a pure function of the definition.
 */
export function validateDefinition(def: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];

  const schema = validateDomain('workflow-definition', def);
  if (!schema.valid) {
    for (const e of schema.errors)
      issues.push({ severity: 'error', code: 'SCHEMA', message: e.message, path: e.path });
    // The graph checks assume a well-formed shape.
    return { valid: false, issues };
  }
  const wf = def as WorkflowDefinition;
  const steps = wf.steps;
  const transitions = wf.transitions;
  const stepIds = new Set(steps.map((s) => s.id));
  const declaredVars = new Set((wf.vars ?? []).map((v) => v.name));
  const error = (code: string, message: string, at: Partial<ValidationIssue> = {}): void => {
    issues.push({ severity: 'error', code, message, ...at });
  };

  const dupStep = firstDuplicate(steps.map((s) => s.id));
  if (dupStep) error('DUP_STEP_ID', `duplicate step id "${dupStep}"`, { stepId: dupStep });
  const dupTr = firstDuplicate(transitions.map((t) => t.id));
  if (dupTr)
    error('DUP_TRANSITION_ID', `duplicate transition id "${dupTr}"`, { transitionId: dupTr });

  const starts = steps.filter((s) => s.kind === 'start');
  if (starts.length !== 1)
    error('START_COUNT', `must have exactly one start (found ${starts.length})`);
  if (!steps.some((s) => s.kind === 'end')) error('END_COUNT', 'must have at least one end');

  for (const t of transitions) {
    if (!stepIds.has(t.from))
      error('BAD_FROM', `transition "${t.id}" from unknown step "${t.from}"`, {
        transitionId: t.id,
      });
    if (!stepIds.has(t.to))
      error('BAD_TO', `transition "${t.id}" to unknown step "${t.to}"`, { transitionId: t.id });
  }

  const outAdj = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  for (const t of transitions) {
    if (!stepIds.has(t.from) || !stepIds.has(t.to)) continue;
    const out = outAdj.get(t.from) ?? [];
    out.push(t.to);
    outAdj.set(t.from, out);
    inDeg.set(t.to, (inDeg.get(t.to) ?? 0) + 1);
  }

  const start = starts.length === 1 ? starts[0] : undefined;
  if (start) {
    const seen = new Set<string>();
    const queue = [start.id];
    for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
      if (seen.has(n)) continue;
      seen.add(n);
      queue.push(...(outAdj.get(n) ?? []));
    }
    for (const s of steps)
      if (!seen.has(s.id))
        error('UNREACHABLE_STEP', `step "${s.id}" is unreachable from start`, { stepId: s.id });
  }

  for (const s of steps)
    if (s.kind !== 'end' && !outAdj.get(s.id)?.length)
      error('NO_OUTGOING', `step "${s.id}" (${s.kind}) has no outgoing transition`, {
        stepId: s.id,
      });

  // A branch needs a default — coverage of the conditions cannot be proven statically.
  for (const s of steps.filter((x) => x.kind === 'branch')) {
    const outs = transitions.filter((t) => t.from === s.id);
    const cfg = (s.config ?? {}) as { default?: string };
    const hasDefault = Boolean(cfg.default) || outs.some((t) => t.isDefault);
    if (!hasDefault && outs.every((t) => Boolean(t.when)))
      error(
        'BRANCH_NO_DEFAULT',
        `branch "${s.id}" has no default and every outgoing edge is conditional`,
        { stepId: s.id },
      );
    if (cfg.default && !outs.some((t) => t.id === cfg.default))
      error(
        'BRANCH_DEFAULT_MISSING',
        `branch "${s.id}" default "${cfg.default}" is not one of its outgoing transitions`,
        { stepId: s.id },
      );
  }

  for (const s of steps.filter((x) => x.kind === 'parallel')) {
    const mode = (s.config as { mode?: string } | undefined)?.mode;
    if (mode === 'split' && (outAdj.get(s.id)?.length ?? 0) < 2)
      issues.push({
        severity: 'warning',
        code: 'PARALLEL_SPLIT_DEGREE',
        message: `parallel split "${s.id}" has < 2 outgoing edges`,
        stepId: s.id,
      });
    if (mode === 'join' && (inDeg.get(s.id) ?? 0) < 2)
      issues.push({
        severity: 'warning',
        code: 'PARALLEL_JOIN_DEGREE',
        message: `parallel join "${s.id}" has < 2 incoming edges`,
        stepId: s.id,
      });
  }

  for (const s of steps) {
    if (s.compensation && !stepIds.has(s.compensation))
      error('BAD_COMPENSATION', `step "${s.id}" compensation "${s.compensation}" is not a step`, {
        stepId: s.id,
      });
    if (s.onError && typeof s.onError === 'object' && !stepIds.has(s.onError.transitionTo))
      error(
        'BAD_ONERROR_TARGET',
        `step "${s.id}" onError.transitionTo "${s.onError.transitionTo}" is not a step`,
        { stepId: s.id },
      );
  }

  // A command step issues a platform command, and its completion is the command's own answer
  // (commands.ts): anything else would publish what BMS has no business publishing, or wait for
  // what nobody sends.
  for (const s of steps.filter((x) => x.kind === 'command')) {
    const cfg = s.config as CommandConfig;
    const command = WORKFLOW_COMMANDS[cfg.request.event];
    if (!command) {
      error(
        'UNKNOWN_COMMAND',
        `step "${s.id}" issues "${cfg.request.event}", which is not a command a workflow may issue (${Object.keys(WORKFLOW_COMMANDS).join(', ')})`,
        { stepId: s.id, path: `/steps/${steps.indexOf(s)}/config/request/event` },
      );
      continue;
    }
    // The input is FEEL, so its VALUES are known only at run time — but its keys are the
    // command's fields (a dotted key builds a nested one: `inputFile.kind`). A misspelt or a
    // missing field is refused here rather than by the target, a step and an instance later.
    const shape = payloadShape(cfg.request.event);
    if (shape) {
      const at = { stepId: s.id, path: `/steps/${steps.indexOf(s)}/config/request/input` };
      const given = new Set(Object.keys(cfg.request.input ?? {}).map((k) => k.split('.')[0]!));
      for (const field of given)
        if (!shape.properties.includes(field))
          error(
            'COMMAND_INPUT',
            `step "${s.id}": ${cfg.request.event} has no field "${field}" (${shape.properties.join(', ')})`,
            at,
          );
      for (const field of shape.required)
        if (!given.has(field))
          error('COMMAND_INPUT', `step "${s.id}": ${cfg.request.event} needs "${field}"`, at);
    }
    if (cfg.await?.event !== undefined && !command.completes.includes(cfg.await.event))
      error(
        'AWAIT_EVENT',
        `step "${s.id}" awaits "${cfg.await.event}", but ${cfg.request.event} is answered by ${command.completes.join(', ')}`,
        { stepId: s.id, path: `/steps/${steps.indexOf(s)}/config/await/event` },
      );
    // The answer is matched by the command's correlation id. Matching on an expression instead
    // means offering every answer to every waiting step — the event fan-out wait-event steps get
    // with EP-22.6 — so until then it is refused rather than silently ignored.
    if (cfg.await?.correlate !== undefined)
      error(
        'CORRELATE_UNSUPPORTED',
        `step "${s.id}": a command's answer is matched by its correlation id; await.correlate is not supported`,
        { stepId: s.id, path: `/steps/${steps.indexOf(s)}/config/await/correlate` },
      );
  }

  const exprs: { path: string; expr: string }[] = [];
  collectFeel(wf, '', exprs);
  for (const { path, expr } of exprs) {
    const anchor = anchorFromPath(path, wf);
    const problem = feelProblem(expr);
    if (problem) error(problem.code, `${problem.message} in "${expr}"`, { path, ...anchor });
    for (const v of referencedVars(expr))
      if (!declaredVars.has(v))
        issues.push({
          severity: 'warning',
          code: 'UNBOUND_VAR',
          message: `expression references undeclared var "${v}"`,
          path,
          ...anchor,
        });
  }

  return { valid: !issues.some((i) => i.severity === 'error'), issues };
}

/** Every FEEL expression — a string starting `=` — with its JSON pointer. */
function collectFeel(node: unknown, path: string, out: { path: string; expr: string }[]): void {
  if (typeof node === 'string') {
    if (/^\s*=/.test(node)) out.push({ path, expr: node });
  } else if (Array.isArray(node)) {
    node.forEach((v, i) => collectFeel(v, `${path}/${i}`, out));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) collectFeel(v, `${path}/${k}`, out);
  }
}

function firstDuplicate(xs: string[]): string | null {
  const seen = new Set<string>();
  for (const x of xs) {
    if (seen.has(x)) return x;
    seen.add(x);
  }
  return null;
}

/** /steps/3/config/... → the owning step; /transitions/2/when → the owning edge. */
function anchorFromPath(
  path: string,
  def: WorkflowDefinition,
): { stepId?: string } | { transitionId?: string } {
  const m = /^\/(steps|transitions)\/(\d+)/.exec(path);
  if (!m) return {};
  const idx = Number(m[2]);
  if (m[1] === 'steps') {
    const id = def.steps[idx]?.id;
    return id === undefined ? {} : { stepId: id };
  }
  const id = def.transitions[idx]?.id;
  return id === undefined ? {} : { transitionId: id };
}
