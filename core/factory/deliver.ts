import type { FactoryJob } from './store.ts';
import type { ReviewRecord } from '../types.ts';
import { writeFileSync } from 'node:fs';
import { completeTask } from '../workflow/complete.ts';
import { fingerprint } from '../state.ts';
import {
  changedFiles,
  evidenceMarkdown,
  exec,
  gh,
  gitRunner,
  hasOrigin,
  riskLevel,
  type HoldoutResult,
} from './ship.ts';
import { changeClass } from './outcomes.ts';
import { isolated, nestedRepo, unsafeGitDir } from './isolation.ts';
import {
  jobEvents,
  jobFile,
  loadJob,
  lockJob,
  recordEvent,
  saveJob,
  worktreePath,
} from './store.ts';
import { say, type Context } from './context.ts';
import { Parked, childFailed } from './jobs.ts';
import { TASK_DONE_TIMEOUT_MS, PUSH_TIMEOUT_MS, runnerChild } from './runs.ts';
import { latestBase, checkScope, type Checkout } from './checkout.ts';

export async function ship(
  ctx: Context,
  job: FactoryJob,
  run: Checkout,
  {
    key,
    record,
    push,
    holdout,
  }: { key: string; record: ReviewRecord; push: boolean; holdout: HoldoutResult[] },
) {
  const { worktree, task } = run;
  // A clone knows the base only by the name it fetched it under.
  const base = ctx.factory.container ? 'refs/factory/base' : run.base;
  job.stage = 'shipping';
  saveJob(ctx.root, job);
  // task-done reads the receipts where the gate and review wrote them, here or in a
  // container, with the plan digest the runner holds.
  const finished = await runnerChild(
    ctx,
    job,
    worktree,
    ['task-done', task, '--gate-session', key, '--plan', run.plan ?? 'none'],
    TASK_DONE_TIMEOUT_MS,
  );
  if (finished.status !== 0) {
    childFailed(ctx, job, `task-done failed: ${finished.stderr.trim().slice(-2000)}`);
  }
  const done = JSON.parse(finished.stdout) as Awaited<ReturnType<typeof completeTask>>;
  const gate = done.gate;
  if (!gate) throw new Error('the gate receipt disappeared before shipping');
  const files = isolated(ctx, () => changedFiles(worktree, base));
  const risk = riskLevel(files, ctx.factory.riskPaths);
  // The gate and the holdout checks ran after the last check of the scope.
  checkScope(ctx, job, worktree, base, task);
  // Only the reviewed tree plus the status line goes into the commit.
  const unsafe = ctx.factory.container
    ? (unsafeGitDir(worktree) ?? nestedRepo(ctx, worktree))
    : null;
  if (unsafe) throw new Parked('tampered', unsafe);
  if (isolated(ctx, () => fingerprint(worktree)) !== done.final) {
    throw new Parked('tampered', 'the tree changed after the review');
  }
  // The same configuration as the fingerprint, so the commit holds exactly the reviewed tree.
  isolated(ctx, () => gitRunner(worktree, ['add', '--all']));
  gitRunner(worktree, [
    'commit',
    '--quiet',
    '-m',
    job.title,
    '-m',
    `Halvard factory job ${job.id}.${job.issue ? ` Refs #${job.issue.number}.` : ''}`,
  ]);
  if (
    isolated(ctx, () =>
      gitRunner(worktree, ['status', '--porcelain', '--ignore-submodules=all']),
    ).trim()
  ) {
    throw new Parked('tampered', 'files changed while the runner committed');
  }
  const latest = latestBase(ctx, worktree, base);
  const merge = exec('git', ['merge-tree', '--write-tree', latest, 'HEAD'], worktree);
  if (merge.status !== 0) {
    throw new Parked(
      'conflict',
      `the branch conflicts with ${latest}:\n${merge.stdout.trim().slice(-2000)}`,
    );
  }
  // The task file is the workflow's own record; the class and size are of the change itself.
  const changed = files.filter((file) => file !== task);
  const lines = gitRunner(worktree, ['diff', '--numstat', '--no-renames', '-z', base, 'HEAD', '--'])
    .split('\0')
    .reduce((sum, entry) => {
      const [added, deleted, path] = entry.split('\t');
      // A binary file counts as large, so a class never merges one by itself.
      if (path === task || !path) return sum;
      return sum + (added === '-' ? Infinity : Number(added) + Number(deleted));
    }, 0);
  const change = {
    class: changeClass(changed, ctx.factory.autoMerge.classes),
    lines,
    firstTry: job.fixPasses === 0 && record.round === 1,
  };
  const evidence = jobFile(ctx.root, job.id, 'evidence.md');
  const body = evidenceMarkdown({
    job,
    base,
    gate,
    review: record,
    files,
    diffStat: gitRunner(worktree, ['diff', '--stat', base, 'HEAD']),
    risk,
    holdout,
    change,
  });
  writeFileSync(evidence, body, { mode: 0o600 });
  writeFileSync(
    jobFile(ctx.root, job.id, 'evidence.json'),
    JSON.stringify({ done, gate, review: record, files, risk, holdout, change }, null, 2) + '\n',
    { mode: 0o600 },
  );
  recordEvent(ctx.root, job.id, 'committed', {
    tree: done.tree,
    risk: risk.level,
    head: gitRunner(worktree, ['rev-parse', 'HEAD']).trim(),
    files: changed,
    holdoutFailed: holdout.some((check) => !check.passed),
    ...change,
    lines: Number.isFinite(lines) ? lines : null,
  });
  // The push URL was read before any agent ran; without an origin there is none.
  if (!push || !run.pushUrl) {
    job.stage = 'committed';
    saveJob(ctx.root, job);
    say(`${job.id}: committed on ${job.branch} in ${worktree}; not pushed`);
    return job;
  }
  gitRunner(
    worktree,
    ['push', '--quiet', run.pushUrl, `HEAD:refs/heads/${job.branch}`],
    PUSH_TIMEOUT_MS,
  );
  return openPullRequest(ctx, job, risk.level === 'high');
}

