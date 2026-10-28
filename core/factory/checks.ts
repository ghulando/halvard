import type { FactoryJob, HoldoutCheck, ReviewRecord } from '../types.ts';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { eligibleReviewers, reviewerSettings } from '../flow-config.ts';
import { reviewCommand } from '../workflow/review.ts';
import { digest, fingerprint } from '../state.ts';
import { runChild, scrubbedEnv } from './harness.ts';
import { exec, type HoldoutResult } from './ship.ts';
import { boxed, ghShield, isolated } from './isolation.ts';
import { jobFile, recordEvent, saveJob } from './store.ts';
import type { Context } from './context.ts';
import { Parked, checkHalted, childFailed, stopAsked } from './jobs.ts';
import { GATE_TIMEOUT_MS, HOLDOUT_TIMEOUT_MS, runnerChild, dockerFailed } from './runs.ts';
import type { Checkout } from './checkout.ts';

// Whether a sampled check runs for this job; a retry of the job gets the same answer.
export const sampled = (id: string, check: HoldoutCheck) =>
  check.sample >= 1 || parseInt(digest([id, check.name]).slice(0, 8), 16) / 2 ** 32 < check.sample;

// Holdout checks run after the gate passes, with the scenarios folder mounted read-only for
// that step only. Their output stays in the job folder: a fix pass never shows it to the
// builder, so a failed blocking check parks the job instead.
export async function holdouts(
  ctx: Context,
  job: FactoryJob,
  worktree: string,
  base: string,
): Promise<HoldoutResult[]> {
  const results: HoldoutResult[] = [];
  const checks = ctx.factory.holdout.filter((check) => sampled(job.id, check));
  if (!checks.length) return results;
  const log = jobFile(ctx.root, job.id, 'holdout.log');
  const tree = isolated(ctx, () => fingerprint(worktree));
  for (const check of checks) {
    checkHalted(ctx, job);
    if (!existsSync(check.dir)) {
      throw new Parked('infra', `holdout ${check.name}: ${check.dir} does not exist`);
    }
    const scratch = jobFile(ctx.root, job.id, 'holdout-tmp');
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const extra = { HALVARD_HOLDOUT_DIR: check.dir, HALVARD_FACTORY_BASE: base, TMPDIR: scratch };
    // The check runs code the builder wrote: a writable checkout or extra mount would let it
    // copy the scenarios where the next fix pass reads them, and a network would let it send
    // them away.
    const config = ctx.factory.container;
    const sealed = config
      ? {
          ...ctx,
          factory: {
            ...ctx.factory,
            container: {
              ...config,
              network: 'none',
              mounts: config.mounts.map((mount) => ({ ...mount, readonly: true })),
            },
          },
        }
      : ctx;
    const { argv, cleanup } = boxed(sealed, job, `holdout-${check.name}`, check.command, {
      workdir: worktree,
      mounts: [
        { path: worktree, readonly: true },
        { path: check.dir, readonly: true },
        { path: scratch, readonly: false },
      ],
      env: Object.keys(extra),
    });
    const run = await runChild(argv, {
      cwd: worktree,
      env: scrubbedEnv(ghShield(ctx, job), extra),
      timeoutMs: HOLDOUT_TIMEOUT_MS,
      log,
      cleanup,
      shouldStop: stopAsked(ctx, job),
    });
    rmSync(scratch, { recursive: true, force: true });
    const passed = run.status === 0;
    recordEvent(ctx.root, job.id, 'holdout', { name: check.name, passed });
    if (!passed) {
      checkHalted(ctx, job);
      if (dockerFailed(ctx, run)) {
        throw new Parked('infra', `the holdout ${check.name} container did not run`);
      }
    }
    // The gate's receipt and the review cover this tree; a check may not change it.
    if (isolated(ctx, () => fingerprint(worktree)) !== tree) {
      throw new Parked(
        'infra',
        `holdout ${check.name} changed the checkout; a check writes only to $TMPDIR`,
      );
    }
    results.push({ name: check.name, passed, blocking: check.blocking });
    if (!passed && check.blocking) {
      throw new Parked(
        'holdout-failed',
        `holdout check ${check.name} failed; its output is in ${log}. The builder never sees it.`,
      );
    }
  }
  return results;
}

