// Operator-defined, type/category-specific metadata (EP-17.2, FR-MAM-2).
//
// The core `Asset` record holds what EVERY asset has. Everything that depends on what KIND of
// thing it is — a match's competition and kickoff, a documentary's rights window — is defined by
// operators as a FieldSchema and stored per asset in an `AssetExtended` document
// ([data-model.md §1.1](../../../docs/architecture/data-model.md)).
//
// Pure functions over plain data, like `lifecycle.ts`, so the rules that decide whether metadata
// is valid are testable without a database.

/**
 * The field types, and this list is CODE
 * ([configuration-and-reference-data.md §2.1](../../../docs/architecture/configuration-and-reference-data.md)).
 *
 * Tier 0: the validator and the form renderer each switch on it, so adding one is a pull request
 * with a schema-version bump — not an operator edit. Everything else about a field (its label, its
 * options, whether it is required) is operator-managed.
 */
export const FIELD_TYPES = [
  'string',
  'text',
  'number',
  'boolean',
  'date',
  'enum',
  'vocabulary',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export interface FieldDefinition {
  /** Key in the AssetExtended document. Stable — renaming one orphans existing values. */
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  /**
   * Allowed values for `type: 'enum'`.
   *
   * These live in the SCHEMA, so they are part of this field's definition and change with it.
   * A shared list that several fields draw from is a `vocabulary` instead — see {@link vocabulary}.
   */
  options?: readonly string[];
  /**
   * Which controlled vocabulary a `type: 'vocabulary'` field draws from.
   *
   * Deliberately NOT an enum of terms. Terms are operator-managed (Tier 1/2), and enumerating them
   * in a contract would make every admin edit a schema change, a regenerated type and a redeploy.
   * The field names the vocabulary; the terms are validated against a runtime snapshot.
   */
  vocabulary?: string;
  /**
   * Which field group this extended field belongs to, for authorization (#225).
   *
   * Optional, defaulting to `core`. A schema that names nothing keeps behaving exactly as it did,
   * which is what makes this shippable against deployments that already have schemas — operators
   * TIGHTEN by annotating, rather than having to annotate to keep working. Naming `rights` here
   * puts an operator-defined field behind the same grant as the core expiry, which is the point:
   * an operator can define a rights field without also having to give every editor rights.
   */
  fieldGroup?: string;
  maxLength?: number;
  helpText?: string;
}

/**
 * A set of fields, and where it applies.
 *
 * `mediaType` is required because that is the primary axis — a video and a photo genuinely need
 * different fields. `categoryPath` narrows further and is matched as a **prefix**, so one schema
 * covers a whole department or programme branch without being restated per leaf.
 */
export interface FieldSchema {
  id: string;
  channelId: string;
  mediaType: string;
  /** Materialized category path, e.g. `/sports/football/`. Absent ⇒ applies to the whole channel. */
  categoryPath?: string;
  fields: readonly FieldDefinition[];
  /**
   * Bumped on every write; a replacement names the version it read (EP-27.4) — compare-and-set,
   * so two administrators editing one schema cannot silently overwrite each other. A schema
   * stored before versions existed reads as version 1.
   */
  version?: number;
}

/** One reason a schema is refused, at the path an editor places it under (`fields[2].options`). */
export interface SchemaProblem {
  path: string;
  message: string;
}

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SLUG = /^[a-z][a-z0-9-]{0,63}$/;
// A ULID when Studio mints it; any bounded token, since schemas written before EP-27.4 carry ids
// of their operators' choosing.
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const FIELD_KEYS = new Set([
  'name',
  'label',
  'type',
  'required',
  'options',
  'vocabulary',
  'fieldGroup',
  'maxLength',
  'helpText',
]);
const SCHEMA_KEYS = new Set(['id', 'channelId', 'mediaType', 'categoryPath', 'fields', 'version']);

/**
 * Everything wrong with a schema as written (EP-27.4) — all of it, each at its path, so an editor
 * can mark every field at once rather than one refusal per save. The field TYPES are code (Tier 0,
 * {@link FIELD_TYPES}); everything else is the operator's, held to what the validator and the form
 * renderer can honour: a unique, stable `name`; options only on an `enum` (and at least one);
 * a vocabulary only on a `vocabulary` field; a length bound only on text; a known field group.
 */
export function fieldSchemaProblems(
  input: unknown,
  fieldGroups: readonly string[],
): SchemaProblem[] {
  const problems: SchemaProblem[] = [];
  const at = (path: string, message: string) => problems.push({ path, message });
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return [{ path: '', message: 'a field schema is an object' }];
  }
  const s = input as Record<string, unknown>;
  for (const key of Object.keys(s))
    if (!SCHEMA_KEYS.has(key)) at(key, 'is not part of a field schema');
  if (s['id'] !== undefined && (typeof s['id'] !== 'string' || !ID.test(s['id'])))
    at('id', 'must be letters, digits, - and _, at most 64');
  if (typeof s['mediaType'] !== 'string' || !SLUG.test(s['mediaType']))
    at('mediaType', 'must be a media type, e.g. video');
  const path = s['categoryPath'];
  if (path !== undefined && (typeof path !== 'string' || !/^\/([a-z0-9-]+\/)*$/.test(path)))
    at('categoryPath', 'must be a category path, e.g. /sports/football/');
  const fields = s['fields'];
  if (!Array.isArray(fields)) {
    at('fields', 'must be a list of fields');
    return problems;
  }
  if (fields.length > 200) at('fields', 'at most 200 fields');
  const seen = new Set<string>();
  fields.forEach((raw, i) => {
    const where = `fields[${i}]`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      at(where, 'must be a field definition');
      return;
    }
    const f = raw as Record<string, unknown>;
    for (const key of Object.keys(f))
      if (!FIELD_KEYS.has(key)) at(`${where}.${key}`, 'is not part of a field definition');
    const name = f['name'];
    if (typeof name !== 'string' || !NAME.test(name))
      at(`${where}.name`, 'must start with a letter: letters, digits and _ only, at most 64');
    else if (seen.has(name)) at(`${where}.name`, `"${name}" is defined twice`);
    else seen.add(name);
    const label = f['label'];
    if (typeof label !== 'string' || label.trim() === '' || label.length > 120)
      at(`${where}.label`, 'must be a label of at most 120');
    const type = f['type'];
    if (typeof type !== 'string' || !(FIELD_TYPES as readonly string[]).includes(type)) {
      at(`${where}.type`, `must be one of ${FIELD_TYPES.join(', ')}`);
      return;
    }
    if (f['required'] !== undefined && typeof f['required'] !== 'boolean')
      at(`${where}.required`, 'must be true or false');
    const options = f['options'];
    if (type === 'enum') {
      if (
        !Array.isArray(options) ||
        options.length === 0 ||
        options.some((o) => typeof o !== 'string' || o.trim() === '')
      )
        at(`${where}.options`, 'an enum field lists at least one option');
      else if (new Set(options).size !== options.length)
        at(`${where}.options`, 'an option is listed twice');
    } else if (options !== undefined) at(`${where}.options`, 'only an enum field has options');
    const vocabulary = f['vocabulary'];
    if (type === 'vocabulary') {
      if (typeof vocabulary !== 'string' || !SLUG.test(vocabulary))
        at(`${where}.vocabulary`, 'a vocabulary field names its vocabulary');
    } else if (vocabulary !== undefined)
      at(`${where}.vocabulary`, 'only a vocabulary field names a vocabulary');
    const group = f['fieldGroup'];
    if (group !== undefined && (typeof group !== 'string' || !fieldGroups.includes(group)))
      at(`${where}.fieldGroup`, `must be one of ${fieldGroups.join(', ')}`);
    const max = f['maxLength'];
    if (max !== undefined) {
      if (type !== 'string' && type !== 'text')
        at(`${where}.maxLength`, 'only a string or text field has a length bound');
      else if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > 100_000)
        at(`${where}.maxLength`, 'must be a whole number from 1 to 100000');
    }
    const help = f['helpText'];
    if (help !== undefined && (typeof help !== 'string' || help.length > 500))
      at(`${where}.helpText`, 'must be text of at most 500');
  });
  return problems;
}

