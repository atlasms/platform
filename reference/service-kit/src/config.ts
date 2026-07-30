import { ValidationError } from './errors.ts';

// Validate + coerce environment config at boot. Fail fast with all problems at once.
export interface FieldSpec {
  env: string;
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  default?: string | number | boolean;
  enum?: string[];
}
export type ConfigSpec = Record<string, FieldSpec>;
export type Config<S extends ConfigSpec> = { [K in keyof S]: S[K]['type'] extends 'number' ? number : S[K]['type'] extends 'boolean' ? boolean : string };

export function loadConfig<S extends ConfigSpec>(spec: S, env: Record<string, string | undefined> = process.env): Config<S> {
  const out: any = {};
  const problems: string[] = [];

  for (const [key, f] of Object.entries(spec)) {
    let raw = env[f.env];
    if (raw === undefined || raw === '') {
      if (f.default !== undefined) { out[key] = f.default; continue; }
      if (f.required) { problems.push(`${f.env} is required`); continue; }
      out[key] = undefined;
      continue;
    }
    if (f.enum && !f.enum.includes(raw)) { problems.push(`${f.env} must be one of ${f.enum.join(', ')}`); continue; }
    if (f.type === 'number') {
      const n = Number(raw);
      if (Number.isNaN(n)) { problems.push(`${f.env} must be a number`); continue; }
      out[key] = n;
    } else if (f.type === 'boolean') {
      if (!/^(true|false|1|0)$/i.test(raw)) { problems.push(`${f.env} must be a boolean`); continue; }
      out[key] = /^(true|1)$/i.test(raw);
    } else {
      out[key] = raw;
    }
  }

  if (problems.length) throw new ValidationError('Invalid configuration', problems);
  return out as Config<S>;
}
