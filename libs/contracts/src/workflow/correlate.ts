// A wait-event step's `correlate` (EP-22.6; bms-workflow-dsl-and-designer.md §2.3), held to the
// shape decided on 2026-10-16: equality KEYS — `incoming.<field> = <expr>`, joined with `and` —
// never an arbitrary condition. The workflow evaluates each right-hand side when the step starts
// waiting and registers `{ field: value }`; the router then matches an event to the steps waiting
// for it by those keys, as an index would, instead of offering every event of the type to every
// waiting instance to judge for itself.
//
// Its own subpath (`@atlas/contracts/workflow-correlate`) because the interpreter calls it inside
// Temporal's workflow sandbox, where nothing but deterministic code may load: it depends on the
// FEEL parser alone, never on the schema registry the rest of `./workflow` reads from disk.

import { parseExpression } from 'feelin';

/** One key: the event's field (a dotted path into its payload) and the expression it must equal. */
export interface CorrelationKey {
  field: string;
  /** FEEL, without the leading `=` — evaluated when the step starts waiting. */
  expr: string;
}

interface Node {
  name: string;
  text: string;
  children: Node[];
}

// The roots, declared to the parser exactly as in feel.ts (FEEL reads a bare `instance` as the start
// of `instance of` otherwise).
const PARSE_CONTEXT = { vars: {}, incoming: {}, steps: {}, instance: {} };

function tree(src: string): Node {
  const cursor = parseExpression(src, PARSE_CONTEXT, undefined).cursor();
  const read = (): Node => {
    const node: Node = {
      name: cursor.type.name,
      text: src.slice(cursor.from, cursor.to),
      children: [],
    };
    if (cursor.firstChild()) {
      do node.children.push(read());
      while (cursor.nextSibling());
      cursor.parent();
    }
    return node;
  };
  return read();
}

const INCOMING_PATH = /^incoming((?:\.[A-Za-z_][A-Za-z0-9_]*)+)$/;

/** `incoming.a.b` → `a.b`; anything else → undefined. */
function incomingField(n: Node): string | undefined {
  if (n.name !== 'PathExpression') return undefined;
  const m = INCOMING_PATH.exec(n.text.replace(/\s+/g, ''));
  return m?.[1]?.slice(1);
}

function readsIncoming(n: Node): boolean {
  if (n.name === 'VariableName' && n.text.trim() === 'incoming') return true;
  return n.children.some(readsIncoming);
}

/**
 * The keys of a `correlate` expression, or why it is not one. Each conjunct is an `=` with an
 * `incoming.<field>` path on one side and, on the other, an expression that does not read
 * `incoming` — it is evaluated before the event exists. A field may be keyed once.
 */
export function correlationKeys(expr: string): { keys: CorrelationKey[] } | { problem: string } {
  const src = expr.replace(/^\s*=\s*/, '').trim();
  let root: Node;
  try {
    root = tree(src);
  } catch {
    return { problem: 'it does not parse' };
  }
  const conjuncts: Node[] = [];
  const collect = (n: Node): void => {
    if (n.name === 'Expression' || n.name === 'ParenthesizedExpression') {
      n.children.filter((c) => c.name !== '(' && c.name !== ')').forEach(collect);
    } else if (n.name === 'Conjunction') {
      n.children.filter((c) => c.name !== 'and').forEach(collect);
    } else conjuncts.push(n);
  };
  collect(root);

  const keys: CorrelationKey[] = [];
  for (const c of conjuncts) {
    const [left, op, right, ...rest] = c.children;
    if (c.name !== 'Comparison' || op?.text !== '=' || !left || !right || rest.length > 0)
      return {
        problem: `"${c.text}" is not an equality — correlate is \`incoming.<field> = <expr>\`, joined with \`and\``,
      };
    const lf = incomingField(left);
    const rf = incomingField(right);
    const [field, other] = lf !== undefined ? [lf, right] : [rf, left];
    if (field === undefined) return { problem: `"${c.text}" has no \`incoming.<field>\` side` };
    if (readsIncoming(other))
      return {
        problem: `"${c.text}": the side compared with incoming.${field} may not read \`incoming\` — it is evaluated before the event arrives`,
      };
    if (keys.some((k) => k.field === field)) return { problem: `incoming.${field} is keyed twice` };
    keys.push({ field, expr: other.text });
  }
  if (keys.length === 0) return { problem: 'it names no key' };
  return { keys };
}
