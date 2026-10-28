import type { FactoryConfig, FactoryJob } from '../types.ts';
import { randomUUID as uuid } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sessionKey } from '../state.ts';
import { runChild, scrubbedEnv } from './harness.ts';
import { changedFiles, exec } from './ship.ts';
import { boxed, checkoutMounts, ghShield, listedEnv } from './isolation.ts';
import { buildPrompt, testsPrompt } from './prompts.ts';
import { jobFile, loadJob, lockJob, recordEvent, saveJob, worktreePath } from './store.ts';
import type { Context } from './context.ts';
import { Parked, parkError, ACTIVE, checkHalted, childFailed, stopAsked, pinned } from './jobs.ts';
import { SETUP_TIMEOUT_MS, agent, checkAgentRun, checkReady } from './runs.ts';
import {
  branchName,
  testFiles,
  removeCheckout,
  checkScope,
  type Checkout,
  checkout,
  checkTampering,
} from './checkout.ts';
import { approval } from './plan.ts';
import { holdouts, gate, review } from './checks.ts';
import { ship } from './deliver.ts';

export async function build(
  ctx: Context,
  id: string,
  push: boolean,
  { retry = false, note = '' }: { retry?: boolean; note?: string } = {},
) {
  const unlock = lockJob(ctx.root, id);
  try {
    // Read the job under the lock, so a second runner cannot act on a stale copy.
    const job = loadJob(ctx.root, id);
    if (retry) reset(ctx, job);
    if (!approval(ctx, job)) {
      throw new Error(`job ${job.id} needs an approved plan first (stage ${job.stage})`);
    }
    if (job.stage !== 'approved') {
      throw new Error(`job ${job.id} is ${job.stage}, not ready to build`);
    }
    return await work(ctx, job, push, note);
  } finally {
    unlock();
  }
}

// A parked job, or one whose runner died mid-build, starts again from its brief and approved
// plan on a fresh worktree and branch. The caller holds the job's lock, so no runner is live.
function reset(ctx: Context, job: FactoryJob) {
  if (job.stage !== 'parked' && !ACTIVE.includes(job.stage)) {
    throw new Error(`only a parked or interrupted job can be retried; ${job.id} is ${job.stage}`);
  }
  if (!job.small && !job.plan?.approvedBy) {
    throw new Error(
      `job ${job.id} parked before its plan was approved; plan it again as a new job`,
    );
  }
  // Paths come from the job id, never from job.json, and the branch goes only when this job
  // created it, so a retry cannot remove anything of the user's.
  const branch = branchName(ctx, job);
  removeCheckout(ctx, worktreePath(ctx.root, job.id));
  // A clone's branch lives in the clone; a branch of that name here is yours.
  if (!ctx.factory.container && job.branch === branch) {
    exec('git', ['branch', '-D', branch], ctx.root);
  }
  Object.assign(job, {
    stage: 'approved',
    worktree: null,
    branch: null,
    task: null,
    reviewer: null,
    round: 0,
    fixPasses: 0,
    parked: null,
    tests: null,
  });
  rmSync(jobFile(ctx.root, job.id, 'stop'), { force: true });
  saveJob(ctx.root, job);
  recordEvent(ctx.root, job.id, 'retry');
}

async function work(context: Context, job: FactoryJob, push: boolean, rework: string) {
  let ctx = context;
  try {
    ctx = pinned(ctx);
    const run = checkout(ctx, job);
    await setup(ctx, job, run);
    // A scoped job, such as a retro, changes guidance, which acceptance tests do not cover.
    if (ctx.factory.tests && !job.scope) await writeTests(ctx, job, run, ctx.factory.tests);

    const frozen = job.tests
      ? `\nAcceptance tests in ${job.tests.dir}/ were written by another agent and are frozen: make them pass and never edit, move or delete them. If one is wrong, end with STATUS: BLOCKED and say which.\n`
      : '';
    // The human's note stays in every build prompt; gate and review notes replace each other.
    const human = rework
      ? `A human sent this job back with a note. Address it:\n\n${rework}\n`
      : '';
    let note = '';
    for (;;) {
      await buildPass(ctx, job, run, frozen + human + note);
      const key = sessionKey(run.worktree, 'factory', `${job.id}-${uuid()}`);
      const failure = await gate(ctx, job, run, key);
      if (failure !== null) {
        nextFixPass(ctx, job, 'gate-failed', failure);
        note = `This is fix pass ${job.fixPasses}. The runner's gate failed on your tree:\n\n${failure}`;
        continue;
      }
      const holdout = await holdouts(ctx, job, run.worktree, run.start);
      const record = await review(ctx, job, run, key);
      if (record.verdict !== 'pass') {
        const summary = join(run.workspace, `${job.reviewer}-review-round${job.round}.md`);
        const detail = `round ${job.round} by ${job.reviewer} is blocked; see ${summary}`;
        if (job.round >= 2) throw new Parked('review-blocked', detail);
        nextFixPass(ctx, job, 'review-blocked', detail);
        note = `This is fix pass ${job.fixPasses}. The independent review blocked the change. Fix every blocking and should-fix finding, record the fixes in the task notes, and rerun the gate:\n\n${readFileSync(summary, 'utf8')}`;
        continue;
      }
      checkTampering(ctx, job, run);
      checkHalted(ctx, job);
      // Awaited, so a failure while shipping parks the job like any other.
      return await ship(ctx, job, run, { key, record, push, holdout });
    }
  } catch (err) {
    return parkError(ctx, job, err);
  }
}