// Opens the job's pull request with its evidence as the body.
function openPullRequest(ctx: Context, job: FactoryJob, highRisk: boolean) {
  const createPr = (labels: string[]) =>
    gh(ctx.root, [
      'pr',
      'create',
      '--base',
      ctx.project.config.workflow.baseBranch,
      '--head',
      job.branch!,
      '--title',
      job.title,
      '--body-file',
      jobFile(ctx.root, job.id, 'evidence.md'),
      ...(ctx.factory.draft ? ['--draft'] : []),
      ...labels,
    ]);
  let pr = createPr(highRisk ? ['--label', 'risk:high'] : []);
  // The label may not exist in the repository; the risk stays in the body.
  if (pr.status !== 0 && highRisk) pr = createPr([]);
  if (pr.status !== 0) throw new Error(`gh pr create failed: ${pr.stderr.trim()}`);
  job.pr = pr.stdout.trim();
  job.stage = 'pr-open';
  saveJob(ctx.root, job);
  recordEvent(ctx.root, job.id, 'pr', { url: job.pr });
  say(`${job.id}: opened ${job.pr}`);
  return job;
}

// Ships a job built with --no-push. Only the commit the runner gated, reviewed and recorded
// goes out, so the branch must still point at it. A failure leaves the job committed.
export function shipJob(ctx: Context, id: string) {
  const unlock = lockJob(ctx.root, id);
  try {
    const job = loadJob(ctx.root, id);
    if (job.stage !== 'committed') {
      throw new Error(`job ${id} is ${job.stage}; only a committed job ships`);
    }
    const committed = jobEvents(ctx.root, id)
      .filter((event) => event.event === 'committed')
      .at(-1);
    const head = typeof committed?.head === 'string' ? committed.head : null;
    if (!head || !job.branch) throw new Error(`job ${id} has no recorded commit to ship`);
    if (!hasOrigin(ctx.root)) throw new Error('the repository has no origin remote to push to');
    // The path comes from the job id, never from job.json.
    const checkout = worktreePath(ctx.root, id);
    const current = gitRunner(checkout, ['rev-parse', `refs/heads/${job.branch}`]).trim();
    if (current !== head) {
      throw new Error(
        `${job.branch} is at ${current.slice(0, 12)}, not the reviewed commit ${head.slice(0, 12)}; move the branch back to that commit to ship it, or push the branch yourself`,
      );
    }
    const pushUrl = exec('git', ['remote', 'get-url', '--push', 'origin'], ctx.root).stdout.trim();
    gitRunner(
      checkout,
      ['push', '--quiet', pushUrl, `${head}:refs/heads/${job.branch}`],
      PUSH_TIMEOUT_MS,
    );
    return openPullRequest(ctx, job, committed!.risk === 'high');
  } finally {
    unlock();
  }
}
