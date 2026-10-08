// The triage report (EP-21.5): what is waiting, what is late, what escaped.
//
//   npm run triage                 # the table, in the terminal
//   (weekly in .github/workflows/triage.yml, into the job summary)
//
// The daily triage reads the top of this; the weekly review with the pilot reads all of it. The
// clocks are docs/operations/pilot-feedback.md's — change them there and here together.

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const REPO = process.env.GITHUB_REPOSITORY ?? 'atlasms/platform';
const DAY = 86_400_000;

/** How long an item may stay open at each severity before it is late (calendar days). */
const SLA_DAYS = { critical: 1, high: 14, medium: 28 };
/** How long a report may wait for its first triage. */
const TRIAGE_DAYS = 1;

function issues(args) {
  const out = execFileSync(
    'gh',
    [
      'issue',
      'list',
      '--repo',
      REPO,
      '--limit',
      '500',
      '--json',
      'number,title,createdAt,closedAt,labels,state',
      ...args,
    ],
    { encoding: 'utf8' },
  );
  return JSON.parse(out);
}

const now = Date.now();
const age = (i) => (now - Date.parse(i.createdAt)) / DAY;
const days = (d) => `${d < 1 ? (d * 24).toFixed(0) + ' h' : d.toFixed(1) + ' d'}`;
const severityOf = (i) =>
  i.labels
    .map((l) => l.name)
    .find((n) => n.startsWith('severity:'))
    ?.slice('severity:'.length);

const lines = [`### Triage report — ${new Date(now).toISOString().slice(0, 16)}Z`, ''];

const waiting = issues(['--state', 'open', '--label', 'triage']).sort((a, b) => age(b) - age(a));
lines.push(`**Waiting for triage (${waiting.length})** — target: within ${TRIAGE_DAYS} day`, '');
if (waiting.length === 0) lines.push('_Nothing waiting._');
else {
  lines.push('| # | title | severity | waiting | |', '|---|---|---|---|---|');
  for (const i of waiting) {
    const late = age(i) > TRIAGE_DAYS;
    lines.push(
      `| #${i.number} | ${i.title} | ${severityOf(i) ?? '—'} | ${days(age(i))} | ${late ? '⚠ late' : ''} |`,
    );
  }
}

const open = issues(['--state', 'open', '--label', 'bug']).concat(
  issues(['--state', 'open', '--label', 'pilot']),
);
const unique = [...new Map(open.map((i) => [i.number, i])).values()];
lines.push(
  '',
  '**Open defects by severity**',
  '',
  '| severity | open | late | oldest | clock |',
  '|---|---|---|---|---|',
);
let lateCritical = 0;
for (const severity of ['critical', 'high', 'medium', 'low', undefined]) {
  const group = unique.filter((i) => severityOf(i) === severity);
  const sla = severity ? SLA_DAYS[severity] : undefined;
  const late = sla === undefined ? [] : group.filter((i) => age(i) > sla);
  if (severity === 'critical') lateCritical = late.length;
  const oldest = group.length ? days(Math.max(...group.map(age))) : '—';
  lines.push(
    `| ${severity ?? '(none yet)'} | ${group.length} | ${late.length ? `⚠ ${late.map((i) => '#' + i.number).join(' ')}` : 0} | ${oldest} | ${sla ? sla + ' d' : '—'} |`,
  );
}

const escaped = issues(['--state', 'all', '--label', 'escaped-defect']);
lines.push(
  '',
  `**Escaped defects** (shipped past the Definition of Done): ${escaped.length} — ` +
    `${escaped.filter((i) => i.state === 'OPEN').length} open.`,
);

const report = lines.join('\n');
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
if (lateCritical > 0) console.error(`\n${lateCritical} critical item(s) past their one-day clock.`);
