// The designer's palette (EP-23.1; bms-workflow-dsl-and-designer.md §5) — what `GET
// /workflows/palette` answers: one entry per step kind, with the display metadata from
// `docs/architecture/workflows/palette.json` and the kind's config JSON Schema RESOLVED from the one
// source of truth, `workflow-definition.schema.json` — every `$ref` inlined, so the designer
// generates a property panel from a self-contained schema without a resolver of its own.
//
// Each entry also carries the CLOSED lists its property panel offers (`choices`): the events a
// start may trigger on, the commands a command step may issue (with the authority each exercises),
// the events a wait-event may wait for — the same lists publish holds a definition to, so the
// designer cannot offer what publish would refuse.
//
// Inlining erases what a `$ref` said, so the schema is ANNOTATED where it matters to a property
// panel (EP-23.5): `x-atlas-type: feel | duration` where a field was a `Feel` or a `Duration`
// (an expression editor, a duration hint), and `x-choices: <key of choices>` on the field a closed
// list constrains. Annotations, not `enum`: a draft may hold a value the list no longer has (an
// import, a retired command), and the panel must still show it — publish is what refuses it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schemasDir, workflowsDir } from '../paths.ts';
import { WORKFLOW_COMMANDS } from './commands.ts';
import { WORKFLOW_EVENTS, WORKFLOW_TRIGGERS } from './events.ts';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface PaletteEntry {
  kind: string;
  label: string;
  icon?: string;
  category?: 'events' | 'activities' | 'gateways';
  bpmn?: string;
  waits?: 'no' | 'yes' | 'if-await' | 'at-join' | 'on-trigger';
  hint?: string;
  /** The kind's `config`, as a self-contained JSON Schema (no `$ref`). */
  configSchema: Record<string, Json>;
  /** What the kind's property panel may offer, from the closed lists publish enforces. */
  choices?: Record<string, Json>;
}

const read = (path: string): Record<string, Json> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, Json>;

let cached: PaletteEntry[] | undefined;

/** The palette, built once from the files and the closed lists. */
export function palette(): PaletteEntry[] {
  cached ??= build();
  return cached;
}

function build(): PaletteEntry[] {
  const definition = read(join(schemasDir, 'workflow-definition.schema.json'));
  const common = read(join(schemasDir, 'common.schema.json'));
  const source = read(join(workflowsDir, 'palette.json')) as { kinds: Record<string, Json>[] };
  const defs = (definition['$defs'] ?? {}) as Record<string, Json>;
  const commonDefs = (common['$defs'] ?? {}) as Record<string, Json>;

  const resolve = (node: Json, depth = 0): Json => {
    if (depth > 20) throw new Error('palette: $ref nesting too deep');
    if (Array.isArray(node)) return node.map((n) => resolve(n, depth + 1));
    if (node === null || typeof node !== 'object') return node;
    const ref = node['$ref'];
    if (typeof ref === 'string') {
      const target = lookup(ref);
      const { $ref: _ref, ...rest } = node;
      const annotated = ANNOTATED[ref];
      // Sibling keywords (a description beside the $ref) are kept over the target's.
      return {
        ...(resolve(target, depth + 1) as Record<string, Json>),
        ...(annotated ? { 'x-atlas-type': annotated } : {}),
        ...rest,
      };
    }
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, resolve(v, depth + 1)]));
  };
  const lookup = (ref: string): Json => {
    const local = /^#\/\$defs\/(.+)$/.exec(ref);
    if (local) return need(defs, local[1]!, ref);
    const shared = /common\.schema\.json#\/\$defs\/(.+)$/.exec(ref);
    if (shared) return need(commonDefs, shared[1]!, ref);
    throw new Error(`palette: cannot resolve ${ref}`);
  };

  return source.kinds.map((k) => {
    const ref = k['configSchemaRef'];
    const name = typeof ref === 'string' ? /#\/\$defs\/(.+)$/.exec(ref)?.[1] : undefined;
    if (!name) throw new Error(`palette: ${String(k['kind'])} names no config $def`);
    const { configSchemaRef: _r, ...meta } = k;
    const kind = String(k['kind']);
    const choices = choicesFor(kind);
    const configSchema = resolve(need(defs, name, ref as string)) as Record<string, Json>;
    for (const [path, key] of CHOICE_FIELDS[kind] ?? []) markChoices(configSchema, path, key);
    return {
      ...(meta as unknown as Omit<PaletteEntry, 'configSchema' | 'choices'>),
      configSchema,
      ...(choices ? { choices } : {}),
    };
  });
}

/** The `$def`s whose meaning a property panel needs once they are inlined. */
const ANNOTATED: Record<string, string> = {
  '#/$defs/Feel': 'feel',
  '#/$defs/Duration': 'duration',
};

/** Where each closed list applies: a property path in the kind's config, and its `choices` key. */
const CHOICE_FIELDS: Record<string, [string[], string][]> = {
  start: [[['trigger', 'event'], 'triggers']],
  'wait-event': [[['event'], 'events']],
  command: [[['request', 'event'], 'commands']],
};

function markChoices(schema: Record<string, Json>, path: string[], key: string): void {
  let node: Json = schema;
  for (const name of path) {
    const props: Json =
      node !== null && typeof node === 'object' && !Array.isArray(node)
        ? (node['properties'] ?? null)
        : null;
    node =
      props !== null && typeof props === 'object' && !Array.isArray(props)
        ? (props[name] ?? null)
        : null;
  }
  if (node === null || typeof node !== 'object' || Array.isArray(node))
    throw new Error(`palette: no field ${path.join('.')} to offer ${key} on`);
  node['x-choices'] = key;
}

function need(table: Record<string, Json>, name: string, ref: string): Json {
  const found = table[name];
  if (found === undefined) throw new Error(`palette: ${ref} names nothing`);
  return found;
}

function choicesFor(kind: string): Record<string, Json> | undefined {
  switch (kind) {
    case 'start':
      return { triggers: [...WORKFLOW_TRIGGERS] };
    case 'wait-event':
      return { events: [...WORKFLOW_EVENTS] };
    case 'command':
      return {
        commands: Object.entries(WORKFLOW_COMMANDS).map(([event, c]) => ({
          event,
          target: c.target,
          completes: [...c.completes],
          fails: [...c.fails],
          requires: {
            permission: c.requires.permission,
            resource: { ...c.requires.resource },
          } as Json,
        })),
      };
    default:
      return undefined;
  }
}
