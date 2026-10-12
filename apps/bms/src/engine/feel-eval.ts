// Evaluating a workflow expression. Pure and deterministic — it runs inside Temporal's workflow
// sandbox, where `now()` reads the workflow's own clock. The SUBSET was enforced when the
// definition was published (@atlas/contracts/workflow); this only evaluates.
import { evaluate } from 'feelin';

export interface FeelContext {
  vars: Record<string, unknown>;
  incoming: Record<string, unknown>;
  steps: Record<string, { output: Record<string, unknown> }>;
  instance: { id: string };
}

/** Evaluate an `=`-prefixed FEEL expression against the instance's context. */
export function feelEval(expr: string, ctx: FeelContext): unknown {
  const src = expr.replace(/^\s*=\s*/, '');
  return evaluate(src, ctx as unknown as Record<string, unknown>).value;
}
