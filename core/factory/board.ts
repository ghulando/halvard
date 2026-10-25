import type { FactoryJob } from '../types.ts';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jobFile, listJobs, repoHome } from './store.ts';
import { classRates, trackedJobs } from './outcomes.ts';

interface Event {
  at: string;
  event: string;
  [key: string]: unknown;
}

export function jobEvents(root: string, id: string): Event[] {
  const file = jobFile(root, id, 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Event];
      } catch {
        return [];
      }
    });
}

// Agent spend recorded in the current calendar month (UTC), across every job.
export function monthSpend(root: string, now = new Date()) {
  const month = now.toISOString().slice(0, 7);
  let total = 0;
  for (const job of listJobs(root)) {
    for (const event of jobEvents(root, job.id)) {
      if (
        event.event === 'agent' &&
        event.at.startsWith(month) &&
        typeof event.costUsd === 'number'
      ) {
        total += event.costUsd;
      }
    }
  }
  return total;
}

const rate = (part: number, whole: number) =>
  whole ? Math.round((part / whole) * 1000) / 10 : null;

export function metrics(root: string, now = new Date()) {
  const jobs = listJobs(root);
  const stages: Record<string, number> = {};
  const parked: Record<string, number> = {};
  let gated = 0;
  let firstGatePassed = 0;
  let reviewed = 0;
  let firstRoundBlocked = 0;
  const finished: FactoryJob[] = [];
  const hours: number[] = [];
  for (const job of jobs) {
    stages[job.stage] = (stages[job.stage] ?? 0) + 1;
    if (job.parked) parked[job.parked.reason] = (parked[job.parked.reason] ?? 0) + 1;
    const events = jobEvents(root, job.id);
    const gate = events.find((event) => event.event === 'gate');
    if (gate) {
      gated++;
      if (gate.passed === true) firstGatePassed++;
    }
    const review = events.find((event) => event.event === 'review' && event.round === 1);
    if (review) {
      reviewed++;
      if (review.verdict !== 'pass') firstRoundBlocked++;
    }
    if (job.stage === 'pr-open' || job.stage === 'committed') {
      finished.push(job);
      const end = events.find((event) => event.event === 'committed');
      if (end) hours.push((Date.parse(end.at) - Date.parse(job.created)) / 3600000);
    }
  }
  hours.sort((a, b) => a - b);
  // Outcomes as factory serve or factory automerge last fetched them; no GitHub call here.
  const classes = classRates(trackedJobs(root));
  const merged = Object.values(classes).reduce((sum, row) => sum + row.merged, 0);
  const edited = Object.values(classes).reduce((sum, row) => sum + row.humanEdited, 0);
  return {
    jobs: jobs.length,
    stages,
    parked,
    firstGatePassRate: rate(firstGatePassed, gated),
    firstReviewBlockRate: rate(firstRoundBlocked, reviewed),
    parkRate: rate(jobs.filter((job) => job.stage === 'parked').length, jobs.length),
    meanCostPerFinishedUsd: finished.length
      ? Math.round((finished.reduce((sum, job) => sum + job.costUsd, 0) / finished.length) * 100) /
        100
      : null,
    medianHoursToCommit: hours.length
      ? Math.round(hours[Math.floor(hours.length / 2)]! * 10) / 10
      : null,
    monthSpendUsd: Math.round(monthSpend(root, now) * 100) / 100,
    mergedPullRequests: merged,
    humanEditRate: rate(edited, merged),
    humanEditRateByClass: classes,
  };
}

const escape = (text: unknown) =>
  String(text ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );

const COLUMNS: { title: string; stages: string[] }[] = [
  { title: 'Planning', stages: ['awaiting-plan', 'planning'] },
  { title: 'Waiting for you', stages: ['awaiting-approval'] },
  {
    title: 'Building',
    stages: ['approved', 'testing', 'building', 'gating', 'reviewing', 'shipping'],
  },
  { title: 'Done', stages: ['committed', 'pr-open'] },
  { title: 'Parked', stages: ['parked'] },
];

