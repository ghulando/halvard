import type { FactoryJob } from './store.ts';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { planDigest } from '../workflow/tasks.ts';
import { agentStatus } from './harness.ts';
import { baseRef, exec, gh } from './ship.ts';
import { labeledBy } from './github.ts';
import { planPrompt } from './prompts.ts';
import { jobFile, loadJob, lockJob, recordEvent, saveJob, worktreePath } from './store.ts';
import { say, type Context } from './context.ts';
import { Parked, parkError, commentOnIssue, pinned } from './jobs.ts';
import { agent, checkAgentRun } from './runs.ts';
import { checkBaseSubmodule, removeCheckout, freshCheckout } from './checkout.ts';

export async function plan(context: Context, job: FactoryJob) {
  let ctx = context;
  const unlock = lockJob(ctx.root, job.id);
  const worktree = worktreePath(ctx.root, job.id, '-plan');
  try {
    ctx = pinned(ctx);
    const base = baseRef(ctx.root, ctx.project.config.workflow.baseBranch);
    freshCheckout(ctx, worktree, base);
    checkBaseSubmodule(ctx, worktree);
    const brief = readFileSync(jobFile(ctx.root, job.id, 'brief.md'), 'utf8');
    const result = await agent(ctx, job, 'plan', worktree, worktree, planPrompt(brief));
    checkAgentRun(ctx, job, result);
    // A plan has no STATUS line unless the planner gives up.
    if (/^\s*STATUS:\s*BLOCKED\b/.test(result.text)) {
      throw new Parked('agent-blocked', agentStatus(result.text).reason);
    }
    if (!/^## Acceptance criteria/m.test(result.text)) {
      throw new Parked('agent-blocked', 'the plan has no Acceptance criteria section');
    }
    const text = result.text.trim() + '\n';
    writeFileSync(jobFile(ctx.root, job.id, 'plan.md'), text, { mode: 0o600 });
    // A label left from earlier must not approve a plan nobody has read.
    if (job.issue) {
      gh(ctx.root, [
        'issue',
        'edit',
        String(job.issue.number),
        '--remove-label',
        'factory:approved',
      ]);
    }
    job.plan = {
      digest: planDigest(text),
      approvedBy: null,
      at: null,
      proposedAt: new Date().toISOString(),
    };
    job.stage = 'awaiting-approval';
    saveJob(ctx.root, job);
    recordEvent(ctx.root, job.id, 'planned', { digest: job.plan.digest });
    commentOnIssue(
      ctx,
      job,
      `The Halvard factory proposes this plan for job \`${job.id}\`.\n\n${text}\nTo approve it, add the label \`factory:approved\` or run \`halvard factory approve ${job.id}\`, then \`halvard factory build ${job.id}\`.`,
    );
    say(`${job.id}: plan written to ${jobFile(ctx.root, job.id, 'plan.md')}; approve it to build`);
    return job;
  } catch (err) {
    return parkError(ctx, job, err);
  } finally {
    removeCheckout(ctx, worktree);
    unlock();
  }
}

export function whoAmI(root: string) {
  const name = exec('git', ['config', 'user.name'], root).stdout.trim();
  return name || process.env.USER || 'unknown';
}

const labelApprover = (ctx: Context, job: FactoryJob) =>
  job.issue && job.plan?.proposedAt
    ? labeledBy(ctx, job.issue.number, 'factory:approved', job.plan.proposedAt)
    : null;

// A plan counts as approved once a human ran factory approve or labeled the issue.
export function approval(ctx: Context, job: FactoryJob) {
  if (job.small || job.plan?.approvedBy) return true;
  if (job.stage !== 'awaiting-approval') return false;
  const login = labelApprover(ctx, job);
  if (!login) return false;
  approve(ctx, job, `${login} (GitHub label factory:approved)`);
  return true;
}

export function approve(ctx: Context, job: FactoryJob, by: string) {
  if (job.stage !== 'awaiting-approval' || !job.plan) {
    throw new Error(`job ${job.id} has no plan waiting for approval (stage ${job.stage})`);
  }
  const text = readFileSync(jobFile(ctx.root, job.id, 'plan.md'), 'utf8');
  if (planDigest(text) !== job.plan.digest) {
    throw new Error('plan.md changed after the plan run; run factory plan again for a new plan');
  }
  job.plan = { digest: job.plan.digest, approvedBy: by, at: new Date().toISOString() };
  job.stage = 'approved';
  saveJob(ctx.root, job);
  recordEvent(ctx.root, job.id, 'approved', { by, digest: job.plan.digest });
  say(`${job.id}: plan approved by ${by}`);
  return job;
}

// A job whose plan run died, parked before approval, or waits on a plan nobody wants gets
// a new plan run under the same id.
export async function replan(ctx: Context, id: string) {
  const unlock = lockJob(ctx.root, id);
  let job: FactoryJob;
  try {
    job = loadJob(ctx.root, id);
    const stale = job.stage === 'planning' || job.stage === 'awaiting-approval';
    if (job.small || !(stale || (job.stage === 'parked' && !job.plan?.approvedBy))) {
      throw new Error(
        `job ${id} is ${job.stage}; only a job without an approved plan is planned again`,
      );
    }
    Object.assign(job, { stage: 'planning', plan: null, parked: null });
    rmSync(jobFile(ctx.root, id, 'stop'), { force: true });
    saveJob(ctx.root, job);
    recordEvent(ctx.root, id, 'replan');
  } finally {
    unlock();
  }
  return plan(ctx, job);
}
