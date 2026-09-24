// Generates Studio's API types from the OpenAPI contracts (EP-11.5), the OPERATIONS table each
// Studio client builds its requests from (EP-02.4), and every event payload type from the JSON
// Schemas in docs/architecture/schemas (EP-02.3).
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

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import * as prettier from 'prettier';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = join(ROOT, 'apps/studio/src/app/core/generated');

/** Only what Studio talks to. The gateway fronts these; the rest of the estate is not its business.
 *
 * A service Studio has a client for belongs here even before the service exists. `rim.types.ts` was
 * hand-written with a GENERATED banner on it and left out of this list, so nothing compared it to
 * the contract for a month — and it had already drifted: three fields the contract leaves optional
 * were typed required, which is how `formatSize(job.sizeBytes)` came to render "NaN GB" against a
 * response the contract explicitly allows. The banner is a promise; this list is what keeps it. */
const SPECS = [
  { file: 'iam.yaml', out: 'iam.types.ts', ops: 'iam.operations.ts', title: 'IAM' },
  { file: 'mam.yaml', out: 'mam.types.ts', ops: 'mam.operations.ts', title: 'MAM' },
  { file: 'rim.yaml', out: 'rim.types.ts', ops: 'rim.operations.ts', title: 'RIM' },
  // The asset editor's Files tab reads an asset's transcode jobs (EP-16).
  { file: 'mts.yaml', out: 'mts.types.ts', ops: 'mts.operations.ts', title: 'MTS' },
  {
    file: 'scheduling.yaml',
    out: 'scheduling.types.ts',
    ops: 'scheduling.operations.ts',
    title: 'Scheduling',
  },
];

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/**
 * The event payloads (EP-02.3): one interface per `events/<type>.payload.schema.json`, the shared
 * `$defs` from common.schema.json as named types, and an `EventPayloads` map from event type to
 * payload. `@atlas/contracts` already loads these same files at runtime to VALIDATE a payload; this
 * is the compile-time half, so a consumer writes `EventPayloads['permissions.changed']` instead of
 * `msg.body as { userId?: string }` — a cast that hides which level it is reading at.
 *
 * Generating them is also what surfaced two things a hand-written cast never would: two sibling
 * IAM events spelling the same field `permVersion` and `permissionVersion` (now one), and the
 * websocket bridge reading `userId` off the ENVELOPE rather than off `envelope.payload`, where
 * every producer on this platform puts it.
 */
const EVENTS = {
  dir: 'docs/architecture/schemas',
  out: 'libs/contracts/src/generated/events.ts',
};

const check = process.argv.includes('--check');
let stale = 0;

/**
 * Every contract, not only the ones in SPECS: a key with NO value.
 *
 * In a YAML flow mapping an unquoted comma ENDS the value, so
 * `{ type: string, description: Why it failed, or why not. }` is a description of "Why it failed"
 * plus a key named "or why not." whose value is null. Nothing breaks: JSON Schema ignores a keyword
 * it does not know, and OpenAPI tooling mostly does too. So the contract a reader sees, and every
 * doc comment generated from it, silently says half of what was written. Seventeen of these sat in
 * four contracts until `mts.yaml` joined SPECS and one surfaced as a truncated comment in Studio.
 * No OpenAPI field here is legitimately null, so a null is always this.
 */
function valuelessKeys(node, path = [], found = []) {
  if (Array.isArray(node)) node.forEach((item, i) => valuelessKeys(item, [...path, i], found));
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (value === null) found.push([...path, key].join('.'));
      else valuelessKeys(value, [...path, key], found);
    }
  }
  return found;
}

let malformed = 0;
const contracts = join(ROOT, 'docs/architecture/openapi');
for (const file of readdirSync(contracts)
  .filter((f) => f.endsWith('.yaml'))
  .sort()) {
  for (const where of valuelessKeys(parse(readFileSync(join(contracts, file), 'utf8')))) {
    console.error(
      `MALFORMED: ${file}: ${where} has no value — an unquoted comma inside a { … } flow ` +
        'mapping ended the value before it; quote the text.',
    );
    malformed += 1;
  }
}

