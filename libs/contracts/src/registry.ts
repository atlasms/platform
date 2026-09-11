import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
// Types come from the SAME module as the value. A bare 'ajv' specifier can resolve to a
// hoisted ajv 6 (pulled in transitively by tooling), whose `export =` namespace typings are
// incompatible with ajv 8's `export default` class — which is what the original `as any`
// casts were really papering over.
import type { AnySchema, ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { schemasDir, eventsDir } from './paths.ts';

// ajv 8 and ajv-formats are CJS (`module.exports = X` with a `.default` alias). Node's ESM
// loader resolves the default import to the class/function at runtime, but TypeScript under
// NodeNext + verbatimModuleSyntax types it as the module namespace object. These two casts
// reconcile that — deliberately declaring the *exact* surface used rather than `any`, so
// consumers of this library still get full type information.
interface AjvInstance {
  addSchema(schema: AnySchema): unknown;
  compile(schema: AnySchema): ValidateFunction;
}
type AjvConstructor = new (opts?: { strict?: boolean; allErrors?: boolean }) => AjvInstance;

const Ajv = Ajv2020 as unknown as AjvConstructor;
const applyFormats = addFormats as unknown as (ajv: AjvInstance) => void;

const read = (p: string): AnySchema => JSON.parse(readFileSync(p, 'utf8')) as AnySchema;

const ajv = new Ajv({ strict: false, allErrors: true });
applyFormats(ajv);

// Load shared + envelope, then every event payload schema, keyed by event type name.
ajv.addSchema(read(join(schemasDir, 'common.schema.json')));
const envelopeSchema = read(join(schemasDir, 'envelope.schema.json'));
export const validateEnvelopeShape = ajv.compile(envelopeSchema);

// The domain contracts too — file, policy-rule, setting-descriptor, vocabulary-term, workflow-
// definition. They are stored/served shapes rather than messages, so nothing validates against
// them at runtime yet, which meant nothing COMPILED them either: a `$ref` to a shared `$def` that
// did not exist would have sat there until the first consumer arrived. Compiling proves every ref
// resolves and every keyword is one ajv understands. The validators are kept so a future
// consumer has them, keyed by the file's stem.
export const DOMAIN_SCHEMAS: string[] = [];
const domainValidators = new Map<string, ValidateFunction>();
for (const file of readdirSync(schemasDir).sort()) {
  if (!file.endsWith('.schema.json')) continue;
  if (file === 'common.schema.json' || file === 'envelope.schema.json') continue;
  const name = file.slice(0, -'.schema.json'.length); // "setting-descriptor"
  DOMAIN_SCHEMAS.push(name);
  domainValidators.set(name, ajv.compile(read(join(schemasDir, file))));
}

/** Validate against a domain contract (not an event) — `validateDomain('setting-descriptor', d)`. */
export function validateDomain(name: string, value: unknown): CheckResult {
  const fn = domainValidators.get(name);
  if (!fn)
    return { valid: false, errors: [{ path: '/', message: `unknown domain schema "${name}"` }] };
  return { valid: fn(value), errors: toErrors(fn) };
}

const SUFFIX = '.payload.schema.json';
export const EVENT_TYPES: string[] = [];
const payloadValidators = new Map<string, ValidateFunction>();

for (const file of readdirSync(eventsDir).sort()) {
  if (!file.endsWith(SUFFIX)) continue;
  const type = file.slice(0, -SUFFIX.length); // e.g. "asset.approved"
  const schema = read(join(eventsDir, file));
  EVENT_TYPES.push(type);
  payloadValidators.set(type, ajv.compile(schema));
}

export interface CheckResult {
  valid: boolean;
  errors: { path: string; message: string }[];
}

function toErrors(fn: ValidateFunction): { path: string; message: string }[] {
  const errors: ErrorObject[] = fn.errors ?? [];
  return errors.map((e) => ({ path: e.instancePath || '/', message: e.message ?? 'invalid' }));
}

export function validatePayload(type: string, payload: unknown): CheckResult {
  const fn = payloadValidators.get(type);
  if (!fn)
    return { valid: false, errors: [{ path: '/type', message: `unknown event type "${type}"` }] };
  return { valid: fn(payload), errors: toErrors(fn) };
}

export function envelopeShapeErrors(msg: unknown): CheckResult {
  return { valid: validateEnvelopeShape(msg), errors: toErrors(validateEnvelopeShape) };
}

export const isEventType = (t: string): boolean => payloadValidators.has(t);
