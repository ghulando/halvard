import type { AutoMergeConfig, FactoryJob } from '../types.ts';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { jobEvents } from './board.ts';
import { baseRef, exec, gh } from './ship.ts';
import { jobFile, listJobs, recordEvent } from './store.ts';
import { matches } from '../project.ts';

const DAY = 24 * 3600 * 1000;
// Commits to the same files this long after a merge count as human edits after it.
const FOLLOW_UP_DAYS = 14;
const REFRESH_MS = 3600 * 1000;

// What the runner recorded when it committed: the facts auto-merge decides on.
export interface Shipped {
  head: string | null;
  class: string | null;
  lines: number;
  firstTry: boolean;
  risky: boolean;
  holdoutFailed: boolean;
  files: string[];
}

// What happened to the pull request after the factory opened it.
export interface Outcome {
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  draft: boolean;
  mergedAt: string | null;
  mergeCommit: string | null;
  head: string | null;
  // Commits on the pull request that the factory did not make.
  humanCommits: number;
  ci: 'green' | 'pending' | 'red' | 'none';
  // Why a person may not want it merged: requested changes, a review that is not an
  // approval, or a factory:stop label.
  objection: string | null;
  // Commits to the same files within FOLLOW_UP_DAYS of the merge.
  followUps: string[];
  revertedAt: string | null;
  checkedAt: string;
  // Nothing about it changes any more, so it is never fetched again.
  final: boolean;
}

export function shipped(root: string, id: string): Shipped | null {
  const event = jobEvents(root, id)
    .filter((entry) => entry.event === 'committed')
    .at(-1);
  if (!event) return null;
  return {
    head: typeof event.head === 'string' ? event.head : null,
    class: typeof event.class === 'string' ? event.class : null,
    lines: typeof event.lines === 'number' ? event.lines : Infinity,
    firstTry: event.firstTry === true,
    risky: event.risk === 'high',
    holdoutFailed: event.holdoutFailed === true,
    files: Array.isArray(event.files) ? (event.files as string[]) : [],
  };
}

export function loadOutcome(root: string, id: string): Outcome | null {
  const file = jobFile(root, id, 'outcome.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Outcome;
  } catch {
    return null;
  }
}

