// The FEEL editor's judgement (EP-23.6; DSL doc §3): the SAME checker publish runs —
// `@atlas/contracts/workflow-feel`, the restricted subset over feelin's parser — in the browser, so
// what the editor says about an expression is what BMS will say, and it says it offline (§12.5).
import {
  FEEL_FUNCTIONS,
  FEEL_ROOTS,
  feelProblem,
  referencedVars,
} from '@atlas/contracts/workflow-feel';

export interface FeelVerdict {
  /** Why publish would refuse it — parse error or a construct outside the subset — or null. */
  problem: { code: 'FEEL_PARSE' | 'FEEL_SUBSET'; message: string } | null;
  /** `vars.<name>` it reads that the workflow does not declare (publish says UNBOUND_VAR). */
  undeclared: string[];
}

/** An expression judged. A blank one is no verdict at all: an optional field left empty. */
export function judge(expr: string, declared: readonly string[]): FeelVerdict | null {
  if (expr.trim() === '' || expr.trim() === '=') return null;
  return {
    problem: feelProblem(expr),
    undeclared: referencedVars(expr).filter((v) => !declared.includes(v)),
  };
}

export interface Snippet {
  /** What the button says. */
  label: string;
  /** What is inserted at the caret. */
  text: string;
  kind: 'root' | 'var' | 'function';
}

/**
 * What the editor offers to insert: every construct the subset allows by NAME — the four roots,
 * the workflow's declared vars, the allowed functions — so an author can build an expression
 * without knowing the subset by heart.
 */
export function snippets(declared: readonly string[]): Snippet[] {
  return [
    ...FEEL_ROOTS.map((r): Snippet => ({ label: r, text: `${r}.`, kind: 'root' })),
    ...declared.map((v): Snippet => ({ label: `vars.${v}`, text: `vars.${v}`, kind: 'var' })),
    ...FEEL_FUNCTIONS.map((f): Snippet => ({ label: `${f}()`, text: `${f}(`, kind: 'function' })),
  ];
}

/**
 * Text inserted at a selection — and an expression begun with `= ` when it had nothing, the
 * convention every FEEL field follows. Returns the new text and where the caret goes.
 */
export function insertAt(
  value: string,
  start: number,
  end: number,
  text: string,
): { value: string; caret: number } {
  if (value.trim() === '') return { value: `= ${text}`, caret: 2 + text.length };
  const before = value.slice(0, start);
  const after = value.slice(end);
  const pad = before !== '' && !/[\s(.[]$/.test(before) ? ' ' : '';
  return {
    value: `${before}${pad}${text}${after}`,
    caret: before.length + pad.length + text.length,
  };
}