/** Format with the repo's prettier config, then write or compare. See the note in the loop below. */
async function emit(target, raw, { name, source, summary }) {
  const content = await prettier.format(raw, {
    ...(await prettier.resolveConfig(target)),
    filepath: target,
  });
  if (check) {
    let existing;
    try {
      existing = readFileSync(target, 'utf8');
    } catch {
      existing = '';
    }
    if (existing !== content) {
      console.error(`STALE: ${name} does not match ${source}`);
      stale += 1;
    }
  } else {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    console.log(`wrote ${name} (${summary})`);
  }
}

for (const spec of SPECS) {
  const path = join(ROOT, 'docs/architecture/openapi', spec.file);
  const doc = parse(readFileSync(path, 'utf8'));
  const schemas = doc?.components?.schemas ?? {};

  const body = Object.entries(schemas)
    .map(([name, schema]) => renderNamed(name, schema, spec.file))
    .join('\n\n');

  // Formatted with the repo's own prettier config before it is written OR compared.
  //
  // Without this, `api:check` and `format:check` contradict each other: prettier rewrites the
  // checked-in file, and the next `api:check` sees it differ from the generator's raw output. Two
  // required checks that cannot both pass is a build nobody can fix without deleting one of them.
  await emit(join(OUT_DIR, spec.out), `${header(spec)}\n${body}\n`, {
    name: spec.out,
    source: spec.file,
    summary: `${Object.keys(schemas).length} schemas`,
  });

  // The operations table (EP-02.4): one entry per operationId — method, the path AS THE GATEWAY
  // SERVES IT, and the names of its path parameters. Studio's `ApiClient` builds every request
  // from this, so a client cannot spell a path the contract does not have.
  //
  // Not a generated client with a method per operation: the stubs declare responses unevenly, so
  // half the return types would be `unknown`, and a client that is right half the time teaches
  // callers to cast. The table is the part that is right ALL the time.
  const operations = renderOperations(doc, spec.file);
  await emit(join(OUT_DIR, spec.ops), `${header(spec)}\n${operations.body}\n`, {
    name: spec.ops,
    source: spec.file,
    summary: `${operations.count} operations`,
  });
}

// --- event payloads ------------------------------------------------------------------------------
{
  const dir = join(ROOT, EVENTS.dir);
  const common = JSON.parse(readFileSync(join(dir, 'common.schema.json'), 'utf8'));
  const SUFFIX = '.payload.schema.json';
  const files = readdirSync(join(dir, 'events'))
    .filter((f) => f.endsWith(SUFFIX))
    .sort();

  // `../common.schema.json#/$defs/X` from an event, `#/$defs/X` from common itself: both name a
  // shared type generated below. Anything else is a construct this generator does not understand,
  // and it fails rather than guessing — the same rule as the OpenAPI half.
  const resolveRef = (ref, where) => {
    const m = /^(?:\.\.\/)?(?:common\.schema\.json)?#\/\$defs\/([A-Za-z0-9_]+)$/.exec(ref);
    if (!m) fail(where, `only refs into common.schema.json#/$defs are supported, got ${ref}`);
    if (!common.$defs?.[m[1]]) fail(where, `unknown shared type ${m[1]}`);
    return m[1];
  };

  // A shared enum is exported as a VALUE as well as a type (EP-02.5): `TierValues` is the array a
  // dropdown iterates or an exhaustiveness guard checks against, and `Tier` is derived from it so
  // the two cannot disagree. Only the shared `$defs` — they are the named Tier-0 enums the
  // inventory points at; an inline property enum stays a type on its interface.
  const shared = Object.entries(common.$defs ?? {})
    .map(([name, schema]) => {
      const values = schema.enum;
      if (Array.isArray(values) && values.every((v) => typeof v === 'string')) {
        const doc = schema.description ? `/** ${schema.description} */\n` : '';
        return (
          `${doc}export const ${name}Values = [${values.map((v) => JSON.stringify(v)).join(', ')}] as const;\n` +
          `export type ${name} = (typeof ${name}Values)[number];`
        );
      }
      return renderNamed(name, schema, 'common.schema.json', resolveRef);
    })
    .join('\n\n');

  const payloads = [];
  const map = [];
  for (const file of files) {
    const type = file.slice(0, -SUFFIX.length); // "asset.created"
    // `asset.created` -> AssetCreatedPayload; `schedule.sent-to-air` -> ScheduleSentToAirPayload.
    const name = type.replace(/(^|[.-])([a-z0-9])/g, (_, __, c) => c.toUpperCase()) + 'Payload';
    const schema = JSON.parse(readFileSync(join(dir, 'events', file), 'utf8'));
    payloads.push(renderNamed(name, schema, `events/${file}`, resolveRef));
    map.push(`  '${type}': ${name};`);
  }

  const raw = [
    `// GENERATED FROM ${EVENTS.dir} — DO NOT EDIT.`,
    '//',
    '// Regenerate with `npm run api:types`. `npm run api:check` fails the build when this file and the',
    '// schemas disagree. The same files are loaded at runtime by @atlas/contracts to VALIDATE a payload;',
    '// this is the compile-time projection of them, not a second opinion.',
    '',
    '// --- shared types (common.schema.json#/$defs) ---',
    '',
    shared,
    '',
    '// --- one payload per events/<type>.payload.schema.json ---',
    '',
    payloads.join('\n\n'),
    '',
    "/** Event type -> payload. `EventPayloads['asset.created']` is the payload of that event. */",
    'export interface EventPayloads {',
    map.join('\n'),
    '}',
    '',
    'export type EventType = keyof EventPayloads;',
    '',
  ].join('\n');
  await emit(join(ROOT, EVENTS.out), raw, {
    name: EVENTS.out,
    source: EVENTS.dir,
    summary: `${files.length} events, ${Object.keys(common.$defs ?? {}).length} shared types`,
  });
}