async function setup(ctx: Context, job: FactoryJob, run: Checkout) {
  for (const step of ctx.factory.setup) {
    const { argv, cleanup } = boxed(ctx, job, 'setup', step, {
      workdir: run.worktree,
      mounts: checkoutMounts(run.worktree),
      env: [],
    });
    const result = await runChild(argv, {
      cwd: run.worktree,
      env: { ...scrubbedEnv(ghShield(ctx, job)), ...listedEnv(ctx) },
      timeoutMs: SETUP_TIMEOUT_MS,
      log: jobFile(ctx.root, job.id, 'setup.log'),
      cleanup,
      shouldStop: stopAsked(ctx, job),
    });
    if (result.status !== 0) {
      childFailed(ctx, job, `setup step ${step.join(' ')} failed; see setup.log`);
    }
  }
  checkTampering(ctx, job, run);
}

// Another harness writes the acceptance tests first, inside their folder only. The runner
// records their digest, so the builder cannot change them unseen.
async function writeTests(
  ctx: Context,
  job: FactoryJob,
  run: Checkout,
  tests: NonNullable<FactoryConfig['tests']>,
) {
  checkHalted(ctx, job);
  const dir = `${tests.dir}/${job.id}`;
  job.stage = 'testing';
  saveJob(ctx.root, job);
  const taskBefore = readFileSync(join(run.worktree, run.task), 'utf8');
  const result = await agent(
    ctx,
    job,
    'build',
    run.worktree,
    run.workspace,
    testsPrompt(run.task, dir),
    tests.by,
  );
  checkAgentRun(ctx, job, result);
  checkReady(result);
  // task-start created the task file, so it is new on the branch but must be unchanged.
  const outside = changedFiles(run.worktree, run.start).filter(
    (file) =>
      !file.startsWith(`${dir}/`) &&
      (file !== run.task || readFileSync(join(run.worktree, run.task), 'utf8') !== taskBefore),
  );
  if (outside.length) {
    throw new Parked(
      'tampered',
      `the test writer changed files outside ${dir}: ${outside.join(', ')}`,
    );
  }
  let written: { files: string[]; digest: string };
  try {
    written = testFiles(run.worktree, dir);
  } catch (err) {
    throw new Parked('tampered', `the test writer left ${(err as Error).message}`);
  }
  if (!written.files.length) {
    throw new Parked('agent-blocked', `the test writer wrote no tests under ${dir}`);
  }
  job.tests = { dir, digest: written.digest };
  saveJob(ctx.root, job);
  recordEvent(ctx.root, job.id, 'tests', { by: tests.by, files: written.files });
  checkTampering(ctx, job, run);
}

async function buildPass(ctx: Context, job: FactoryJob, run: Checkout, note: string) {
  checkHalted(ctx, job);
  job.stage = 'building';
  saveJob(ctx.root, job);
  const result = await agent(
    ctx,
    job,
    'build',
    run.worktree,
    run.workspace,
    buildPrompt(run.task, note),
  );
  checkAgentRun(ctx, job, result);
  checkTampering(ctx, job, run);
  checkReady(result);
  checkScope(ctx, job, run.worktree, run.start, run.task);
}

// Counts a fix pass, or parks the job when none is left.
function nextFixPass(ctx: Context, job: FactoryJob, reason: string, detail: string) {
  if (job.fixPasses >= ctx.factory.maxFixPasses) throw new Parked(reason, detail);
  job.fixPasses++;
}
