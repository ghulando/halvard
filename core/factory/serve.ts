import type { FactoryJob } from './store.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { gh } from './ship.ts';
import { jobFile, listJobs, loadJob, lockHolder, lockJob, lockServe, repoHome } from './store.ts';
import { monthSpend, writeBoard } from './board.ts';
import { autoMerge, refreshOutcomes } from './outcomes.ts';
import { retroDue, retroSource } from './retro.ts';
import { issueSource, labeledBy } from './github.ts';
import { say, stopRequested, type Context } from './context.ts';
import { ACTIVE, blocker, newJob, park } from './jobs.ts';
import { approval, plan, replan } from './plan.ts';
import { build } from './build.ts';

const WAITING = ['planning', 'awaiting-approval', 'approved'];

function underBudget(ctx: Context) {
  const spent = monthSpend(ctx.root);
  if (spent < 0.9 * ctx.factory.monthlyUsd) return true;
  say(`spent $${spent.toFixed(2)} of $${ctx.factory.monthlyUsd} this month; starting no work`);
  return false;
}

// One job step at a time, so a failure in one job never stops the daemon.
async function step(ctx: Context, what: string, action: () => Promise<unknown> | unknown) {
  if (stopRequested()) return false;
  try {
    await action();
  } catch (err) {
    say(`${what}: ${(err as Error).message}`);
  }
  try {
    writeBoard(ctx.root);
  } catch (err) {
    say(`board: ${(err as Error).message}`);
  }
  return !stopRequested();
}

// The job read afresh under its lock, so the daemon never writes over a change made since it
// listed the jobs. Null when a runner holds the job.
function underLock<T>(ctx: Context, id: string, action: (job: FactoryJob) => T): T | null {
  let unlock: () => void;
  try {
    unlock = lockJob(ctx.root, id);
  } catch {
    return null;
  }
  try {
    return action(loadJob(ctx.root, id));
  } finally {
    unlock();
  }
}

const runnerAlive = (ctx: Context, id: string) =>
  lockHolder(jobFile(ctx.root, id, 'runner.lock')) !== null;

const labels = (issue: { labels: { name: string }[] }) => issue.labels.map((label) => label.name);

// Up to size jobs run side by side; the daemon still decides about one job at a time.
function pool(size: number) {
  const running = new Set<Promise<unknown>>();
  const free = async () => {
    while (running.size >= size) await Promise.race(running);
  };
  return {
    // Wait for a free slot before checking the budget, so a finished job's spend counts.
    free,
    async start(task: () => Promise<unknown>) {
      await free();
      const promise: Promise<unknown> = task().finally(() => running.delete(promise));
      running.add(promise);
    },
    drain: () => Promise.all(running),
  };
}

export async function cycle(ctx: Context) {
  const jobs = pool(ctx.factory.concurrency);
  try {
    await decide(ctx, jobs);
  } finally {
    await jobs.drain();
  }
}

type Pool = ReturnType<typeof pool>;

// One pass: act on the labels of known jobs, follow up on opened pull requests, start a due
// retro, then claim new issues.
async function decide(ctx: Context, jobs: Pool) {
  // A tampered run or an unreadable job file needs a human before anything starts.
  const blocked = blocker(ctx.root);
  if (blocked) {
    say(`${blocked}; starting nothing until you check it`);
    return;
  }
  for (const job of listJobs(ctx.root)) {
    if (job.issue && !(await followLabels(ctx, jobs, job, job.issue.number))) return;
  }
  followPullRequests(ctx);
  if (stopRequested()) return;
  if (!(await startRetro(ctx, jobs))) return;
  await claimIssues(ctx, jobs);
}

// When a factory:retry label counts from: the moment the job parked, or the last write of a
// runner that died mid-run. Null when the job is not waiting for a retry.
function retrySince(ctx: Context, job: FactoryJob) {
  if (job.stage === 'parked') return job.parked?.at ?? null;
  if ([...ACTIVE, 'planning'].includes(job.stage) && !runnerAlive(ctx, job.id)) return job.updated;
  return null;
}

// A stop label parks a waiting job, a retry label restarts a parked or dead one, and an
// approval builds. A running job checks for the stop label itself at its next step. False
// when the pass must end.
async function followLabels(ctx: Context, jobs: Pool, listed: FactoryJob, issue: number) {
  const { id } = listed;
  if (WAITING.includes(listed.stage) && labeledBy(ctx, issue, 'factory:stop', null)) {
    return step(ctx, id, () =>
      underLock(ctx, id, (job) =>
        WAITING.includes(job.stage)
          ? park(ctx, job, 'stopped-by-human', 'the issue is labeled factory:stop')
          : null,
      ),
    );
  }
  const since = retrySince(ctx, listed);
  if (since && labeledBy(ctx, issue, 'factory:retry', since)) {
    await jobs.free();
    if (!underBudget(ctx)) return true;
    gh(ctx.root, [
      'issue',
      'edit',
      String(issue),
      '--remove-label',
      'factory:retry',
      '--remove-label',
      'factory:parked',
    ]);
    if (stopRequested()) return false;
    await jobs.start(() =>
      step(ctx, id, () =>
        listed.small || listed.plan?.approvedBy
          ? build(ctx, id, true, { retry: true })
          : replan(ctx, id),
      ),
    );
    return true;
  }
  // An approved job builds, whether its label came now or it was approved and never built.
  if (['awaiting-approval', 'approved'].includes(listed.stage) && !runnerAlive(ctx, id)) {
    await jobs.free();
    if (!underBudget(ctx)) return true;
    let ready = false;
    const go = await step(ctx, id, () => {
      ready =
        underLock(
          ctx,
          id,
          (job) =>
            job.stage === 'approved' || (job.stage === 'awaiting-approval' && approval(ctx, job)),
        ) ?? false;
    });
    if (!go) return false;
    if (ready) await jobs.start(() => step(ctx, id, () => build(ctx, id, true)));
  }
  return true;
}

