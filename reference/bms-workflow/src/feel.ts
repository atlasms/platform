import { parseExpression, evaluate } from 'feelin';

/** Evaluate a FEEL expression (strips the '=' convention prefix) against a context. */
export function feelEval(expr: string, ctx: Record<string, unknown>): unknown {
  const src = expr.replace(/^\s*=\s*/, '');
  return evaluate(src, ctx).value;
}

/**
 * Parse-check a FEEL expression (the '=' prefix is a convention, stripped here).
 * Returns an error message if the expression fails to parse, else null.
 * feelin returns a Lezer parse tree; syntax errors show up as error nodes.
 */
export function feelParseError(expr: string): string | null {
  const src = expr.replace(/^\s*=\s*/, '').trim();
  if (!src) return 'empty expression';
  let tree: any;
  try {
    tree = parseExpression(src);
  } catch (e: any) {
    return e?.message ?? 'FEEL parse error';
  }
  const cursor = tree.cursor();
  do {
    if (cursor.type.isError) return `FEEL syntax error near offset ${cursor.from}`;
  } while (cursor.next());
  return null;
}

/** Extract `vars.<name>` identifiers referenced in a FEEL expression (heuristic). */
export function referencedVars(expr: string): string[] {
  const out = new Set<string>();
  const re = /\bvars\.([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr))) out.add(m[1]);
  return [...out];
}
