// The field-schema editor's model (EP-27.4): a schema as the form holds it, and back. Pure, so the
// rules — what a row of each type keeps, what a blank means, where MAM's refusals go — are tested
// without a DOM. MAM judges the schema (its 422 names every problem by path); the form only shapes
// what it sends.
import type { FieldDefinition, FieldSchema } from '../core/generated/mam.types.ts';

export type FieldType = FieldDefinition['type'];

/** Tier 0 — MAM switches on these (mam.yaml `FieldDefinition.type`). */
export const FIELD_TYPES: readonly FieldType[] = [
  'string',
  'text',
  'number',
  'boolean',
  'date',
  'enum',
  'vocabulary',
];

/** The asset field groups a field may belong to (#225) — MAM's `ASSET_FIELD_GROUPS`. */
export const FIELD_GROUPS = ['core', 'taxonomy', 'cast', 'rights', 'shotlist', 'files', 'web'];

/** One field row, every value as the form's controls hold it. */
export interface FieldRow {
  name: string;
  label: string;
  type: FieldType;
  required: boolean;
  /** An enum's options, one per line. */
  options: string;
  vocabulary: string;
  /** Blank is `core`. */
  fieldGroup: string;
  maxLength: string;
  helpText: string;
  /** The name it had when read — a rename orphans the asset values stored under the old one. */
  readName?: string;
}

export interface SchemaDraft {
  mediaType: string;
  /** Blank: the whole channel. */
  categoryPath: string;
  fields: FieldRow[];
}

export function blankRow(): FieldRow {
  return {
    name: '',
    label: '',
    type: 'string',
    required: false,
    options: '',
    vocabulary: '',
    fieldGroup: '',
    maxLength: '',
    helpText: '',
  };
}

export function draftOf(schema: FieldSchema): SchemaDraft {
  return {
    mediaType: schema.mediaType,
    categoryPath: schema.categoryPath ?? '',
    fields: schema.fields.map((f) => ({
      name: f.name,
      label: f.label,
      type: f.type,
      required: f.required === true,
      options: (f.options ?? []).join('\n'),
      vocabulary: f.vocabulary ?? '',
      fieldGroup: f.fieldGroup ?? '',
      maxLength: f.maxLength === undefined ? '' : String(f.maxLength),
      helpText: f.helpText ?? '',
      readName: f.name,
    })),
  };
}

/**
 * The schema the form sends. Only what a row's TYPE uses is sent — options on an enum, a
 * vocabulary on a vocabulary field, a length bound on text — so switching a row's type does not
 * carry a stale value MAM would refuse. A blank optional value is absent, not `''`.
 */
export function inputOf(draft: SchemaDraft, id: string): FieldSchema {
  const path = draft.categoryPath.trim();
  return {
    id,
    mediaType: draft.mediaType.trim(),
    ...(path ? { categoryPath: path } : {}),
    fields: draft.fields.map((row) => {
      const max = row.maxLength.trim();
      const field: FieldDefinition = {
        name: row.name.trim(),
        label: row.label.trim(),
        type: row.type,
        ...(row.required ? { required: true } : {}),
        ...(row.fieldGroup ? { fieldGroup: row.fieldGroup } : {}),
        ...(row.helpText.trim() ? { helpText: row.helpText.trim() } : {}),
      };
      if (row.type === 'enum')
        field.options = row.options
          .split('\n')
          .map((o) => o.trim())
          .filter((o) => o !== '');
      if (row.type === 'vocabulary' && row.vocabulary.trim())
        field.vocabulary = row.vocabulary.trim();
      if ((row.type === 'string' || row.type === 'text') && max !== '')
        field.maxLength = Number(max);
      return field;
    }),
  };
}

/** The rows whose name changed since they were read — each would orphan stored values. */
export function renamed(draft: SchemaDraft): FieldRow[] {
  return draft.fields.filter((f) => f.readName !== undefined && f.readName !== f.name.trim());
}

/** MAM's 422 `details.problems`, by path — what each control shows under itself. */
export function problemsByPath(details: unknown): Record<string, string[]> {
  const list = (details as { problems?: unknown } | null)?.problems;
  const out: Record<string, string[]> = {};
  if (!Array.isArray(list)) return out;
  for (const p of list) {
    const path = (p as { path?: unknown }).path;
    const message = (p as { message?: unknown }).message;
    if (typeof path === 'string' && typeof message === 'string') (out[path] ??= []).push(message);
  }
  return out;
}

/** A row moved one place up or down — new array, the rows themselves kept. */
export function moved(rows: readonly FieldRow[], index: number, by: -1 | 1): FieldRow[] {
  const to = index + by;
  if (to < 0 || to >= rows.length) return [...rows];
  const next = [...rows];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}
