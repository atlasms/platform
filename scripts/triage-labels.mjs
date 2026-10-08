// Label an issue from its form (EP-21.5) — severity, data integrity/authorization, escaped defect.
//
//   node scripts/triage-labels.mjs            # in .github/workflows/triage.yml, on issues opened/edited
//   node scripts/triage-labels.mjs --self-test
//
// The Bug and Pilot feedback forms ask for a severity, but a dropdown answer is only text in the
// issue body: nothing on the board could filter or sort by it, and the triage report could not age
// bugs against their SLA. This reads the answers and keeps the labels in step with them — so an
// edit that changes the severity moves the label too. Triage itself (`triage` removed, an owner, a
// type) stays a person's call; this only makes the form's answers queryable.
//
// The rules, from docs/operations/pilot-feedback.md:
//   - the severity answer → exactly one `severity:*` label;
//   - "data integrity or authorization is involved" → `integrity-or-authz`, and severity at least
//     HIGH whatever was chosen (the Bug form says so; a lost edit is never "cosmetic");
//   - "escaped defect" → `escaped-defect` (the delivery process's phase metric).

import { readFileSync } from 'node:fs';

const SEVERITIES = ['critical', 'high', 'medium', 'low'];

/** Answer prefixes on either form → severity. */
const ANSWERS = [
  [/^critical\b/i, 'critical'],
  [/^blocking\b/i, 'critical'],
  [/^high\b/i, 'high'],
  [/^i can't do this task/i, 'high'],
  [/^medium\b/i, 'medium'],
  [/^it works, but/i, 'medium'],
  [/^low\b/i, 'low'],
  [/^cosmetic\b/i, 'low'],
];

/** The text under a form heading (`### <label>`), up to the next heading. */
function section(body, heading) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `### ${heading}`.toLowerCase());
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('### '));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
}

const checked = (body, phrase) =>
  body.split(/\r?\n/).some((l) => /^- \[x\]/i.test(l.trim()) && l.toLowerCase().includes(phrase));

/** The labels the form's answers call for, and the severity labels to take off. */
export function labelsFor(body) {
  const answer =
    section(body, 'Severity') || section(body, 'How much does it get in your way?') || '';
  let severity = ANSWERS.find(([re]) => re.test(answer))?.[1];
  const integrity =
    checked(body, 'data integrity or authorization') ||
    checked(body, 'something i saved was lost or changed');
  if (integrity && (severity === undefined || SEVERITIES.indexOf(severity) > 1)) severity = 'high';
  const add = [];
  if (severity) add.push(`severity:${severity}`);
  if (integrity) add.push('integrity-or-authz');
  if (checked(body, 'escaped defect')) add.push('escaped-defect');
  const remove = SEVERITIES.filter((s) => s !== severity).map((s) => `severity:${s}`);
  return { add, remove: severity ? remove : [] };
}

function selfTest() {
  const bug = (sev, extra = '') =>
    `### Expected vs actual\n\nx\n\n### Severity\n\n${sev}\n\n### Triage\n\n${extra}`;
  const cases = [
    [bug('Critical — media path blocked (ingest/approval/send-to-air)'), ['severity:critical']],
    [
      bug('Low — cosmetic', '- [X] Data integrity or authorization is involved (raises…)'),
      ['severity:high', 'integrity-or-authz'],
    ],
    [
      bug(
        'Medium — degraded',
        '- [x] Escaped defect — shipped past the DoD\n- [ ] Data integrity or authorization',
      ),
      ['severity:medium', 'escaped-defect'],
    ],
    [
      `### How much does it get in your way?\n\nCosmetic — wording, layout, translation\n\n### Anything worse?\n\n- [X] Something I saved was lost or changed, or I could see…`,
      ['severity:high', 'integrity-or-authz'],
    ],
    [
      `### How much does it get in your way?\n\nBlocking — media cannot be ingested`,
      ['severity:critical'],
    ],
    ['no form at all', []],
  ];
  for (const [body, expected] of cases) {
    const got = labelsFor(body).add;
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      console.error(`FAIL: ${JSON.stringify(got)} ≠ ${JSON.stringify(expected)} for:\n${body}`);
      process.exit(1);
    }
  }
  console.log(`triage-labels: ${cases.length} cases OK`);
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8'));
  const issue = event.issue;
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!issue || !repo || !token)
    throw new Error('needs GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_TOKEN');
  const { add, remove } = labelsFor(issue.body ?? '');
  const have = new Set((issue.labels ?? []).map((l) => l.name));
  const api = (path, init = {}) =>
    globalThis.fetch(`https://api.github.com/repos/${repo}/issues/${issue.number}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      },
    });
  const missing = add.filter((l) => !have.has(l));
  if (missing.length > 0) {
    const res = await api('/labels', { method: 'POST', body: JSON.stringify({ labels: missing }) });
    if (!res.ok) throw new Error(`adding ${missing}: ${res.status} ${await res.text()}`);
  }
  for (const label of remove.filter((l) => have.has(l))) {
    await api(`/labels/${encodeURIComponent(label)}`, { method: 'DELETE' });
  }
  console.log(
    `#${issue.number}: +[${missing.join(', ')}] -[${remove.filter((l) => have.has(l)).join(', ')}]`,
  );
}

await main();