if (malformed > 0) {
  console.error(`\n${malformed} key(s) with no value in the OpenAPI contracts.`);
  process.exit(1);
}

if (check) {
  if (stale > 0) {
    console.error(`\n${stale} generated file(s) are out of date.`);
    console.error('Run: npm run api:types');
    process.exit(1);
  }
  console.log('generated API types are up to date');
}

/**
 * The prefix a server URL puts in front of every path: `https://{host}/api/v1` → `/api/v1`. Not
 * `new URL()` — `{host}` is a template variable, and a URL parser rejects it as a hostname.
 *
 * A path item may override the document's servers, and IAM's does: `/auth/*` and the JWKS are
 * served at the ROOT, where the gateway's public route and RFC 8615 respectively put them. The
 * contract records that per path so this table says what the wire does.
 */
function prefixOf(servers, where) {
  const url = servers?.[0]?.url;
  if (typeof url !== 'string') fail(where, 'no servers[0].url to take the path prefix from');
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/.*)?$/i.exec(url);
  if (!m) fail(where, `cannot read a path prefix from server url ${url}`);
  return (m[1] ?? '').replace(/\/+$/, '');
}

/** `export const MamOperations = { getAsset: { method: 'GET', path: '/api/v1/assets/{id}', params: ['id'] }, … }`. */
function renderOperations(doc, file) {
  const name = file.replace(/\.yaml$/, '').replace(/(^|-)([a-z])/g, (_, __, c) => c.toUpperCase());
  const seen = new Map();
  const lines = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const prefix = prefixOf(item.servers ?? doc.servers, `${file}#paths${path}`);
    const params = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    const declared = (op) =>
      [...(item.parameters ?? []), ...(op.parameters ?? [])]
        .filter((p) => p?.in === 'path')
        .map((p) => p.name);
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const where = `${file}#paths${path}.${method}`;
      // Every operation is addressed by its id, so an id that is missing or reused is a contract
      // that cannot be projected — fail rather than invent a name from the path.
      if (typeof op.operationId !== 'string' || !/^[a-zA-Z_$][\w$]*$/.test(op.operationId)) {
        fail(where, `operationId must be an identifier, got ${JSON.stringify(op.operationId)}`);
      }
      if (seen.has(op.operationId)) {
        fail(where, `operationId ${op.operationId} already used by ${seen.get(op.operationId)}`);
      }
      seen.set(op.operationId, where);
      const missing = params.filter((p) => !declared(op).includes(p));
      if (missing.length > 0) fail(where, `path params not declared: ${missing.join(', ')}`);
      const summary = op.summary ? `  /** ${op.summary.replace(/\*\//g, '* /')} */\n` : '';
      lines.push(
        `${summary}  ${op.operationId}: { method: '${method.toUpperCase()}', path: '${prefix}${path}', params: [${params.map((p) => `'${p}'`).join(', ')}] },`,
      );
    }
  }
  const body = [
    `/**`,
    ` * Every operation in ${file}: method, the path as the gateway serves it, and its path`,
    ` * parameters. Studio's \`ApiClient\` builds each request from one of these entries.`,
    ` */`,
    `export const ${name}Operations = {`,
    ...lines,
    `} as const;`,
    ``,
    `export type ${name}Operation = keyof typeof ${name}Operations;`,
  ].join('\n');
  return { body, count: seen.size };
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
function renderNamed(name, schema, file, resolveRef = openApiRef) {
  const doc = schema.description ? `/** ${schema.description} */\n` : '';

  if (schema.type === 'object' && schema.properties) {
    const required = new Set(schema.required ?? []);
    const fields = Object.entries(schema.properties)
      .map(([prop, sub]) => {
        const optional = required.has(prop) ? '' : '?';
        // A `nullable` field is `T | null` AND still required when the contract says so — an
        // optional key and a null value are different statements, and conflating them is how a
        // client starts treating "explicitly cleared" as "not sent".
        const type = tsType(sub, `${file}#${name}.${prop}`, resolveRef);
        const comment = sub.description ? `  /** ${sub.description} */\n` : '';
        return `${comment}  ${prop}${optional}: ${type};`;
      })
      .join('\n');
    return `${doc}export interface ${name} {\n${fields}\n}`;
  }

  return `${doc}export type ${name} = ${tsType(schema, `${file}#${name}`, resolveRef)};`;
}

