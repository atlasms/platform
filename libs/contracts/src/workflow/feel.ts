import { parseExpression } from 'feelin';

/**
 * FEEL, held to the restricted subset decided for workflow expressions (2026-10-12, EP-23.6 —
 * docs/architecture/bms-workflow-dsl-and-designer.md §3). Still legal FEEL, so a condition
 * round-trips to BPMN unchanged; small enough that the editor can offer every construct and the
 * validator can name the one it refuses. Widening it is a decision recorded in §3, not an edit here.
 *
 * The check walks feelin's Lezer tree. It is an ALLOWLIST of node types: a construct this file has
 * never heard of — a new feelin release's — is refused rather than let through.
 */

/** The roots a path may start from — the context every expression is evaluated in (§3). */
export const FEEL_ROOTS = ['vars', 'incoming', 'steps', 'instance'] as const;

/** The functions an expression may call. `date`/`time`/`duration` are literals, not calls. */
export const FEEL_FUNCTIONS = [
  'count',
  'contains',
  'starts with',
  'ends with',
  'string length',
  'upper case',
  'lower case',
  'now',
  'not',
] as const;

// Every node type the subset's grammar produces — structural nodes and the keyword/punctuation
// tokens feelin names in its tree.
const ALLOWED_NODES = new Set([
  'Expression',
  'ParenthesizedExpression',
  'Conjunction',
  'Disjunction',
  'Comparison',
  'CompareOp',
  'ArithmeticExpression',
  'ArithOp',
  'IfExpression',
  'PathExpression',
  'PathName',
  'VariableName',
  'Identifier',
  'Name',
  'FunctionInvocation',
  'PositionalParameters',
  'PositiveUnaryTest',
  'PositiveUnaryTests',
  'List',
  'NumericLiteral',
  'StringLiteral',
  'BooleanLiteral',
  'NullLiteral',
  'DateTimeLiteral',
  'DateTimeConstructor',
  // tokens
  'if',
  'then',
  'else',
  'and',
  'or',
  'between',
  'in',
  'null',
  'true',
  'false',
  'date',
  'time',
  'date and time',
  'duration',
  '.',
  ',',
  '(',
  ')',
  '[',
  ']',
]);

// What a refused construct is called in the message an author reads.
const NAMED: Record<string, string> = {
  FunctionDefinition: 'a function definition',
  ForExpression: 'a `for` loop',
  QuantifiedExpression: '`some` / `every`',
  FilterExpression: 'a list filter',
  Context: 'a context literal',
  InstanceOfExpression: '`instance of`',
  NamedParameters: 'named parameters',
};

const strip = (expr: string): string => expr.replace(/^\s*=\s*/, '').trim();

// The roots, declared to the parser: FEEL reads `instance` as the start of `instance of` unless
// the context names it — exactly as the evaluator's context will.
const PARSE_CONTEXT = Object.fromEntries(FEEL_ROOTS.map((r) => [r, {}]));
const parse = (src: string): Cursor => parseExpression(src, PARSE_CONTEXT, undefined).cursor();

interface Cursor {
  type: { name: string; isError: boolean };
  from: number;
  to: number;
  next(): boolean;
  firstChild(): boolean;
  nextSibling(): boolean;
  parent(): boolean;
}

/**
 * Why an expression is refused, or null when it parses and stays inside the subset. The first
 * problem only — an author fixes one thing at a time, and later problems may be its echoes.
 */
export function feelProblem(
  expr: string,
): { code: 'FEEL_PARSE' | 'FEEL_SUBSET'; message: string } | null {
  const src = strip(expr);
  if (!src) return { code: 'FEEL_PARSE', message: 'empty expression' };
  let cursor: Cursor;
  try {
    cursor = parse(src);
  } catch (e) {
    return { code: 'FEEL_PARSE', message: e instanceof Error ? e.message : 'FEEL parse error' };
  }
  // Errors first: a tree with an error node is not worth judging construct by construct.
  const nodes: { name: string; from: number; to: number }[] = [];
  do {
    if (cursor.type.isError)
      return { code: 'FEEL_PARSE', message: `syntax error near offset ${cursor.from}` };
    nodes.push({ name: cursor.type.name, from: cursor.from, to: cursor.to });
  } while (cursor.next());

  for (const n of nodes) {
    if (!ALLOWED_NODES.has(n.name)) {
      const what = NAMED[n.name] ?? `\`${src.slice(n.from, n.to) || n.name}\``;
      return { code: 'FEEL_SUBSET', message: `${what} is outside the workflow expression subset` };
    }
  }
  return namesProblem(src);
}

// Names: a path must start at one of the roots, a call must name an allowed function. The tree
// says WHERE a name is; the text says WHICH — re-walked with parent links to tell a callee from a
// path root.
function namesProblem(src: string): { code: 'FEEL_SUBSET'; message: string } | null {
  const cursor = parse(src);
  const walk = (parentName: string, firstChildOfParent: boolean): string | null => {
    do {
      const name = cursor.type.name;
      if (name === 'VariableName') {
        const text = src.slice(cursor.from, cursor.to).trim();
        if (parentName === 'FunctionInvocation' && firstChildOfParent) {
          if (!(FEEL_FUNCTIONS as readonly string[]).includes(text))
            return `the function \`${text}\` is outside the workflow expression subset`;
        } else if (!(FEEL_ROOTS as readonly string[]).includes(text)) {
          return `\`${text}\` is not one of ${FEEL_ROOTS.join(', ')}`;
        }
      }
      if (cursor.firstChild()) {
        const inner = walk(name, true);
        cursor.parent();
        if (inner) return inner;
      }
      firstChildOfParent = false;
    } while (cursor.nextSibling());
    return null;
  };
  const message = walk('', false);
  return message ? { code: 'FEEL_SUBSET', message } : null;
}

/** The `vars.<name>` identifiers an expression references — checked against the declared vars. */
export function referencedVars(expr: string): string[] {
  const out = new Set<string>();
  const re = /\bvars\.([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr))) if (m[1]) out.add(m[1]);
  return [...out];
}