// Outcomes of opened pull requests feed the metrics and auto-merge; a GitHub failure here
// never stops the daemon from working issues.
function followPullRequests(ctx: Context) {
  const { baseBranch } = ctx.project.config.workflow;
  try {
    for (const id of autoMerge(ctx.root, baseBranch, ctx.factory.autoMerge)) {
      say(`${id}: merged by auto-merge`);
    }
    refreshOutcomes(ctx.root, baseBranch, ctx.factory.autoMerge.windowDays, {
      required: ctx.factory.autoMerge.requiredChecks,
    });
  } catch (err) {
    say(`outcomes: ${(err as Error).message}`);
  }
}

// A retro is due once a period has passed and findings recur in at least two jobs. False
// when the pass must end.
async function startRetro(ctx: Context, jobs: Pool) {
  const now = new Date();
  if (!retroDue(ctx, now)) return true;
  const { source: retro } = retroSource(ctx, now);
  if (!retro) return true;
  await jobs.free();
  if (!underBudget(ctx) || stopRequested()) return false;
  let job: FactoryJob;
  try {
    job = newJob(ctx, retro, true, false);
  } catch (err) {
    say(`retro: ${(err as Error).message}`);
    return true;
  }
  const id = job.id;
  await jobs.start(() => step(ctx, id, () => build(ctx, id, true)));
  return true;
}

// Open issues labeled factory that no job holds yet, priority:high first, then oldest first.
function newIssues(ctx: Context) {
  // Oldest first, so priority and issue order hold across more open issues than one page.
  const list = gh(ctx.root, [
    'issue',
    'list',
    '--label',
    'factory',
    '--state',
    'open',
    '--search',
    'sort:created-asc',
    '--limit',
    '200',
    '--json',
    'number,labels',
  ]);
  if (list.status !== 0) {
    say(`gh issue list failed: ${list.stderr.trim()}`);
    return [];
  }
  const claimed = new Set(
    listJobs(ctx.root).flatMap((job) => (job.issue ? [job.issue.number] : [])),
  );
  return (JSON.parse(list.stdout) as { number: number; labels: { name: string }[] }[])
    .filter((issue) => !labels(issue).includes('factory:stop') && !claimed.has(issue.number))
    .sort(
      (a, b) =>
        Number(labels(b).includes('priority:high')) - Number(labels(a).includes('priority:high')) ||
        a.number - b.number,
    );
}

async function claimIssues(ctx: Context, jobs: Pool) {
  for (const issue of newIssues(ctx)) {
    // Only someone with write access puts an issue into the factory or skips its plan.
    if (!labeledBy(ctx, issue.number, 'factory', null)) continue;
    if (existsSync(join(repoHome(ctx.root), 'jobs', `issue-${issue.number}`))) {
      say(`issue #${issue.number}: a job folder issue-${issue.number} holds other work; skipped`);
      continue;
    }
    await jobs.free();
    if (!underBudget(ctx)) return;
    const small =
      labels(issue).includes('factory:small') &&
      labeledBy(ctx, issue.number, 'factory:small', null) !== null;
    if (stopRequested()) return;
    // The job exists before the next issue is considered; the work itself runs in the pool.
    let job: FactoryJob;
    try {
      job = newJob(ctx, issueSource(ctx, issue.number), small, labels(issue).includes('bug'));
    } catch (err) {
      say(`issue #${issue.number}: ${(err as Error).message}`);
      continue;
    }
    await jobs.start(() =>
      step(ctx, job.id, () => (small ? build(ctx, job.id, true) : plan(ctx, job))),
    );
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const started = Date.now();
    const tick = setInterval(() => {
      if (stopRequested() || Date.now() - started >= ms) {
        clearInterval(tick);
        resolve();
      }
    }, 1000);
  });

// Polls until stopped. Ctrl-C or SIGTERM lets the current step park its job and exits.
export async function serve(ctx: Context, { once }: { once: boolean }) {
  const unlock = lockServe(ctx.root);
  try {
    say(`serving ${ctx.root}; board at ${writeBoard(ctx.root)}`);
    for (;;) {
      // A pass that fails, from GitHub or a broken file, is logged and tried again later.
      try {
        await cycle(ctx);
        writeBoard(ctx.root);
      } catch (err) {
        say(`pass failed: ${(err as Error).message}`);
      }
      if (once || stopRequested()) break;
      await sleep(ctx.factory.pollSeconds * 1000);
      if (stopRequested()) break;
    }
  } finally {
    unlock();
  }
}
