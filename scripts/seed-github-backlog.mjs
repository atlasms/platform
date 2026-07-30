#!/usr/bin/env node
/**
 * Seed the GitHub backlog from docs/roadmap/21-epic-breakdown.md.
 *
 * The DOC IS THE SOURCE OF TRUTH — this parses it rather than duplicating the backlog
 * into a second file. Re-running is safe: issues are matched by title and skipped if present.
 *
 *   node scripts/seed-github-backlog.mjs                 # dry run (default) — prints the plan
 *   node scripts/seed-github-backlog.mjs --execute       # actually create issues
 *   node scripts/seed-github-backlog.mjs --phase 0,1     # limit to phases
 *   node scripts/seed-github-backlog.mjs --execute --epics-only
 *
 * Requires: gh CLI authenticated with the `project` scope (see scripts/setup-github-project.ps1).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = path.join(ROOT, 'docs/roadmap/21-epic-breakdown.md');
const DOC_REL = 'docs/roadmap/21-epic-breakdown.md';

const ORG = 'atlasms';
const REPO = 'atlasms/platform';
const PROJECT_TITLE = 'Atlas Delivery';
const PROJECT_NUMBER = 2;

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const EXECUTE = argv.includes('--execute');
const EPICS_ONLY = argv.includes('--epics-only');
const phaseArg = argv.find((a) => a.startsWith('--phase'));
const PHASES = phaseArg
  ? (phaseArg.includes('=') ? phaseArg.split('=')[1] : argv[argv.indexOf(phaseArg) + 1]).split(',').map((s) => s.trim())
  : null;

// ---------------------------------------------------------------- gh helper
const GH = process.env.GH_PATH || 'gh';
function gh(args, { allowFail = false } = {}) {
  try {
    return execFileSync(GH, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch (e) {
    if (allowFail) return null;
    const msg = (e.stderr || e.stdout || e.message).toString().trim();
    throw new Error(`gh ${args.slice(0, 3).join(' ')} failed:\n${msg}`);
  }
}
function graphql(query, vars = {}) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push('-F', `${k}=${v}`);
  return JSON.parse(gh(args)).data;
}

// ---------------------------------------------------------------- parsing
/** Strip markdown decoration and status glyphs from a table cell to make a clean issue title. */
function cleanTitle(s) {
  return s
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[⚑◆⟳]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
/** Markers carry real meaning (critical path / correctness-critical / preceded by a spike). */
function markers(s) {
  const m = [];
  if (s.includes('⚑')) m.push('⚑ critical path');
  if (s.includes('◆')) m.push('◆ correctness-critical — 2 reviewers + pairing, not AI-fast-tracked');
  if (s.includes('⟳')) m.push('⟳ preceded by a time-boxed spike');
  return m;
}
const splitRow = (line) => line.split('|').slice(1, -1).map((c) => c.trim());

const md = fs.readFileSync(DOC, 'utf8');
const lines = md.split(/\r?\n/);

// --- epic index table (the authoritative epic list) ---
const epics = [];
{
  const start = lines.findIndex((l) => /^\|\s*#\s*\|\s*Epic\s*\|\s*Phase\s*\|/.test(l));
  if (start < 0) throw new Error('Could not locate the epic index table in ' + DOC_REL);
  for (let i = start + 2; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith('|')) break;
    const [id, title, phase, service, deps] = splitRow(l);
    const m = id.match(/EP-(\d+)/);
    if (!m) continue;
    epics.push({
      id: `EP-${m[1]}`,
      title: cleanTitle(title),
      markers: markers(title),
      phase: phase.trim(),
      service: service.trim(),
      deps: deps.replace(/[—–-]/g, '').trim(),
      stories: [],
    });
  }
}

// --- per-epic sections: goal, DoD, refs, story table ---
for (let i = 0; i < lines.length; i++) {
  const h = lines[i].match(/^##\s+(EP-\d+)\s+[—-]\s+(.*)$/);
  if (!h) continue;
  const epic = epics.find((e) => e.id === h[1]);
  if (!epic) continue;

  // walk to the next "## " heading
  let j = i + 1;
  const body = [];
  while (j < lines.length && !/^##\s/.test(lines[j])) body.push(lines[j++]);

  const goal = body.find((l) => l.startsWith('**Goal:**'));
  if (goal) epic.goal = goal.replace('**Goal:**', '').trim();
  const dod = body.find((l) => l.startsWith('**DoD'));
  if (dod) epic.dod = dod.replace(/^\*\*DoD[^:]*:\*\*/, '').trim();
  const refIdx = body.findIndex((l) => l.startsWith('**Refs:**'));
  if (refIdx >= 0) {
    let refs = body[refIdx].replace('**Refs:**', '').trim();
    if (body[refIdx + 1] && body[refIdx + 1].startsWith('[')) refs += ' ' + body[refIdx + 1].trim();
    epic.refs = refs;
  }

  // story table rows:  | 01.1 | Story text | 3 |
  for (const l of body) {
    if (!l.startsWith('|')) continue;
    const cells = splitRow(l);
    if (cells.length < 3) continue;
    const sid = cells[0].match(/^(\d+)\.(\d+)$/);
    if (!sid) continue;
    const est = cells[2].replace(/[—–-]/g, '').trim();
    epic.stories.push({
      id: `${epic.id}.${sid[2]}`,
      title: cleanTitle(cells[1]),
      markers: markers(cells[1]),
      estimate: est === '' ? null : Number(est),
      isSpike: /spike/i.test(cells[1]),
    });
  }
}

// ---------------------------------------------------------------- mapping
const PHASE_FIELD = {
  '0': 'Phase 0',
  '1': 'Phase 1 (MVP)',
  '2': 'Phase 2 (Beta)',
  '3': 'Phase 3 (v1.0)',
  GA: 'GA',
};
// index may say "bms/studio" — the project field is single-select, so take the primary
const primaryService = (s) => s.split('/')[0].trim();

const selected = PHASES ? epics.filter((e) => PHASES.includes(e.phase)) : epics;

// ---------------------------------------------------------------- bodies
const docLink = (anchor) => `https://github.com/${REPO}/blob/main/${DOC_REL}${anchor}`;

function epicBody(e) {
  const out = [];
  if (e.goal) out.push(`**Goal:** ${e.goal}`, '');
  out.push(`| | |`, `|---|---|`, `| **Phase** | ${PHASE_FIELD[e.phase] ?? e.phase} |`, `| **Service** | ${e.service} |`);
  if (e.deps) out.push(`| **Depends on** | ${e.deps} |`);
  out.push('');
  if (e.markers.length) out.push(...e.markers.map((m) => `> ${m}`), '');
  if (e.stories.length) {
    out.push(`### Stories (${e.stories.length})`, '');
    out.push(...e.stories.map((s) => `- \`${s.id}\` ${s.title}${s.estimate ? ` — ${s.estimate}` : ''}`), '');
  }
  if (e.dod) out.push(`**Definition of Done:** ${e.dod}`, '');
  if (e.refs) out.push(`**Refs:** ${e.refs}`, '');
  out.push('---', `Generated from [\`${DOC_REL}\`](${docLink('')}) — edit the doc, not this issue body.`);
  return out.join('\n');
}

function storyBody(s, e) {
  const out = [];
  out.push(`Part of **${e.id} — ${e.title}**.`, '');
  out.push(`| | |`, `|---|---|`, `| **Phase** | ${PHASE_FIELD[e.phase] ?? e.phase} |`, `| **Service** | ${e.service} |`);
  if (s.estimate) out.push(`| **Estimate** | ${s.estimate} |`);
  out.push('');
  if (s.markers.length) out.push(...s.markers.map((m) => `> ${m}`), '');
  if (s.isSpike) {
    out.push('> **Spike** — time-boxed, and it must produce a written artifact (a doc update or an ADR),', '> never just "we looked into it".', '');
  }
  out.push(
    '### Definition of Ready / Done',
    '',
    'This story is governed by the shared [Definition of Ready](https://github.com/' + REPO +
      '/blob/main/docs/roadmap/20-delivery-process.md#6-definition-of-ready-to-pull-a-story) and',
    '[Definition of Done](https://github.com/' + REPO +
      '/blob/main/docs/roadmap/20-delivery-process.md#7-definition-of-done) — contracts merged first,',
    'consumer-fanout CI green, outbox + idempotency, `channelId` scoping, server-side authorization, audit delta, docs in the same PR.',
    '',
    '---',
    `Generated from [\`${DOC_REL}\`](${docLink('')}).`
  );
  return out.join('\n');
}

// ---------------------------------------------------------------- plan summary
const totalEpics = selected.length;
const totalStories = EPICS_ONLY ? 0 : selected.reduce((n, e) => n + e.stories.length, 0);
const points = selected.flatMap((e) => e.stories).reduce((n, s) => n + (s.estimate || 0), 0);

console.log(`\nParsed ${DOC_REL}`);
console.log(`  epics parsed        : ${epics.length}`);
console.log(`  stories parsed      : ${epics.reduce((n, e) => n + e.stories.length, 0)}`);
if (PHASES) console.log(`  phase filter        : ${PHASES.join(', ')}`);
console.log(`\nPlanned issues: ${totalEpics} epics + ${totalStories} stories = ${totalEpics + totalStories}`);
console.log(`Story points in scope: ${points}`);
console.log('\nBy phase:');
for (const p of ['0', '1', '2', '3', 'GA']) {
  const es = selected.filter((e) => e.phase === p);
  if (!es.length) continue;
  const st = es.reduce((n, e) => n + e.stories.length, 0);
  console.log(`  ${(PHASE_FIELD[p] ?? p).padEnd(16)} ${String(es.length).padStart(2)} epics, ${String(st).padStart(3)} stories`);
}

// sanity checks that would silently corrupt the backlog
const problems = [];
for (const e of selected) {
  if (!PHASE_FIELD[e.phase]) problems.push(`${e.id}: unmapped phase "${e.phase}"`);
  if (!e.title) problems.push(`${e.id}: empty title`);
  for (const s of e.stories) {
    if (!s.title) problems.push(`${s.id}: empty title`);
    if (s.estimate !== null && ![1, 2, 3, 5, 8].includes(s.estimate)) problems.push(`${s.id}: estimate ${s.estimate} not in 1/2/3/5/8`);
  }
}
if (problems.length) {
  console.error('\nPARSE PROBLEMS:\n' + problems.map((p) => '  - ' + p).join('\n'));
  process.exit(1);
}
console.log('\nParse checks: OK');

if (!EXECUTE) {
  console.log('\n--- DRY RUN (no issues created). Sample of what would be produced: ---\n');
  const e = selected[0];
  console.log(`TITLE: ${e.id} — ${e.title}`);
  console.log(`TYPE : Epic\n`);
  console.log(epicBody(e).split('\n').map((l) => '  ' + l).join('\n'));
  if (e.stories[0]) {
    console.log(`\nTITLE: ${e.stories[0].id} — ${e.stories[0].title}`);
    console.log(`TYPE : ${e.stories[0].isSpike ? 'Spike' : 'Story'}   PARENT: ${e.id}\n`);
    console.log(storyBody(e.stories[0], e).split('\n').map((l) => '  ' + l).join('\n'));
  }
  console.log('\nRe-run with --execute to create them.\n');
  process.exit(0);
}

// ---------------------------------------------------------------- preflight
console.log('\n==> Preflight');
const auth = gh(['auth', 'status'], { allowFail: true }) || '';
if (!/'project'/.test(auth)) throw new Error("Token is missing the 'project' scope. Run: gh auth refresh -s project");

const meta = graphql(
  `query($org:String!,$num:Int!){ organization(login:$org){ projectV2(number:$num){
     id
     fields(first:30){ nodes{
       ... on ProjectV2FieldCommon { id name }
       ... on ProjectV2SingleSelectField { id name options{ id name } } } } } } }`,
  { org: ORG, num: PROJECT_NUMBER }
).organization.projectV2;

const fieldBy = Object.fromEntries(meta.fields.nodes.filter((f) => f.name).map((f) => [f.name, f]));
for (const need of ['Phase', 'Estimate', 'Service', 'Requirement']) {
  if (!fieldBy[need]) throw new Error(`Project field "${need}" not found — run scripts/setup-github-project.ps1 first.`);
}
console.log(`    project ${meta.id}, fields OK`);

// existing issues (idempotency) — match on the "EP-nn" / "EP-nn.s" title prefix
const existingRaw = gh(['issue', 'list', '--repo', REPO, '--state', 'all', '--limit', '2000', '--json', 'number,title']);
const existing = new Map();
for (const it of JSON.parse(existingRaw)) {
  const m = it.title.match(/^(EP-\d+(?:\.\d+)?)\s/);
  if (m) existing.set(m[1], it.number);
}
console.log(`    ${existing.size} issues already seeded`);

// ---------------------------------------------------------------- create
function createIssue({ key, title, body, type, parent }) {
  if (existing.has(key)) {
    console.log(`    = ${key} exists (#${existing.get(key)})`);
    return existing.get(key);
  }
  const args = ['issue', 'create', '--repo', REPO, '--title', `${key} — ${title}`, '--body', body,
                '--project', PROJECT_TITLE, '--type', type];
  if (parent) args.push('--parent', String(parent));
  const url = gh(args);
  const num = Number(url.trim().split('/').pop());
  existing.set(key, num);
  console.log(`    + ${key} #${num}  ${title.slice(0, 58)}`);
  return num;
}

console.log('\n==> Creating epics');
for (const e of selected) {
  e.number = createIssue({ key: e.id, title: e.title, body: epicBody(e), type: 'Epic' });
}

if (!EPICS_ONLY) {
  console.log('\n==> Creating stories');
  for (const e of selected) {
    for (const s of e.stories) {
      s.number = createIssue({
        key: s.id, title: s.title, body: storyBody(s, e),
        type: s.isSpike ? 'Spike' : 'Story', parent: e.number,
      });
    }
  }
}

// ---------------------------------------------------------------- project fields
console.log('\n==> Setting project field values');
const itemsRaw = graphql(
  `query($org:String!,$num:Int!){ organization(login:$org){ projectV2(number:$num){
     items(first:100){ pageInfo{ hasNextPage endCursor }
       nodes{ id content{ ... on Issue { number } } } } } } }`,
  { org: ORG, num: PROJECT_NUMBER }
);
// paginate
const itemByIssue = new Map();
let page = itemsRaw.organization.projectV2.items;
const collect = (p) => p.nodes.forEach((n) => n.content?.number && itemByIssue.set(n.content.number, n.id));
collect(page);
while (page.pageInfo.hasNextPage) {
  const next = graphql(
    `query($org:String!,$num:Int!,$after:String!){ organization(login:$org){ projectV2(number:$num){
       items(first:100, after:$after){ pageInfo{ hasNextPage endCursor }
         nodes{ id content{ ... on Issue { number } } } } } } }`,
    { org: ORG, num: PROJECT_NUMBER, after: page.pageInfo.endCursor }
  );
  page = next.organization.projectV2.items;
  collect(page);
}

function setField(itemId, field, value) {
  let v;
  if (field.options) {
    const opt = field.options.find((o) => o.name === value);
    if (!opt) return;
    v = `{ singleSelectOptionId: "${opt.id}" }`;
  } else if (typeof value === 'number') {
    v = `{ number: ${value} }`;
  } else {
    v = `{ text: ${JSON.stringify(value)} }`;
  }
  gh(['api', 'graphql', '-f', `query=mutation{ updateProjectV2ItemFieldValue(input:{ projectId:"${meta.id}", itemId:"${itemId}", fieldId:"${field.id}", value:${v} }){ projectV2Item{ id } } }`]);
}

let fieldUpdates = 0;
for (const e of selected) {
  const targets = [{ n: e.number, est: null }, ...(EPICS_ONLY ? [] : e.stories.map((s) => ({ n: s.number, est: s.estimate })))];
  for (const t of targets) {
    const itemId = itemByIssue.get(t.n);
    if (!itemId) continue;
    setField(itemId, fieldBy.Phase, PHASE_FIELD[e.phase]);
    setField(itemId, fieldBy.Service, primaryService(e.service));
    if (t.est) setField(itemId, fieldBy.Estimate, t.est);
    fieldUpdates++;
  }
}
console.log(`    updated ${fieldUpdates} items`);

console.log(`\nDone. https://github.com/orgs/${ORG}/projects/${PROJECT_NUMBER}\n`);
