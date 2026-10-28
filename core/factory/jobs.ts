import type { FactoryJob } from '../types.ts';
import { randomUUID as uuid } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { checkImage } from './container.ts';
import { gh } from './ship.ts';
import { issueSource, labeledBy, type Source } from './github.ts';
import { jobProblems, createJob, jobFile, jobId, listJobs, recordEvent, saveJob } from './store.ts';
import { say, stopRequested, type Context } from './context.ts';

// Thrown by a step to park its job; plan() and work() turn it into park().
export class Parked extends Error {
  reason: string;
  constructor(reason: string, detail: string) {
    super(detail);
    this.reason = reason;
  }
}

// A Parked step parks with its reason; anything unexpected parks as infra, so a job never
// stays half-built in an active stage.
export const parkError = (ctx: Context, job: FactoryJob, err: unknown) =>
  err instanceof Parked
    ? park(ctx, job, err.reason, err.message)
    : park(ctx, job, 'infra', (err as Error).message);

export function park(ctx: Context, job: FactoryJob, reason: string, detail: string) {
  job.stage = 'parked';
  job.parked = { reason, detail: detail.slice(0, 4000), at: new Date().toISOString() };
  saveJob(ctx.root, job);
  recordEvent(ctx.root, job.id, 'parked', { reason, detail: job.parked.detail });
  say(`${job.id} parked (${reason}): ${detail.split('\n')[0]}`);
  if (job.issue) {
    const body = `The Halvard factory parked job \`${job.id}\`: **${reason}**.\n\n${detail}\n\n${
      job.worktree ? `The worktree is kept at \`${job.worktree}\` for inspection.\n\n` : ''
    }A human decides what happens next.`;
    commentOnIssue(ctx, job, body);
    gh(ctx.root, ['issue', 'edit', String(job.issue.number), '--add-label', 'factory:parked']);
  }
  return job;
}

export function commentOnIssue(ctx: Context, job: FactoryJob, body: string) {
  if (!job.issue) return;
  const file = jobFile(ctx.root, job.id, `comment-${uuid()}.md`);
  writeFileSync(file, body, { mode: 0o600 });
  const run = gh(ctx.root, ['issue', 'comment', String(job.issue.number), '--body-file', file]);
  rmSync(file, { force: true });
  if (run.status !== 0)
    say(`could not comment on issue #${job.issue.number}: ${run.stderr.trim()}`);
}

export function source(ctx: Context, flags: Record<string, string | boolean | undefined>): Source {
  if (typeof flags.issue === 'string') {
    if (!/^[1-9][0-9]*$/.test(flags.issue)) throw new Error('--issue takes an issue number');
    return issueSource(
      ctx,
      Number(flags.issue),
      typeof flags.id === 'string' ? flags.id : undefined,
    );
  }
  if (typeof flags.brief !== 'string') throw new Error('give --issue <number> or --brief <file>');
  if (typeof flags.title !== 'string' || typeof flags.id !== 'string') {
    throw new Error('a brief needs --title <text> and --id <slug>');
  }
  return {
    id: jobId(flags.id),
    title: flags.title,
    brief: readFileSync(flags.brief, 'utf8'),
    issue: null,
  };
}

export function newJob(ctx: Context, src: Source, small: boolean, fix: boolean) {
  const job = createJob(ctx.root, {
    version: 1,
    id: src.id,
    repo: ctx.root,
    title: src.title,
    issue: src.issue,
    small,
    fix,
    author: ctx.factory.author,
    stage: small ? 'approved' : 'planning',
    worktree: null,
    branch: null,
    task: null,
    plan: null,
    reviewer: null,
    round: 0,
    fixPasses: 0,
    parked: null,
    scope: src.scope ?? null,
    pr: null,
    costUsd: 0,
  });
  writeFileSync(jobFile(ctx.root, job.id, 'brief.md'), src.brief, { mode: 0o600 });
  recordEvent(ctx.root, job.id, 'created', { issue: src.issue?.number ?? null, small });
  return job;
}

export const ACTIVE = ['testing', 'building', 'gating', 'reviewing', 'shipping'];
export const DONE = ['committed', 'pr-open'];

// Why the job must stop now: the operator interrupted the runner or ran factory stop, or
// someone with write access labeled the issue factory:stop.
export function halted(ctx: Context, job: FactoryJob) {
  if (stopRequested()) return 'the runner was interrupted';
  if (existsSync(jobFile(ctx.root, job.id, 'stop'))) return 'stopped with factory stop';
  if (job.issue && labeledBy(ctx, job.issue.number, 'factory:stop', null)) {
    return 'the issue is labeled factory:stop';
  }
  return null;
}

export function checkHalted(ctx: Context, job: FactoryJob) {
  const why = halted(ctx, job);
  if (why) throw new Parked('stopped-by-human', why);
}

// A child process that failed because the job was stopped parks as a stop, not as infra.
export function childFailed(ctx: Context, job: FactoryJob, detail: string): never {
  checkHalted(ctx, job);
  throw new Parked('infra', detail);
}

// Polled while a child runs. Unlike halted, it never calls GitHub.
export const stopAsked = (ctx: Context, job: FactoryJob) => () =>
  stopRequested() || existsSync(jobFile(ctx.root, job.id, 'stop'));

// The context with the container image pinned to the id that passed the version check.
export function pinned(ctx: Context): Context {
  const config = ctx.factory.container;
  if (!config) return ctx;
  const { problem, id } = checkImage(config);
  if (problem || !id) throw new Parked('infra', problem ?? `the image ${config.image} has no id`);
  return { ...ctx, factory: { ...ctx.factory, container: { ...config, image: id } } };
}

// Why no work may start: a job parked after tampering, or a job file that does not read.
export function blocker(root: string, allow?: string) {
  const broken = jobProblems(root);
  if (broken.length) return `job file of ${broken.join(', ')} is unreadable or invalid`;
  const tampered = listJobs(root).find(
    (job) => job.parked?.reason === 'tampered' && job.id !== allow,
  );
  return tampered
    ? `factory job ${tampered.id} parked after tampering: ${tampered.parked!.detail.split('\n')[0]}`
    : null;
}