/** OpenAPI: `#/components/schemas/X` names a sibling in the same document. */
function openApiRef(ref, where) {
  const match = /^#\/components\/schemas\/(.+)$/.exec(ref);
  if (!match) fail(where, `only local component refs are supported, got ${ref}`);
  return match[1];
}

function tsType(schema, where, resolveRef = openApiRef) {
  if (!schema || typeof schema !== 'object') fail(where, 'not a schema object');

  if (schema.$ref) return resolveRef(schema.$ref, where);

  // `allOf` is an intersection — the one composition keyword whose TypeScript projection is exact.
  // `oneOf`/`anyOf` stay unsupported: a discriminated union needs the discriminator named, and a
  // bare union of objects is not what a JSON Schema `anyOf` means.
  if (Array.isArray(schema.allOf)) {
    if (schema.allOf.length === 0) fail(where, 'empty allOf');
    return schema.allOf.map((s, i) => tsType(s, `${where}.allOf[${i}]`, resolveRef)).join(' & ');
  }

  const nullable = schema.nullable === true ? ' | null' : '';

  // A bare `enum` with no `type` is a closed set of literals whatever their JSON type — the shape
  // common.schema.json uses for `Tier`. Same union as the string case below.
  if (schema.type === undefined && Array.isArray(schema.enum)) {
    return schema.enum.map((v) => JSON.stringify(v)).join(' | ') + nullable;
  }

  // A schema with NO constraining keyword at all accepts any JSON value — that is what JSON Schema
  // says `{}` means, and `unknown` is its honest projection. Only annotations may be present; a
  // single keyword this generator does not handle still fails below rather than widening to
  // `unknown`, because a silent `unknown` is the drift this script exists to remove.
  const ANNOTATIONS = new Set(['description', 'title', 'examples', '$comment', 'deprecated']);
  if (Object.keys(schema).every((k) => ANNOTATIONS.has(k))) return 'unknown';

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
      return `${tsType(schema.items, `${where}[]`, resolveRef)}[]` + nullable;
    case 'object': {
      if (schema.properties) {
        const required = new Set(schema.required ?? []);
        const fields = Object.entries(schema.properties)
          .map(
            ([p, s]) =>
              `${p}${required.has(p) ? '' : '?'}: ${tsType(s, `${where}.${p}`, resolveRef)}`,
          )
          .join('; ');
        return `{ ${fields} }` + nullable;
      }
      if (schema.additionalProperties === true) return 'Record<string, unknown>' + nullable;
      if (schema.additionalProperties) {
        return (
          `Record<string, ${tsType(schema.additionalProperties, `${where}{}`, resolveRef)}>` +
          nullable
        );
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
