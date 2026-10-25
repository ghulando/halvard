import type { FactoryJob } from './types.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { gh } from './factory-ship.ts';
import {
  jobFile,
  listJobs,
  loadJob,
  lockHolder,
  lockJob,
  lockServe,
  repoHome,
} from './factory-store.ts';
import { monthSpend, writeBoard } from './factory-board.ts';
import {
  type Context,
  ACTIVE,
  approval,
  blocker,
  build,
  issueSource,
  labeledBy,
  newJob,
  park,
  plan,
  replan,
  say,
  stopRequested,
} from './factory.ts';

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

async function decide(ctx: Context, jobs: ReturnType<typeof pool>) {
  // A tampered run or an unreadable job file needs a human before anything starts.
  const blocked = blocker(ctx.root);
  if (blocked) {
    say(`${blocked}; starting nothing until you check it`);
    return;
  }

  for (const listed of listJobs(ctx.root)) {
    if (!listed.issue) continue;
    const { id } = listed;
    const issue = listed.issue.number;
    // A stop label parks a job that is waiting; a running job stops itself at its next step.
    if (WAITING.includes(listed.stage) && labeledBy(ctx, issue, 'factory:stop', null)) {
      const go = await step(ctx, id, () =>
        underLock(ctx, id, (job) =>
          WAITING.includes(job.stage)
            ? park(ctx, job, 'stopped-by-human', 'the issue is labeled factory:stop')
            : null,
        ),
      );
      if (!go) return;
      continue;
    }
    // A retry label restarts a parked job, or one whose runner died mid-run.
    const since =
      listed.stage === 'parked'
        ? (listed.parked?.at ?? null)
        : [...ACTIVE, 'planning'].includes(listed.stage) && !runnerAlive(ctx, id)
          ? listed.updated
          : null;
    if (since && labeledBy(ctx, issue, 'factory:retry', since)) {
      await jobs.free();
      if (!underBudget(ctx)) continue;
      gh(ctx.root, [
        'issue',
        'edit',
        String(issue),
        '--remove-label',
        'factory:retry',
        '--remove-label',
        'factory:parked',
      ]);
      if (stopRequested()) return;
      await jobs.start(() =>
        step(ctx, id, () =>
          listed.small || listed.plan?.approvedBy
            ? build(ctx, id, true, { retry: true })
            : replan(ctx, id),
        ),
      );
      continue;
    }
    // An approved job builds, whether its label came now or it was approved and never built.
    if (['awaiting-approval', 'approved'].includes(listed.stage) && !runnerAlive(ctx, id)) {
      await jobs.free();
      if (!underBudget(ctx)) continue;
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
      if (!go) return;
      if (ready) await jobs.start(() => step(ctx, id, () => build(ctx, id, true)));
    }
  }

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
    return;
  }
  const claimed = new Set(
    listJobs(ctx.root).flatMap((job) => (job.issue ? [job.issue.number] : [])),
  );
  const issues = (JSON.parse(list.stdout) as { number: number; labels: { name: string }[] }[])
    .filter((issue) => !labels(issue).includes('factory:stop') && !claimed.has(issue.number))
    .sort(
      (a, b) =>
        Number(labels(b).includes('priority:high')) - Number(labels(a).includes('priority:high')) ||
        a.number - b.number,
    );
  for (const issue of issues) {
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
