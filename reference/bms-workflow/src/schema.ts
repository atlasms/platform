import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { schemasDir } from './paths.ts';
import type { WorkflowDefinition } from './types.ts';

const common = JSON.parse(readFileSync(join(schemasDir, 'common.schema.json'), 'utf8'));
const wfSchema = JSON.parse(readFileSync(join(schemasDir, 'workflow-definition.schema.json'), 'utf8'));

const ajv = new (Ajv2020 as any)({ strict: false, allErrors: true });
(addFormats as any)(ajv);
ajv.addSchema(common);
const validateFn = ajv.compile(wfSchema);

export interface SchemaResult { valid: boolean; errors: { path: string; message: string }[] }

/** Tier-1: structural validation against workflow-definition.schema.json. */
export function validateSchema(def: unknown): SchemaResult {
  const valid = validateFn(def) as boolean;
  const errors = (validateFn.errors ?? []).map((e: any) => ({
    path: e.instancePath || '/',
    message: `${e.message}${e.params ? ' ' + JSON.stringify(e.params) : ''}`,
  }));
  return { valid, errors };
}

export const rawSchema = wfSchema as { $defs: Record<string, unknown> };
export type { WorkflowDefinition };