function card(job: FactoryJob) {
  const link = (url: string | null | undefined, text: string) =>
    url && /^https:\/\//.test(url) ? `<a href="${escape(url)}">${escape(text)}</a>` : escape(text);
  return `<article class="card ${job.stage === 'parked' ? 'parked' : ''}">
<header><span class="id">${escape(job.id)}</span><span class="stage">${escape(job.stage)}</span></header>
<p class="title">${escape(job.title)}</p>
<dl>
${job.issue ? `<dt>Issue</dt><dd>${link(job.issue.url, `#${job.issue.number}`)}</dd>` : ''}
<dt>Author</dt><dd>${escape(job.author)}</dd>
${job.reviewer ? `<dt>Review</dt><dd>${escape(job.reviewer)}, round ${job.round}</dd>` : ''}
<dt>Cost</dt><dd>$${job.costUsd.toFixed(2)}${job.fixPasses ? `, ${job.fixPasses} fix pass${job.fixPasses > 1 ? 'es' : ''}` : ''}</dd>
${job.pr ? `<dt>PR</dt><dd>${link(job.pr, 'open')}</dd>` : ''}
${job.parked ? `<dt>Parked</dt><dd><strong>${escape(job.parked.reason)}</strong>: ${escape(job.parked.detail.split('\n')[0])}</dd>` : ''}
</dl>
</article>`;
}

// A static page: no server, no script, refreshed by the browser while it stays open.
export function boardHtml(root: string, now = new Date()) {
  const jobs = listJobs(root).sort((a, b) => b.updated.localeCompare(a.updated));
  const numbers = metrics(root, now);
  const percent = (value: number | null) => (value === null ? 'n/a' : `${value}%`);
  const tiles = [
    ['Jobs', String(numbers.jobs)],
    ['Gate passes first try', percent(numbers.firstGatePassRate)],
    ['Review blocks round 1', percent(numbers.firstReviewBlockRate)],
    ['Parked', percent(numbers.parkRate)],
    [
      'Mean cost per finished job',
      numbers.meanCostPerFinishedUsd === null ? 'n/a' : `$${numbers.meanCostPerFinishedUsd}`,
    ],
    ['Spent this month', `$${numbers.monthSpendUsd}`],
    ['Human edits after merge', percent(numbers.humanEditRate)],
  ];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30"><title>Halvard factory board</title>
<style>
:root { --bg: #f4f5f3; --card: #fff; --ink: #1d2326; --muted: #5a6468; --rule: #d5d9d6; --park: #b3412f; --accent: #2b6c7f; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg: #14181a; --card: #1d2326; --ink: #e3e7e6; --muted: #9aa5a8; --rule: #2e3639; --park: #f0a092; --accent: #7cc0d3; color-scheme: dark; } }
body { margin: 0; padding: 20px max(16px, env(safe-area-inset-left)); background: var(--bg); color: var(--ink); font: 14px/1.45 system-ui, sans-serif; }
h1 { font-size: 20px; margin: 0 0 4px; } .sub { color: var(--muted); margin: 0 0 16px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; margin-bottom: 20px; }
.tile { background: var(--card); border: 1px solid var(--rule); border-radius: 6px; padding: 10px; }
.tile b { display: block; font-size: 20px; font-variant-numeric: tabular-nums; } .tile span { color: var(--muted); font-size: 12px; }
.board { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; align-items: start; }
.column h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 8px; }
.card { background: var(--card); border: 1px solid var(--rule); border-radius: 6px; padding: 10px; margin-bottom: 10px; }
.card.parked { border-color: var(--park); } .card header { display: flex; justify-content: space-between; gap: 8px; }
.id { font-family: ui-monospace, monospace; font-size: 12px; } .stage { color: var(--muted); font-size: 12px; }
.title { margin: 6px 0; font-weight: 600; } dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; margin: 0; font-size: 12px; }
dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; } a { color: var(--accent); } .parked strong { color: var(--park); }
</style></head><body>
<h1>Halvard factory</h1>
<p class="sub">${escape(root)} · updated ${escape(now.toISOString().replace('T', ' ').slice(0, 16))} UTC</p>
<section class="tiles">${tiles.map(([label, value]) => `<div class="tile"><b>${escape(value)}</b><span>${escape(label)}</span></div>`).join('')}</section>
<section class="board">
${COLUMNS.map(
  (
    column,
  ) => `<div class="column"><h2>${escape(column.title)} (${jobs.filter((job) => column.stages.includes(job.stage)).length})</h2>
${jobs
  .filter((job) => column.stages.includes(job.stage))
  .map(card)
  .join('\n')}</div>`,
).join('\n')}
</section>
</body></html>
`;
}

export function writeBoard(root: string, out = join(repoHome(root), 'board.html')) {
  const temp = `${out}.tmp`;
  writeFileSync(temp, boardHtml(root), { mode: 0o600 });
  renameSync(temp, out);
  return out;
}