const reviewers = new Map<string, boolean>();

// A reviewer counts when its CLI answers where the review runs: here, or in the image.
function available(reviewer: string, ctx: Context) {
  const settings = reviewerSettings(ctx.project.config.workflow, ctx.factory.author, reviewer);
  if (!settings) return false;
  const binary = reviewCommand(reviewer, settings, '', '')[0]!;
  const config = ctx.factory.container;
  if (!config) return exec(binary, ['--version'], ctx.root, 10000).status === 0;
  const key = `${config.image}\0${binary}`;
  if (!reviewers.has(key)) {
    const run = exec(
      'docker',
      ['run', '--rm', '--network', 'none', config.image, binary, '--version'],
      ctx.root,
      120000,
    );
    // Only an answer is remembered; a failed check is tried again next time.
    if (run.status !== 0) return false;
    reviewers.set(key, true);
  }
  return true;
}

// Round 1 takes the first configured reviewer that answers; later rounds must keep it.
function chooseReviewer(ctx: Context, job: FactoryJob) {
  const eligible = eligibleReviewers(ctx.project.config.workflow, job.author);
  if (job.reviewer) return available(job.reviewer, ctx) ? job.reviewer : null;
  const order = ctx.factory.reviewers.length
    ? ctx.factory.reviewers.filter((name) => eligible.includes(name))
    : eligible;
  return order.find((name) => available(name, ctx)) ?? null;
}

// The runner's own gate on the agent's tree. Returns the output's tail when the gate failed.
export async function gate(ctx: Context, job: FactoryJob, run: Checkout, key: string) {
  job.stage = 'gating';
  saveJob(ctx.root, job);
  const result = await runnerChild(ctx, job, run.worktree, ['gate', key], GATE_TIMEOUT_MS);
  const output = (result.stdout + result.stderr).trim().split('\n');
  recordEvent(ctx.root, job.id, 'gate', {
    passed: result.status === 0,
    ...(result.status === 0 ? {} : { tail: output.slice(-15).join('\n').slice(-1500) }),
  });
  if (result.status === 0) return null;
  // A stop ends the gate's process; that is the stop, not a failure of the gate.
  checkHalted(ctx, job);
  if (dockerFailed(ctx, result)) {
    throw new Parked(
      'infra',
      `the gate container did not run: ${result.stderr.trim().slice(-2000)}`,
    );
  }
  return output.slice(-60).join('\n');
}

export async function review(ctx: Context, job: FactoryJob, run: Checkout, key: string) {
  checkHalted(ctx, job);
  job.stage = 'reviewing';
  const reviewer = chooseReviewer(ctx, job);
  if (!reviewer) {
    throw new Parked(
      'reviewer-unavailable',
      job.reviewer
        ? `${job.reviewer} reviewed round ${job.round} and does not answer; a later round must use the same reviewer`
        : 'no eligible reviewer CLI answers --version',
    );
  }
  job.reviewer = reviewer;
  job.round++;
  saveJob(ctx.root, job);
  const result = await runnerChild(
    ctx,
    job,
    run.worktree,
    [
      'review',
      run.task,
      '--author',
      job.author,
      '--reviewer',
      reviewer,
      '--round',
      String(job.round),
      '--gate-session',
      key,
    ],
    (ctx.project.config.workflow.reviewTimeout + 120) * 1000,
  );
  // Exit status 2 is a blocked verdict, not a failure.
  if (result.status !== 0 && result.status !== 2) {
    childFailed(ctx, job, `review round ${job.round} failed: ${result.stderr.trim().slice(-2000)}`);
  }
  const record = JSON.parse(result.stdout) as ReviewRecord;
  recordEvent(ctx.root, job.id, 'review', {
    reviewer,
    round: job.round,
    verdict: record.verdict,
    findings: record.findings.length,
    // What the retro reads: each finding, short.
    items: record.findings.map((finding) => ({
      severity: finding.severity,
      location: finding.location.slice(0, 200),
      problem: finding.problem.slice(0, 400),
    })),
  });
  return record;
}
