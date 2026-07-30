import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { schemasDir, eventsDir } from './paths.ts';

const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

const ajv = new (Ajv2020 as any)({ strict: false, allErrors: true });
(addFormats as any)(ajv);

// Load shared + envelope, then every event payload schema, keyed by event type name.
ajv.addSchema(read(join(schemasDir, 'common.schema.json')));
const envelopeSchema = read(join(schemasDir, 'envelope.schema.json'));
export const validateEnvelopeShape = ajv.compile(envelopeSchema);

const SUFFIX = '.payload.schema.json';
export const EVENT_TYPES: string[] = [];
const payloadValidators = new Map<string, (p: unknown) => boolean>();

for (const file of readdirSync(eventsDir).sort()) {
  if (!file.endsWith(SUFFIX)) continue;
  const type = file.slice(0, -SUFFIX.length); // e.g. "asset.approved"
  const schema = read(join(eventsDir, file));
  EVENT_TYPES.push(type);
  payloadValidators.set(type, ajv.compile(schema));
}

export interface CheckResult { valid: boolean; errors: { path: string; message: string }[] }

function toErrors(fn: any): { path: string; message: string }[] {
  return (fn.errors ?? []).map((e: any) => ({ path: e.instancePath || '/', message: e.message }));
}

export function validatePayload(type: string, payload: unknown): CheckResult {
  const fn = payloadValidators.get(type);
  if (!fn) return { valid: false, errors: [{ path: '/type', message: `unknown event type "${type}"` }] };
  return { valid: fn(payload) as boolean, errors: toErrors(fn) };
}

export function envelopeShapeErrors(msg: unknown): CheckResult {
  return { valid: validateEnvelopeShape(msg) as boolean, errors: toErrors(validateEnvelopeShape) };
}

export const isEventType = (t: string): boolean => payloadValidators.has(t);