/** What an asset is, for the purpose of deciding which schemas apply. */
export interface SchemaSubject {
  channelId: string;
  mediaType: string;
  categoryPath?: string;
}

/**
 * Normalize a path so prefix matching cannot cross a segment boundary.
 *
 * The same hazard as policy scoping: without this, a schema on `/sports/foot` would match
 * `/sports/football/` and silently apply a sibling branch's fields.
 */
function normalizePath(path: string): string {
  if (path === '') return '/';
  return path.endsWith('/') ? path : `${path}/`;
}

function covers(schemaPath: string | undefined, subjectPath: string | undefined): boolean {
  if (schemaPath === undefined) return true; // channel-wide
  if (subjectPath === undefined) return false; // a category-scoped schema needs a category
  return normalizePath(subjectPath).startsWith(normalizePath(schemaPath));
}

/**
 * The fields that apply to one asset, most general first.
 *
 * Schemas MERGE rather than override wholesale: a channel-wide video schema plus a
 * `/sports/football/` one gives an asset both sets. A more specific schema redefining a field name
 * wins, which is what lets a branch tighten an inherited field (make it required, add options)
 * without restating everything above it.
 */
export function resolveFields(
  schemas: readonly FieldSchema[],
  subject: SchemaSubject,
): FieldDefinition[] {
  const applicable = schemas
    .filter(
      (s) =>
        s.channelId === subject.channelId &&
        s.mediaType === subject.mediaType &&
        covers(s.categoryPath, subject.categoryPath),
    )
    // Shortest path first, so the most specific schema is applied last and therefore wins.
    .sort((a, b) => (a.categoryPath ?? '').length - (b.categoryPath ?? '').length);

  const byName = new Map<string, FieldDefinition>();
  for (const schema of applicable) {
    for (const field of schema.fields) byName.set(field.name, field);
  }
  return [...byName.values()];
}

