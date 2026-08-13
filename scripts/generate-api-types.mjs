// Generates Studio's API types from the OpenAPI contracts (EP-11.5).
//
//   node scripts/generate-api-types.mjs           # write
//   node scripts/generate-api-types.mjs --check   # fail if the checked-in output is stale
//
// WHY GENERATE RATHER THAN HAND-WRITE. `docs/` is the source of truth, and until now the OpenAPI
// stubs were documentation ONLY — referenced in comments, parsed by nothing, checked against
// nothing. So the contract and the code could disagree indefinitely, and did: iam.yaml called the
// permission version `permissionVersion` while the requirement (FR-IAM-14), the JWT claim, the
// internal header and every line of code called it `permVersion`. Nobody noticed because nothing
// ever compared them.
//
// WHY NOT AN OPENAPI GENERATOR OFF THE SHELF. Studio already carries Angular; the platform installs
// air-gapped (FR-PLat-7) and ADR-0004 records what one 27 MB dependency is worth against a 117 MB
// bundle. This reads a deliberately narrow subset of JSON Schema and THROWS on anything it does not
// understand — a generator that silently emits `unknown` for a construct it missed would put the
// drift back, one field at a time.
//
// The output is checked in so the diff is reviewable: a type change is an API change, and it should
// appear in a pull request rather than materialise during a build.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import * as prettier from 'prettier';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = join(ROOT, 'apps/studio/src/app/core/generated');

/** Only what Studio talks to. The gateway fronts these; the rest of the estate is not its business. */
const SPECS = [
  { file: 'iam.yaml', out: 'iam.types.ts', title: 'IAM' },
  { file: 'mam.yaml', out: 'mam.types.ts', title: 'MAM' },
];

const check = process.argv.includes('--check');
let stale = 0;

for (const spec of SPECS) {
  const path = join(ROOT, 'docs/architecture/openapi', spec.file);
  const doc = parse(readFileSync(path, 'utf8'));
  const schemas = doc?.components?.schemas ?? {};

  const body = Object.entries(schemas)
    .map(([name, schema]) => renderNamed(name, schema, spec.file))
    .join('\n\n');

  const target = join(OUT_DIR, spec.out);
  // Formatted with the repo's own prettier config before it is written OR compared.
  //
  // Without this, `api:check` and `format:check` contradict each other: prettier rewrites the
  // checked-in file, and the next `api:check` sees it differ from the generator's raw output. Two
  // required checks that cannot both pass is a build nobody can fix without deleting one of them.
  const content = await prettier.format(`${header(spec)}\n${body}\n`, {
    ...(await prettier.resolveConfig(target)),
    filepath: target,
  });

  if (check) {
    let existing = '';
    try {
      existing = readFileSync(target, 'utf8');
    } catch {
      existing = '';
    }
    if (existing !== content) {
      console.error(`STALE: ${spec.out} does not match ${spec.file}`);
      stale += 1;
    }
  } else {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    console.log(`wrote ${spec.out} (${Object.keys(schemas).length} schemas)`);
  }
}

if (check) {
  if (stale > 0) {
    console.error(`\n${stale} generated file(s) are out of date.`);
    console.error('Run: npm run api:types');
    process.exit(1);
  }
  console.log('generated API types are up to date');
}

function header(spec) {
  return `// GENERATED FROM docs/architecture/openapi/${spec.file} — DO NOT EDIT.
//
// Regenerate with \`npm run api:types\`. \`npm run api:check\` fails the build when this file and the
// contract disagree, which is the whole point: ${spec.title}'s API shape is decided in the contract
// and this file is a projection of it, not a second opinion.
`;
}

/** A named top-level schema. A plain alias when it is not an object, an interface when it is. */
function renderNamed(name, schema, file) {
  const doc = schema.description ? `/** ${schema.description} */\n` : '';

  if (schema.type === 'object' && schema.properties) {
    const required = new Set(schema.required ?? []);
    const fields = Object.entries(schema.properties)
      .map(([prop, sub]) => {
        const optional = required.has(prop) ? '' : '?';
        // A `nullable` field is `T | null` AND still required when the contract says so — an
        // optional key and a null value are different statements, and conflating them is how a
        // client starts treating "explicitly cleared" as "not sent".
        const type = tsType(sub, `${file}#${name}.${prop}`);
        const comment = sub.description ? `  /** ${sub.description} */\n` : '';
        return `${comment}  ${prop}${optional}: ${type};`;
      })
      .join('\n');
    return `${doc}export interface ${name} {\n${fields}\n}`;
  }

  return `${doc}export type ${name} = ${tsType(schema, `${file}#${name}`)};`;
}

function tsType(schema, where) {
  if (!schema || typeof schema !== 'object') fail(where, 'not a schema object');

  if (schema.$ref) {
    const match = /^#\/components\/schemas\/(.+)$/.exec(schema.$ref);
    if (!match) fail(where, `only local component refs are supported, got ${schema.$ref}`);
    return match[1];
  }

  const nullable = schema.nullable === true ? ' | null' : '';

  switch (schema.type) {
    case 'string':
      // An enum becomes a union, which is the entire reason to generate rather than hand-write:
      // adding a status to the contract breaks every switch that does not handle it.
      return (
        (Array.isArray(schema.enum)
          ? schema.enum.map((v) => JSON.stringify(v)).join(' | ')
          : 'string') + nullable
      );
    case 'integer':
    case 'number':
      return 'number' + nullable;
    case 'boolean':
      return 'boolean' + nullable;
    case 'array':
      if (!schema.items) fail(where, 'array without items');
      return `${tsType(schema.items, `${where}[]`)}[]` + nullable;
    case 'object': {
      if (schema.properties) {
        const required = new Set(schema.required ?? []);
        const fields = Object.entries(schema.properties)
          .map(([p, s]) => `${p}${required.has(p) ? '' : '?'}: ${tsType(s, `${where}.${p}`)}`)
          .join('; ');
        return `{ ${fields} }` + nullable;
      }
      if (schema.additionalProperties === true) return 'Record<string, unknown>' + nullable;
      if (schema.additionalProperties) {
        return `Record<string, ${tsType(schema.additionalProperties, `${where}{}`)}>` + nullable;
      }
      return 'Record<string, never>' + nullable;
    }
    default:
      // Loudly. A generator that quietly emits `unknown` for a construct it does not handle
      // reintroduces exactly the drift this script exists to remove.
      fail(where, `unsupported schema: ${JSON.stringify(schema).slice(0, 120)}`);
  }
}

function fail(where, message) {
  throw new Error(`generate-api-types: ${where}: ${message}`);
}