function saveOutcome(root: string, id: string, outcome: Outcome) {
  const file = jobFile(root, id, 'outcome.json');
  writeFileSync(`${file}.tmp`, JSON.stringify(outcome, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

// The class a change belongs to: the first whose patterns match every changed file.
export function changeClass(files: string[], classes: Record<string, string[]>) {
  if (!files.length) return null;
  return (
    Object.entries(classes).find(([, patterns]) =>
      files.every((file) => matches(file, patterns)),
    )?.[0] ?? null
  );
}

const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const PENDING = new Set([
  '',
  'PENDING',
  'EXPECTED',
  'QUEUED',
  'IN_PROGRESS',
  'WAITING',
  'REQUESTED',
]);

type Check = {
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
};

// A commit status has a state; a check run has a status and, once completed, a conclusion.
function checkState(check: Check) {
  if (check.state !== undefined) return check.state;
  if (check.status === 'COMPLETED') return check.conclusion ?? '';
  return check.status ?? '';
}

// A pull request with no checks is not green: nothing showed that it works. Every required
// check must be there and have succeeded, so one quick bot success is not enough.
export function ciState(rollup: Check[], required: string[] = []) {
  if (!rollup.length) return 'none' as const;
  const states = rollup.map(checkState);
  if (states.some((state) => !PASSED.has(state) && !PENDING.has(state))) return 'red' as const;
  const names = new Set(rollup.map((check) => check.name ?? check.context));
  if (required.some((name) => !names.has(name))) return 'pending' as const;
  if (states.every((state) => PASSED.has(state))) return 'green' as const;
  return 'pending' as const;
}

interface Pull {
  state: Outcome['state'];
  isDraft: boolean;
  mergedAt: string | null;
  mergeCommit: { oid: string } | null;
  headRefOid: string;
  commits: { oid: string }[];
  statusCheckRollup: Check[] | null;
  reviewDecision?: string | null;
  reviews?: { state: string }[];
  labels?: { name: string }[];
}

function objection(pull: Pull) {
  if (pull.reviewDecision === 'CHANGES_REQUESTED') return 'a reviewer requested changes';
  if ((pull.reviews ?? []).some((review) => review.state !== 'APPROVED')) {
    return 'a reviewer left a review that is not an approval';
  }
  if ((pull.labels ?? []).some((label) => label.name === 'factory:stop')) {
    return 'it is labeled factory:stop';
  }
  return null;
}

// Fetches the pull request and, once merged, reads the base for later commits to the same
// files and for a revert. base is the branch as the main checkout sees it after a fetch.
function fetchOutcome(
  root: string,
  { job, facts }: Tracked,
  {
    base,
    windowDays,
    others,
    now,
    required,
  }: {
    base: string;
    windowDays: number;
    // Merge commits of the factory's own pull requests, which are not human edits.
    others: Set<string>;
    now: Date;
    required: string[];
  },
): Outcome | null {
  const view = gh(root, [
    'pr',
    'view',
    job.pr!,
    '--json',
    'state,isDraft,mergedAt,mergeCommit,headRefOid,commits,statusCheckRollup,reviewDecision,reviews,labels',
  ]);
  if (view.status !== 0) return null;
  const pull = JSON.parse(view.stdout) as Pull;
  const outcome: Outcome = {
    state: pull.state,
    draft: pull.isDraft,
    mergedAt: pull.mergedAt || null,
    mergeCommit: pull.mergeCommit?.oid ?? null,
    head: pull.headRefOid,
    humanCommits: pull.commits.filter((commit) => commit.oid !== facts.head).length,
    ci: ciState(pull.statusCheckRollup ?? [], required),
    objection: objection(pull),
    followUps: [],
    revertedAt: null,
    checkedAt: now.toISOString(),
    final: pull.state === 'CLOSED',
  };
  if (outcome.state !== 'MERGED' || !outcome.mergedAt) return outcome;
  const merged = Date.parse(outcome.mergedAt);
  const until = new Date(merged + FOLLOW_UP_DAYS * DAY).toISOString();
  const log = (args: string[]) => {
    const run = exec('git', ['log', '--format=%H %cI', ...args], root);
    return run.status === 0
      ? run.stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => line.split(' ') as [string, string])
      : [];
  };
  // Other factory merges to the same files are not human edits.
  outcome.followUps = facts.files.length
    ? log([base, `--since=${outcome.mergedAt}`, `--until=${until}`, '--', ...facts.files])
        .map(([sha]) => sha)
        .filter((sha) => sha !== outcome.mergeCommit && !others.has(sha))
    : [];
  if (outcome.mergeCommit) {
    const revert = log([
      base,
      `--since=${outcome.mergedAt}`,
      '-F',
      `--grep=This reverts commit ${outcome.mergeCommit}`,
    ]).at(-1);
    outcome.revertedAt = revert ? revert[1] : null;
  }
  outcome.final = now.getTime() > merged + Math.max(FOLLOW_UP_DAYS, windowDays) * DAY;
  return outcome;
}

export interface Tracked {
  job: FactoryJob;
  facts: Shipped;
  outcome: Outcome | null;
  // Merged by auto-merge, which says nothing about whether a person would have merged it.
  auto: boolean;
}

// When fetching a pull request last failed, so a failing one waits an hour, not one poll.
const failed = new Map<string, number>();
const failKey = (root: string, entry: Tracked) => `${root}\0${entry.job.id}`;

// Every job that opened a pull request, with the outcome last fetched for it.
export const trackedJobs = (root: string): Tracked[] =>
  listJobs(root).flatMap((job) => {
    const facts = job.pr ? shipped(root, job.id) : null;
    if (!facts) return [];
    const auto = jobEvents(root, job.id).some(
      (event) => event.event === 'auto-merge' && event.merged === true,
    );
    return [{ job, facts, outcome: loadOutcome(root, job.id), auto }];
  });

// Every job that opened a pull request, with its outcome fetched again when it may have
// changed: always for the jobs force selects, otherwise at most hourly.
export function refreshOutcomes(
  root: string,
  baseBranch: string,
  windowDays: number,
  {
    force = () => false,
    now = new Date(),
    required = [],
  }: { force?: (entry: Tracked) => boolean; now?: Date; required?: string[] } = {},
): Tracked[] {
  const tracked = trackedJobs(root);
  const due = (entry: Tracked) =>
    force(entry) ||
    now.getTime() -
      Math.max(
        entry.outcome ? Date.parse(entry.outcome.checkedAt) : 0,
        failed.get(failKey(root, entry)) ?? 0,
      ) >=
      REFRESH_MS;
  const stale = tracked.filter((entry) => !entry.outcome?.final && due(entry));
  if (!stale.length) return tracked;
  const base = baseRef(root, baseBranch);
  const others = new Set(
    tracked.flatMap(({ outcome }) => (outcome?.mergeCommit ? [outcome.mergeCommit] : [])),
  );
  for (const entry of stale) {
    const outcome = fetchOutcome(root, entry, { base, windowDays, others, now, required });
    if (!outcome) {
      failed.set(failKey(root, entry), now.getTime());
      continue;
    }
    failed.delete(failKey(root, entry));
    saveOutcome(root, entry.job.id, outcome);
    entry.outcome = outcome;
  }
  return tracked;
}

export const humanEdited = (outcome: Outcome) =>
  outcome.humanCommits > 0 || outcome.followUps.length > 0;

// A class's record before a moment: pull requests a person merged whose follow-up window
// had closed by then, the share of them no human edited, and reverts within the window.
// Auto-merged ones do not count, so the rule never vouches for itself.
export function trackRecord(tracked: Tracked[], name: string, before: number, windowDays: number) {
  const merged = tracked.filter(
    ({ facts, outcome, auto }) =>
      facts.class === name &&
      !auto &&
      outcome?.state === 'MERGED' &&
      outcome.mergedAt &&
      Date.parse(outcome.mergedAt) + FOLLOW_UP_DAYS * DAY < before,
  );
  const clean = merged.filter(({ outcome }) => !humanEdited(outcome!)).length;
  const reverts = tracked.filter(({ facts, outcome }) => {
    if (facts.class !== name || !outcome?.revertedAt) return false;
    const at = Date.parse(outcome.revertedAt);
    return at < before && at >= before - windowDays * DAY;
  }).length;
  return {
    merged: merged.length,
    cleanRate: merged.length ? Math.round((clean / merged.length) * 1000) / 10 : null,
    reverts,
  };
}

// Why a pull request may not merge by itself; an empty list means it may. live adds what
// only matters for an open pull request: draft state and commits a human pushed.
export function blockers(
  entry: Tracked,
  tracked: Tracked[],
  config: AutoMergeConfig,
  at: number,
  live: boolean,
) {
  const { facts, outcome } = entry;
  const reasons: string[] = [];
  if (!facts.class) reasons.push('its files fit no change class');
  if (facts.risky) reasons.push('it touches a risk path');
  if (!facts.firstTry) reasons.push('it needed a fix pass or a second review round');
  if (facts.lines > config.maxLines) {
    reasons.push(`it changes ${facts.lines} lines, more than ${config.maxLines}`);
  }
  if (!facts.head) reasons.push('the runner recorded no commit for it');
  if (facts.holdoutFailed) reasons.push('a holdout check failed');
  // A retro changes guidance every later agent and reviewer follows.
  if (entry.job.scope) reasons.push('it is a retro job, which a person merges');
  if (outcome?.objection) reasons.push(outcome.objection);
  if (outcome?.ci !== 'green') reasons.push(`its CI is ${outcome?.ci ?? 'unknown'}, not green`);
  if (live && outcome?.draft) reasons.push('it is a draft');
  if (live && outcome && outcome.head !== facts.head)
    reasons.push('its head is not the factory commit');
  if (facts.class) {
    const record = trackRecord(tracked, facts.class, at, config.windowDays);
    if (record.merged < config.minPrs) {
      reasons.push(
        `class ${facts.class} has ${record.merged} merged pull requests, fewer than ${config.minPrs}`,
      );
    } else if ((record.cleanRate ?? 0) < config.minCleanRate) {
      reasons.push(
        `class ${facts.class} merged ${record.cleanRate}% without human edits, under ${config.minCleanRate}%`,
      );
    }
    if (record.reverts) {
      reasons.push(
        `class ${facts.class} had ${record.reverts} revert(s) in ${config.windowDays} days`,
      );
    }
  }
  return reasons;
}

// Human edits after merge, per class: the factory's measure of how often a person had to
// finish or fix what it shipped.
export function classRates(tracked: Tracked[]) {
  const rates: Record<
    string,
    { merged: number; humanEdited: number; rate: number | null; reverted: number }
  > = {};
  for (const { facts, outcome } of tracked) {
    if (outcome?.state !== 'MERGED') continue;
    const row = (rates[facts.class ?? 'unclassified'] ??= {
      merged: 0,
      humanEdited: 0,
      rate: null,
      reverted: 0,
    });
    row.merged++;
    if (humanEdited(outcome)) row.humanEdited++;
    if (outcome.revertedAt) row.reverted++;
  }
  for (const row of Object.values(rates)) {
    row.rate = Math.round((row.humanEdited / row.merged) * 1000) / 10;
  }
  return rates;
}

// The dry run: which merged pull requests would have merged by themselves when they did,
// and which open ones would now.
export function autoMergeReport(
  root: string,
  baseBranch: string,
  config: AutoMergeConfig,
  now = new Date(),
) {
  const tracked = refreshOutcomes(root, baseBranch, config.windowDays, {
    force: () => true,
    now,
    required: config.requiredChecks,
  });
  const row = (entry: Tracked, at: number, live: boolean) => {
    const reasons = blockers(entry, tracked, config, at, live);
    return {
      job: entry.job.id,
      pr: entry.job.pr,
      class: entry.facts.class,
      qualifies: !reasons.length,
      reasons,
    };
  };
  return {
    enabled: config.enabled,
    merged: tracked
      .filter(({ outcome }) => outcome?.state === 'MERGED' && outcome.mergedAt)
      .map((entry) => row(entry, Date.parse(entry.outcome!.mergedAt!), false)),
    open: tracked
      .filter(({ outcome }) => outcome?.state === 'OPEN')
      .map((entry) => row(entry, now.getTime(), true)),
    classes: classRates(tracked),
  };
}

// Merges open pull requests that qualify, when the configuration and the repository's
// FACTORY_AUTOMERGE variable both allow it. Any doubt leaves the pull request to a human.
export function autoMerge(
  root: string,
  baseBranch: string,
  config: AutoMergeConfig,
  now = new Date(),
) {
  if (!config.enabled) return [];
  // Only open pull requests that could qualify are fetched again on every pass.
  // A merge GitHub refused waits an hour before the next try.
  const refusedLately = (id: string) =>
    jobEvents(root, id).some(
      (event) =>
        event.event === 'auto-merge' &&
        event.merged === false &&
        now.getTime() - Date.parse(event.at) < REFRESH_MS,
    );
  const candidate = ({ job, facts, outcome }: Tracked) =>
    job.stage === 'pr-open' &&
    !job.scope &&
    !facts.holdoutFailed &&
    !refusedLately(job.id) &&
    outcome?.state !== 'MERGED' &&
    outcome?.state !== 'CLOSED' &&
    Boolean(facts.class) &&
    !facts.risky &&
    facts.firstTry &&
    facts.lines <= config.maxLines;
  const required = config.requiredChecks;
  if (!refreshOutcomes(root, baseBranch, config.windowDays, { now, required }).some(candidate)) {
    return [];
  }
  const kill = gh(root, ['variable', 'get', 'FACTORY_AUTOMERGE']);
  if (kill.status !== 0 || kill.stdout.trim() !== 'on') return [];
  const tracked = refreshOutcomes(root, baseBranch, config.windowDays, {
    force: candidate,
    now,
    required,
  });
  const merged: string[] = [];
  for (const entry of tracked.filter(candidate)) {
    // Only what this pass fetched: a cached copy could miss a review or a draft since.
    if (entry.outcome?.state !== 'OPEN' || entry.outcome.checkedAt !== now.toISOString()) {
      continue;
    }
    if (blockers(entry, tracked, config, now.getTime(), true).length) continue;
    // A stop label on the issue is a person's no as well.
    if (entry.job.issue) {
      const issue = gh(root, ['issue', 'view', String(entry.job.issue.number), '--json', 'labels']);
      if (issue.status !== 0) continue;
      const labels = (JSON.parse(issue.stdout) as { labels: { name: string }[] }).labels;
      if (labels.some((label) => label.name === 'factory:stop')) continue;
    }
    // The head must still be the commit the factory gated and reviewed.
    const run = gh(root, [
      'pr',
      'merge',
      entry.job.pr!,
      '--squash',
      '--match-head-commit',
      entry.facts.head!,
    ]);
    recordEvent(root, entry.job.id, 'auto-merge', {
      merged: run.status === 0,
      detail: run.status === 0 ? null : run.stderr.trim().slice(-500),
    });
    if (run.status === 0) merged.push(entry.job.id);
  }
  return merged;
}