/** Names of the fields an asset must carry before it can advance (FR-MAM-5). */
export function requiredFieldNames(fields: readonly FieldDefinition[]): string[] {
  return fields.filter((f) => f.required === true).map((f) => f.name);
}

export interface FieldError {
  field: string;
  message: string;
}

export interface ValidationOptions {
  /**
   * Terms per controlled vocabulary, as a snapshot.
   *
   * A `vocabulary` field whose vocabulary is absent here is an ERROR, not a pass. Accepting a term
   * nobody could check defeats the point of the list being controlled, and the value would sit in
   * the document looking validated.
   */
  vocabularies?: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Validate a PARTIAL update against the resolved fields.
 *
 * Partial on purpose. Validating the whole stored document on every write would make an asset
 * unsavable the moment an operator removes a field it still has a value for — editing an unrelated
 * field would fail on data the user cannot even see any more. So only what is being written is
 * checked, and {@link orphanedFields} reports the rest rather than deleting it.
 *
 * Required fields are NOT enforced here for the same reason: a patch that sets one field is not
 * claiming the asset is complete. Completeness is the lifecycle's question, asked at `markReady`.
 */
export function validateExtended(
  fields: readonly FieldDefinition[],
  values: Readonly<Record<string, unknown>>,
  options: ValidationOptions = {},
): FieldError[] {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const errors: FieldError[] = [];

  for (const [name, value] of Object.entries(values)) {
    const field = byName.get(name);
    if (!field) {
      // Rejected rather than stored. A typo that silently becomes data is a value nothing renders,
      // nothing searches and nobody discovers until someone asks where their input went.
      errors.push({ field: name, message: `no field "${name}" in the schema for this asset` });
      continue;
    }

    // An explicit null clears the field. Distinct from omitting it, which leaves it untouched.
    if (value === null) continue;

    const error = checkValue(field, value, options);
    if (error !== undefined) errors.push({ field: name, message: error });
  }

  return errors;
}

function checkValue(
  field: FieldDefinition,
  value: unknown,
  options: ValidationOptions,
): string | undefined {
  switch (field.type) {
    case 'string':
    case 'text': {
      if (typeof value !== 'string') return `must be a string`;
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        return `must be at most ${field.maxLength} characters`;
      }
      return undefined;
    }

    case 'number': {
      // `Number.isFinite` and not `typeof === 'number'`: NaN and Infinity are numbers to the
      // language, survive a round trip through a JS caller, and serialize to `null` in JSON — so
      // they would be stored as a value that reads back as something else entirely.
      if (typeof value !== 'number' || !Number.isFinite(value)) return `must be a finite number`;
      return undefined;
    }

    case 'boolean':
      return typeof value === 'boolean' ? undefined : `must be true or false`;

    case 'date': {
      if (typeof value !== 'string') return `must be an ISO-8601 date string`;
      // Number.isNaN over the parse, because `new Date('nonsense')` yields an Invalid Date rather
      // than throwing — it would store happily and fail much later, wherever it is formatted.
      if (Number.isNaN(Date.parse(value))) return `must be an ISO-8601 date string`;
      return undefined;
    }

    case 'enum': {
      if (typeof value !== 'string') return `must be one of the defined options`;
      const options_ = field.options ?? [];
      if (!options_.includes(value)) {
        return `must be one of: ${options_.join(', ')}`;
      }
      return undefined;
    }

    case 'vocabulary': {
      if (typeof value !== 'string') return `must be a term from "${field.vocabulary}"`;
      const name = field.vocabulary;
      if (name === undefined) return `field is typed "vocabulary" but names none`;
      const terms = options.vocabularies?.get(name);
      if (terms === undefined)
        return `vocabulary "${name}" is not loaded, so this cannot be checked`;
      if (!terms.has(value)) return `"${value}" is not a term in "${name}"`;
      return undefined;
    }
  }
}

/**
 * Stored values with no field left to define them.
 *
 * These are not deleted. An operator removing a field from a schema is usually reorganising, not
 * asking for every asset's data to be destroyed — and there is no undo for that. Surfacing them
 * lets the UI show what became orphaned and lets an operator decide.
 */
export function orphanedFields(
  fields: readonly FieldDefinition[],
  stored: Readonly<Record<string, unknown>>,
): string[] {
  const known = new Set(fields.map((f) => f.name));
  return Object.keys(stored).filter((name) => !known.has(name));
}
