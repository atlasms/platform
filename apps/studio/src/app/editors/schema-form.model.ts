// Property forms from JSON Schema (EP-23.5; DSL doc §12.3): what a field of a step kind's config
// schema is, read from the schema BMS's palette serves — self-contained, and annotated where
// inlining erased meaning (`x-atlas-type`, `x-choices`; @atlas/contracts `palette()`). A new step
// kind is a new schema; no form code changes. Pure, so the decisions are tested without a DOM.

export type Schema = Record<string, unknown>;

/** How a field is edited. */
export type FieldKind =
  | 'object' // named properties, each its own field
  | 'map' // free keys to string values — a data mapping (target path → FEEL)
  | 'enum' // one of the schema's own values
  | 'choice' // one of a closed list the palette carries (`x-choices`)
  | 'feel' // a FEEL expression
  | 'duration' // an ISO 8601 duration
  | 'text'
  | 'boolean'
  | 'number'
  | 'version' // a sub-flow's version: a number or `latest`
  | 'json'; // anything else — edited as JSON, so nothing the schema allows is out of reach

const isSchema = (v: unknown): v is Schema =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function fieldKind(schema: Schema): FieldKind {
  if (typeof schema['x-choices'] === 'string') return 'choice';
  if (Array.isArray(schema['enum'])) return 'enum';
  if (schema['x-atlas-type'] === 'feel') return 'feel';
  if (schema['x-atlas-type'] === 'duration') return 'duration';
  const oneOf = schema['oneOf'];
  if (
    Array.isArray(oneOf) &&
    oneOf.some((s) => isSchema(s) && s['type'] === 'integer') &&
    oneOf.some((s) => isSchema(s) && s['const'] === 'latest')
  )
    return 'version';
  switch (schema['type']) {
    case 'string':
      return 'text';
    case 'boolean':
      return 'boolean';
    case 'integer':
    case 'number':
      return 'number';
    case 'object': {
      if (isSchema(schema['properties']) && Object.keys(schema['properties']).length > 0)
        return 'object';
      const values = schema['additionalProperties'];
      if (isSchema(values) && values['type'] === 'string') return 'map';
      return 'json';
    }
    default:
      return 'json';
  }
}

export interface Property {
  key: string;
  schema: Schema;
  required: boolean;
}

/** An object schema's properties, in the schema's order, required ones marked. */
export function propertiesOf(schema: Schema): Property[] {
  const props = isSchema(schema['properties']) ? schema['properties'] : {};
  const required = Array.isArray(schema['required']) ? (schema['required'] as unknown[]) : [];
  return Object.entries(props)
    .filter((entry): entry is [string, Schema] => isSchema(entry[1]))
    .map(([key, s]) => ({ key, schema: s, required: required.includes(key) }));
}

/**
 * The options a `choice` field offers: the palette's list (a command is offered by its event),
 * and the current value when the list no longer has it — a draft may hold one (an import, a
 * retired command), and a select that silently showed something else would misstate the draft.
 */
export function optionsOf(
  schema: Schema,
  choices: Record<string, unknown> | undefined,
  current: unknown,
): string[] {
  const listed =
    fieldKind(schema) === 'enum'
      ? (schema['enum'] as unknown[])
      : ((choices?.[String(schema['x-choices'])] as unknown[] | undefined) ?? []);
  const values = listed
    .map((v) => (isSchema(v) && typeof v['event'] === 'string' ? v['event'] : v))
    .filter((v): v is string => typeof v === 'string');
  return typeof current === 'string' && current !== '' && !values.includes(current)
    ? [...values, current]
    : values;
}

/**
 * An object with one property set — or REMOVED when the value is empty (`undefined` or `''`): an
 * optional field left blank is absent from the config, as the schema means it, not an empty
 * string the validator would then judge. Never mutates.
 */
export function withProperty(
  object: unknown,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const base = isSchema(object) ? object : {};
  const { [key]: _old, ...rest } = base;
  return value === undefined || value === '' ? rest : { ...rest, [key]: value };
}

/** A sub-flow version as typed: a positive integer, `latest`, or (blank) absent. */
export function parseVersion(text: string): number | 'latest' | undefined | null {
  const t = text.trim();
  if (t === '') return undefined;
  if (t === 'latest') return 'latest';
  return /^[1-9]\d*$/.test(t) ? Number(t) : null; // null: not a version — the form says so
}

/** Rows of a data mapping, in insertion order. */
export function entriesOf(map: unknown): [string, string][] {
  if (!isSchema(map)) return [];
  return Object.entries(map).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]);
}

/** A mapping with one row renamed, keeping its place — a rename onto another key replaces it. */
export function renameKey(map: unknown, from: string, to: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(isSchema(map) ? map : {})) {
    if (k === to && k !== from) continue;
    out[k === from ? to : k] = v;
  }
  return out;
}

/** A label from a key: `reviewPointId` → `Review point id`. */
export function labelOf(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}
