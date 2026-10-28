import type {
  FactoryConfig,
  FactoryJob,
  Harness,
  HoldoutCheck,
  Project,
  ReviewRecord,
} from '../types.ts';
import { createHash, randomUUID as uuid } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { options } from '../cli.ts';
import {
  eligibleReviewers,
  personalRoot,
  reviewerSettings,
  workspaceRoot,
} from '../flow-config.ts';
import { checkImage } from './container.ts';
import { loadProject, matches } from '../project.ts';
import { protectedPatterns } from '../guard/protected.ts';
import { pluginRoot } from '../shared/plugin.ts';
import { completeTask } from '../workflow/complete.ts';
import { reviewCommand } from '../workflow/review.ts';
import { digest, fingerprint, sessionKey } from '../state.ts';
import { nested, planDigest, startTask } from '../workflow/tasks.ts';
import {
  agentEnv,
  agentStatus,
  runAgent,
  runChild,
  scrubbedEnv,
  type ChildResult,
  type AgentResult,
  type Stage,
} from './harness.ts';
import {
  baseRef,
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
import { jobEvents, metrics, writeBoard } from './board.ts';
import { issueSource, labeledBy, type Source } from './github.ts';
import {
  boxed,
  checkoutMounts,
  ghShield,
  gitlink,
  isolated,
  listedEnv,
  nestedRepo,
  runnerBox,
  runnerEnv,
  unsafeGitDir,
} from './isolation.ts';
import { buildPrompt, planPrompt, testsPrompt } from './prompts.ts';
import {
  activeRun,
  factoryHome,
  jobProblems,
  lockHolder,
  createJob,
  jobDirectory,
  jobFile,
  jobId,
  listJobs,
  loadJob,
  lockJob,
  recordEvent,
  saveJob,
  worktreePath,
} from './store.ts';

const runner = () => resolve(pluginRoot, 'bin/halvard.ts');
export const say = (line: string) => process.stderr.write(`factory: ${line}\n`);

// Set by SIGINT or SIGTERM to a long-running factory command. A run in progress parks at
// its next step; an agent that is running is stopped at once by runAgent.
let stopping = false;
export const stopRequested = () => stopping;
let catching = false;
export function catchStops() {
  if (catching) return;
  catching = true;
  const stop = () => {
    // A second signal ends a runner stuck in a long synchronous step, such as the gate.
    if (stopping) process.exit(130);
    say('stopping after the current step; signal again to quit now');
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// Thrown by a step to park its job; plan() and work() turn it into park().
class Parked extends Error {
  reason: string;
  constructor(reason: string, detail: string) {
    super(detail);
    this.reason = reason;
  }
}

const SETUP_TIMEOUT_MS = 20 * 60 * 1000;
const GATE_TIMEOUT_MS = 21 * 60 * 1000;
const HOLDOUT_TIMEOUT_MS = 30 * 60 * 1000;
const TASK_DONE_TIMEOUT_MS = 5 * 60 * 1000;
const PUSH_TIMEOUT_MS = 5 * 60 * 1000;

export interface Context {
  project: Project;
  root: string;
  factory: FactoryConfig;
}

export function context(cwd: string): Context {
  // Agents inherit these from the runner; a factory command inside one is refused.
  for (const name of ['HALVARD_UNATTENDED', 'HALVARD_READONLY', 'HALVARD_REVIEW', 'PI_REVIEW']) {
    if (process.env[name] === '1') {
      throw new Error(
        'factory commands run only from your own terminal, never inside an agent run',
      );
    }
  }
  const project = loadProject(cwd);
  if (!project.config.factory) {
    throw new Error('add a factory block to .halvard.json first; see docs/factory.md');
  }
  const ctx = { project, root: project.root, factory: project.config.factory };
  checkMounts(ctx);
  return ctx;
}

// The real path, resolving the nearest folder that exists when the path itself does not, so a
// missing socket under a linked /var/run still reads as under /run.
const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(real(parent), basename(path));
  }
};

const within = (a: string, b: string) => a === b || a.startsWith(b.endsWith('/') ? b : `${b}/`);

// The owned path that host reaches. Real paths, so a link to a parent of the main checkout
// does not pass for something else. Every folder the name passes through counts too: a link
// under /var/run, such as Docker Desktop's socket, points outside it yet is still the socket.
function clash(host: string, owned: string[]) {
  const full = real(host);
  if (full === '/') return '/';
  const names = resolve(host).split('/').filter(Boolean);
  const passed = names.map((_, i) => real(`/${names.slice(0, i + 1).join('/')}`));
  return owned.find(
    (path) => within(real(path), full) || passed.some((folder) => within(folder, real(path))),
  );
}

// Extra mounts reach agent containers too, so none may expose what the runner owns: job
// files and receipts, the main checkout, the task workspace, your settings or Docker.
function checkMounts(ctx: Context) {
  const owned = [factoryHome(), ctx.root, workspaceRoot(), personalRoot(), '/var/run', '/run'];
  for (const { host } of ctx.factory.container?.mounts ?? []) {
    const path = clash(host, owned);
    if (path)
      throw new Error(`factory container mount ${host} overlaps ${path}, which the runner owns`);
  }
  // A holdout the agent could find in its tree or its container is no holdout.
  const visible = [...owned, ...(ctx.factory.container?.mounts ?? []).map(({ host }) => host)];
  for (const { name, dir } of ctx.factory.holdout) {
    const path = clash(dir, visible);
    if (path) throw new Error(`factory holdout ${name} folder ${dir} overlaps ${path}`);
  }
}

// Container mode builds no repository with submodules; that is a setting to change, not
// tampering, so the job parks as infra before any agent runs.
function checkBaseSubmodule(ctx: Context, checkout: string) {
  const link = ctx.factory.container ? gitlink(ctx, checkout) : null;
  if (link) {
    throw new Parked(
      'infra',
      `the base has the submodule ${link}, and container mode builds no repository with submodules`,
    );
  }
}

// A Parked step parks with its reason; anything unexpected parks as infra, so a job never
// stays half-built in an active stage.
const parkError = (ctx: Context, job: FactoryJob, err: unknown) =>
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

function commentOnIssue(ctx: Context, job: FactoryJob, body: string) {
  if (!job.issue) return;
  const file = jobFile(ctx.root, job.id, `comment-${uuid()}.md`);
  writeFileSync(file, body, { mode: 0o600 });
  const run = gh(ctx.root, ['issue', 'comment', String(job.issue.number), '--body-file', file]);
  rmSync(file, { force: true });
  if (run.status !== 0)
    say(`could not comment on issue #${job.issue.number}: ${run.stderr.trim()}`);
}

function source(ctx: Context, flags: Record<string, string | boolean | undefined>): Source {
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

async function agent(
  ctx: Context,
  job: FactoryJob,
  stage: Stage,
  cwd: string,
  workspace: string,
  prompt: string,
  harness: Harness = job.author,
): Promise<AgentResult> {
  const remaining = ctx.factory.budgetUsd - job.costUsd;
  if (remaining < 0.05) {
    return { text: '', costUsd: 0, exitCode: null, timedOut: false, error: 'budget spent' };
  }
  const started = Date.now();
  say(`${job.id}: ${stage} run with ${harness}`);
  const result = await runAgent(harness, stage, {
    cwd,
    prompt,
    workspace,
    budgetUsd: remaining,
    config: ctx.factory,
    env: { ...agentEnv(stage, ghShield(ctx, job)), ...listedEnv(ctx) },
    log: jobFile(ctx.root, job.id, 'agent.log'),
    timeoutSeconds: ctx.factory.timeouts[stage],
    wrap: ctx.factory.container
      ? (argv, scratch) =>
          boxed(ctx, job, `${stage}-${harness}`, argv, {
            workdir: cwd,
            mounts: [
              ...checkoutMounts(cwd),
              { path: scratch, readonly: false },
              ...(workspace !== cwd ? [{ path: workspace, readonly: false }] : []),
            ],
            env: ['HALVARD_UNATTENDED', ...(stage === 'plan' ? ['HALVARD_READONLY'] : [])],
          })
      : undefined,
    shouldStop: stopAsked(ctx, job),
  });
  job.costUsd += result.costUsd;
  saveJob(ctx.root, job);
  recordEvent(ctx.root, job.id, 'agent', {
    stage,
    harness,
    costUsd: result.costUsd,
    seconds: Math.round((Date.now() - started) / 1000),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    error: result.error,
  });
  return result;
}

// An agent run that ended without an answer parks the job.
function checkAgentRun(ctx: Context, job: FactoryJob, result: AgentResult) {
  if (result.error === 'interrupted') {
    throw new Parked('stopped-by-human', halted(ctx, job) ?? 'the agent was stopped');
  }
  if (result.error === 'budget spent') {
    throw new Parked('budget-usd', `spent $${job.costUsd.toFixed(2)}`);
  }
  if (result.error) throw new Parked(result.timedOut ? 'budget-time' : 'infra', result.error);
}

function checkReady(result: AgentResult) {
  const status = agentStatus(result.text);
  if (status.status === 'BLOCKED') throw new Parked('agent-blocked', status.reason);
}

// The context with the container image pinned to the id that passed the version check.
function pinned(ctx: Context): Context {
  const config = ctx.factory.container;
  if (!config) return ctx;
  const { problem, id } = checkImage(config);
  if (problem || !id) throw new Parked('infra', problem ?? `the image ${config.image} has no id`);
  return { ...ctx, factory: { ...ctx.factory, container: { ...config, image: id } } };
}

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

function whoAmI(root: string) {
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

function approve(ctx: Context, job: FactoryJob, by: string) {
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

// The gate, the review and task-done run in child processes, in a container in container
// mode, with the scrubbed environment, because they execute code the agent may have written.
function runnerChild(
  ctx: Context,
  job: FactoryJob,
  checkout: string,
  args: string[],
  timeoutMs: number,
): Promise<ChildResult> {
  const { argv, cleanup } = ctx.factory.container
    ? boxed(
        ctx,
        job,
        args[0]!,
        ['node', ctx.factory.container.runner, ...args],
        runnerBox(ctx, job, checkout),
      )
    : { argv: [process.execPath, runner(), ...args], cleanup: () => {} };
  return runChild(argv, {
    cwd: checkout,
    env: runnerEnv(ctx, job),
    timeoutMs,
    log: jobFile(ctx.root, job.id, 'runner.log'),
    cleanup,
    shouldStop: stopAsked(ctx, job),
  });
}

// Docker itself failing is not the agent's failure: no daemon, no image, a clash.
const dockerFailed = (ctx: Context, run: ChildResult) =>
  Boolean(ctx.factory.container) && (run.status === null || run.status === 125);

// Whether a sampled check runs for this job; a retry of the job gets the same answer.
export const sampled = (id: string, check: HoldoutCheck) =>
  check.sample >= 1 || parseInt(digest([id, check.name]).slice(0, 8), 16) / 2 ** 32 < check.sample;

// Holdout checks run after the gate passes, with the scenarios folder mounted read-only for
// that step only. Their output stays in the job folder: a fix pass never shows it to the
// builder, so a failed blocking check parks the job instead.
async function holdouts(
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

export const ACTIVE = ['testing', 'building', 'gating', 'reviewing', 'shipping'];
const DONE = ['committed', 'pr-open'];

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

// Why the job must stop now: the operator interrupted the runner or ran factory stop, or
// someone with write access labeled the issue factory:stop.
function halted(ctx: Context, job: FactoryJob) {
  if (stopping) return 'the runner was interrupted';
  if (existsSync(jobFile(ctx.root, job.id, 'stop'))) return 'stopped with factory stop';
  if (job.issue && labeledBy(ctx, job.issue.number, 'factory:stop', null)) {
    return 'the issue is labeled factory:stop';
  }
  return null;
}

function checkHalted(ctx: Context, job: FactoryJob) {
  const why = halted(ctx, job);
  if (why) throw new Parked('stopped-by-human', why);
}

// A child process that failed because the job was stopped parks as a stop, not as infra.
function childFailed(ctx: Context, job: FactoryJob, detail: string): never {
  checkHalted(ctx, job);
  throw new Parked('infra', detail);
}

// Polled while a child runs. Unlike halted, it never calls GitHub.
const stopAsked = (ctx: Context, job: FactoryJob) => () =>
  stopping || existsSync(jobFile(ctx.root, job.id, 'stop'));

const branchName = (ctx: Context, job: FactoryJob) => {
  const { featurePrefix, fixPrefix } = ctx.project.config.workflow;
  return (job.fix ? fixPrefix : featurePrefix) + job.id;
};

// The files under the acceptance-test folder and a digest of their contents. Links are
// hashed by their target text and never followed; anything but a file, folder or link is
// refused, because reading a pipe or device could hang or exhaust the runner.
function testFiles(worktree: string, dir: string) {
  const files: string[] = [];
  const hash = createHash('sha256');
  const walk = (path: string) => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name);
      const rel = relative(worktree, full);
      const stat = lstatSync(full);
      hash.update(rel + '\0');
      if (stat.isSymbolicLink()) {
        hash.update('link\0' + readlinkSync(full));
        files.push(rel);
      } else if (stat.isDirectory()) {
        hash.update('dir\0');
        walk(full);
      } else if (stat.isFile()) {
        if (stat.size > 16 * 1024 * 1024) throw new Error(`${rel} is over 16 MiB`);
        hash.update(readFileSync(full));
        files.push(rel);
      } else {
        throw new Error(`${rel} is not a file, folder or link`);
      }
      hash.update('\0');
    }
  };
  const top = join(worktree, dir);
  const stat = lstatSync(top, { throwIfNoEntry: false });
  if (stat && !stat.isDirectory()) throw new Error(`${dir} is not a folder`);
  // A parent folder swapped for a link keeps the same contents under another path.
  if (stat && realpathSync(top) !== join(realpathSync(worktree), dir)) {
    throw new Error(`${dir} is reached through a link`);
  }
  if (stat) walk(top);
  return { files, digest: hash.digest('hex') };
}

// A test folder the runner cannot read safely counts as tampering, never as a crash.
function testDigest(worktree: string, dir: string) {
  try {
    return testFiles(worktree, dir).digest;
  } catch (err) {
    return `unreadable: ${(err as Error).message}`;
  }
}

// The full name of the base, which a clone fetches from the main checkout.
const fullRef = (ctx: Context, base: string) =>
  hasOrigin(ctx.root)
    ? `refs/remotes/${base}`
    : `refs/heads/${ctx.project.config.workflow.baseBranch}`;

// A checkout left by a runner that died is the factory's own; remove it before reuse.
function removeCheckout(ctx: Context, path: string) {
  if (ctx.factory.container) {
    rmSync(path, { recursive: true, force: true });
  } else {
    exec('git', ['worktree', 'remove', '--force', path], ctx.root);
    exec('git', ['worktree', 'prune'], ctx.root);
  }
}

// A worktree normally. In container mode a standalone clone instead, because a worktree's
// Git directory lies in the main checkout, which a container must not mount.
function freshCheckout(ctx: Context, path: string, base: string) {
  removeCheckout(ctx, path);
  if (!ctx.factory.container) {
    gitRunner(ctx.root, ['worktree', 'add', '--quiet', '--detach', path, base]);
    return;
  }
  gitRunner(ctx.root, ['clone', '--quiet', '--no-hardlinks', '--no-checkout', ctx.root, path]);
  gitRunner(path, ['remote', 'remove', 'origin']);
  gitRunner(path, ['fetch', '--quiet', ctx.root, `+${fullRef(ctx, base)}:refs/factory/base`]);
  gitRunner(path, ['checkout', '--quiet', '--detach', 'refs/factory/base']);
  // The runner commits in the clone, so it takes your identity from the main checkout.
  for (const key of ['user.name', 'user.email']) {
    const value = exec('git', ['config', key], ctx.root).stdout.trim();
    if (value) gitRunner(path, ['config', key, value]);
  }
}

// The base as the checkout sees it, after the main checkout fetched it again.
function latestBase(ctx: Context, checkout: string, base: string) {
  const latest = hasOrigin(ctx.root)
    ? baseRef(ctx.root, ctx.project.config.workflow.baseBranch)
    : base;
  if (!ctx.factory.container) return latest;
  gitRunner(checkout, [
    'fetch',
    '--quiet',
    ctx.root,
    `+${fullRef(ctx, latest)}:refs/factory/latest`,
  ]);
  return 'refs/factory/latest';
}

// Git configuration in every scope the runner's own Git commands read. The agent runs as
// the user with a shell, so it could add a credential helper, fsmonitor, filter or URL
// rewrite; the runner stops before running Git with its credentials if anything changed.
function gitConfig(worktree: string) {
  // Personal Halvard settings merge into the workflow configuration the gate and review use.
  const personal = resolve(personalRoot(), 'personal.json');
  return digest([
    existsSync(personal) ? readFileSync(personal, 'utf8') : null,
    exec('git', ['config', '--list', '--show-origin', '--show-scope', '-z'], worktree).stdout,
  ]);
}

// Changes the runner must never gate, review or ship: workflow configuration, harness
// settings, the gate's and review's scripts and extensions, as the base commit names them.
// A scoped job, such as a retro, may change only its scope and its own task file.
function checkScope(ctx: Context, job: FactoryJob, worktree: string, base: string, task: string) {
  if (!job.scope) return;
  const outside = isolated(ctx, () => changedFiles(worktree, base)).filter(
    (file) => file !== task && !matches(file, job.scope!),
  );
  if (outside.length) {
    throw new Parked(
      'out-of-scope',
      `the job may change only ${job.scope.join(', ')}; it changed ${outside.join(', ')}`,
    );
  }
}

function guardedChanges(worktree: string, base: string, patterns: string[]) {
  return changedFiles(worktree, base).filter((file) => matches(file, patterns));
}

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

// The job's task checkout and what the runner read from it before any agent ran.
interface Checkout {
  worktree: string;
  // The base ref the checkout started from, and the commit task-start recorded for it.
  base: string;
  start: string;
  task: string;
  workspace: string;
  pushUrl: string | null;
  // The digest of the approved plan as the task file nests it, or null for a small job.
  plan: string | null;
  gitConfig: string;
  guarded: string[];
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

// A fresh checkout on the job's task branch, with the task file written by task-start.
function checkout(ctx: Context, job: FactoryJob): Checkout {
  const worktree = worktreePath(ctx.root, job.id);
  const base = baseRef(ctx.root, ctx.project.config.workflow.baseBranch);
  const pushUrl = hasOrigin(ctx.root)
    ? exec('git', ['remote', 'get-url', '--push', 'origin'], ctx.root).stdout.trim()
    : null;
  freshCheckout(ctx, worktree, base);
  checkBaseSubmodule(ctx, worktree);
  const planText = job.plan
    ? readFileSync(jobFile(ctx.root, job.id, 'plan.md'), 'utf8')
    : undefined;
  if (planText !== undefined && planDigest(planText) !== job.plan!.digest) {
    throw new Parked('plan-changed', 'plan.md no longer matches the approved digest');
  }
  // Record the branch before task-start creates it, so a retry after a crash removes it,
  // but only when no branch of that name exists yet.
  const branch = branchName(ctx, job);
  const exists = exec('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], ctx.root);
  if (exists.status !== 0) {
    job.branch = branch;
    saveJob(ctx.root, job);
  }
  const started = startTask(worktree, {
    id: job.id,
    title: job.title,
    author: job.author,
    fix: job.fix,
    small: job.small,
    brief: readFileSync(jobFile(ctx.root, job.id, 'brief.md'), 'utf8'),
    base: 'HEAD',
    plan: planText,
    approvedBy: planText === undefined ? undefined : job.plan!.approvedBy!,
  });
  Object.assign(job, { worktree, branch: started.branch, task: started.task, stage: 'building' });
  saveJob(ctx.root, job);
  recordEvent(ctx.root, job.id, 'started', { branch: started.branch, base: started.base });
  return {
    worktree,
    base,
    start: started.base,
    task: started.task,
    workspace: started.workspace,
    pushUrl,
    plan: planText === undefined ? null : planDigest(nested(planText)),
    gitConfig: gitConfig(worktree),
    guarded: protectedPatterns(loadProject(worktree)),
  };
}

// What the runner must not trust, checked after setup and after every agent run.
function checkTampering(ctx: Context, job: FactoryJob, run: Checkout) {
  const unsafe = ctx.factory.container
    ? (unsafeGitDir(run.worktree) ?? nestedRepo(ctx, run.worktree))
    : null;
  if (unsafe) throw new Parked('tampered', unsafe);
  if (gitConfig(run.worktree) !== run.gitConfig) {
    throw new Parked('tampered', 'Git configuration changed during the run');
  }
  if (job.tests && testDigest(run.worktree, job.tests.dir) !== job.tests.digest) {
    throw new Parked('tampered', `the frozen acceptance tests in ${job.tests.dir} changed`);
  }
  const guarded = isolated(ctx, () => guardedChanges(run.worktree, run.start, run.guarded));
  if (guarded.length) {
    throw new Parked('tampered', guarded.map((file) => `changed ${file}`).join('\n'));
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

// The runner's own gate on the agent's tree. Returns the output's tail when the gate failed.
async function gate(ctx: Context, job: FactoryJob, run: Checkout, key: string) {
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

async function review(ctx: Context, job: FactoryJob, run: Checkout, key: string) {
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

async function ship(
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
function shipJob(ctx: Context, id: string) {
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

// A running job stops at its next check, within seconds while its agent runs; a waiting
// job parks at once.
function stopJob(ctx: Context, id: string) {
  const job = loadJob(ctx.root, id);
  if (job.stage === 'parked' || DONE.includes(job.stage)) {
    throw new Error(`job ${id} is ${job.stage}; there is nothing to stop`);
  }
  writeFileSync(jobFile(ctx.root, id, 'stop'), new Date().toISOString() + '\n', { mode: 0o600 });
  if (lockHolder(jobFile(ctx.root, id, 'runner.lock'))) {
    say(`${id}: asked its runner to stop`);
    return job;
  }
  const unlock = lockJob(ctx.root, id);
  try {
    return park(ctx, loadJob(ctx.root, id), 'stopped-by-human', 'stopped with factory stop');
  } finally {
    unlock();
  }
}

const usage = `halvard factory commands, run from the repository's main checkout in your own terminal:
  factory plan --issue <n> [--id <slug>] [--fix]
  factory plan --brief <file> --title <text> --id <slug> [--fix]
                                Read-only plan run; posts the plan on the issue
  factory approve <job> [--by <name>]
                                Approve the job's plan (or label the issue factory:approved)
  factory build <job> [--no-push] [--retry [--checked]]
                                Build an approved job, run gate and review, open the PR;
                                --retry restarts a parked or interrupted job, --checked
                                confirms you checked a job parked after tampering
  factory run --issue <n> | --brief <file> --title <text> --id <slug> [--fix] [--no-push]
                                Small task: build directly without a plan stage
  factory ship <job>            Push a job built with --no-push and open its PR
  factory rework <job> --note <file>
                                Build a parked job again, with your note for the agent
  factory replan <job>          Plan a job again that has no approved plan
  factory stop <job>            Stop a job: a running one at its next step
  factory serve [--once]        Poll labeled issues and work them until stopped
  factory board [--out <file>]  Write the HTML board and job pages, and print the board's path
  factory metrics               Print the factory's numbers
  factory automerge             Dry run: which pull requests would have merged by themselves
  factory retro [--since <days>] [--no-push]
                                Turn recurring findings into a job that edits guidance
  factory status [<job>]        Print job state
`;

const SPECS: Record<string, { count: [number, number]; options: string[] }> = {
  plan: { count: [0, 0], options: ['issue', 'brief', 'title', 'id', 'fix'] },
  approve: { count: [1, 1], options: ['by'] },
  build: { count: [1, 1], options: ['no-push', 'retry', 'checked'] },
  run: { count: [0, 0], options: ['issue', 'brief', 'title', 'id', 'fix', 'no-push'] },
  status: { count: [0, 1], options: [] },
  rework: { count: [1, 1], options: ['note', 'no-push', 'checked'] },
  replan: { count: [1, 1], options: [] },
  stop: { count: [1, 1], options: [] },
  serve: { count: [0, 0], options: ['once'] },
  board: { count: [0, 0], options: ['out'] },
  metrics: { count: [0, 0], options: [] },
  automerge: { count: [0, 0], options: [] },
  retro: { count: [0, 0], options: ['since', 'no-push'] },
  ship: { count: [1, 1], options: [] },
};

// Commands that only report, or only stop work, run while a job is running.
const REPORTS = ['status', 'board', 'metrics', 'stop'];
// serve checks running jobs and blockers itself on every pass, and keeps polling meanwhile.
const UNCHECKED = [...REPORTS, 'serve'];
// Commands that change a job write the board when they finish; serve writes it after each step.
const BOARDED = ['plan', 'approve', 'build', 'run', 'rework', 'replan', 'stop', 'retro', 'ship'];

// Boolean options the shared parser does not already know.
const FLAGS = new Set(['no-push', 'retry', 'checked', 'once']);

export async function factoryCommand(cwd: string, args: string[]) {
  const [verb, ...rest] = args;
  if (!verb || verb === 'help' || verb === '--help') {
    process.stdout.write(usage);
    return;
  }
  const spec = Object.hasOwn(SPECS, verb) ? SPECS[verb]! : null;
  if (!spec) throw new Error(`unknown factory command: ${verb}`);
  // Boolean options take no value; the shared parser handles the rest.
  const values = rest.flatMap((arg) =>
    FLAGS.has(arg.slice(2)) && arg.startsWith('--') ? [arg, 'yes'] : [arg],
  );
  const { positional, flags } = options(values, spec.options);
  if (positional.length < spec.count[0] || positional.length > spec.count[1]) {
    throw new Error(`factory ${verb} takes ${spec.count[1]} positional argument(s)`);
  }
  const ctx = context(cwd);
  const print = (value: unknown) => {
    // The board is a view of the job files; failing to write it never fails the command.
    if (BOARDED.includes(verb)) {
      try {
        say(`board at ${writeBoard(ctx.root)}`);
      } catch (err) {
        say(`board: ${(err as Error).message}`);
      }
    }
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
    // Scripts can tell a parked job from a shipped one; status is only a report.
    if (!REPORTS.includes(verb) && (value as FactoryJob | null)?.stage === 'parked') {
      process.exitCode = 3;
    }
  };
  // An agent inside a run inherits the user's shell; it must not approve or start work.
  // The auto-merge dry run only reads, but it fetches the base with your credentials, so it
  // waits for a tampered job to be checked like the commands that start work.
  const running = UNCHECKED.includes(verb) || verb === 'automerge' ? null : activeRun(ctx.root);
  if (running) {
    throw new Error(`factory job ${running} is running; wait until its runner exits`);
  }
  // A tampered run may have left Git configuration that would run with the runner's
  // credentials on the next fetch, so nothing starts until a human has looked.
  const checked = ['build', 'rework'].includes(verb) && flags.checked ? positional[0] : undefined;
  const blocked = UNCHECKED.includes(verb) ? null : blocker(ctx.root, checked);
  if (blocked) {
    throw new Error(
      `${blocked}. Check your Git configuration, personal settings and the job file, then run factory build <job> --retry --checked, or remove the job's folder`,
    );
  }
  if (verb === 'board') {
    process.stdout.write(
      writeBoard(ctx.root, typeof flags.out === 'string' ? resolve(flags.out) : undefined) + '\n',
    );
    return;
  }
  if (verb === 'metrics') {
    print(metrics(ctx.root));
    return;
  }
  if (verb === 'stop') {
    print(stopJob(ctx, positional[0]!));
    return;
  }
  if (verb === 'ship') {
    print(shipJob(ctx, positional[0]!));
    return;
  }
  if (verb === 'automerge') {
    const { autoMergeReport } = await import('./outcomes.ts');
    print(autoMergeReport(ctx.root, ctx.project.config.workflow.baseBranch, ctx.factory.autoMerge));
    return;
  }
  if (verb === 'retro') {
    const { retroSource } = await import('./retro.ts');
    let days: number | undefined;
    if (flags.since !== undefined) {
      if (typeof flags.since !== 'string' || !/^[1-9][0-9]{0,2}$/.test(flags.since)) {
        throw new Error('--since takes a number of days, 1..999');
      }
      days = Number(flags.since);
    }
    const { source: retro, reason } = retroSource(ctx, new Date(), days);
    if (!retro) throw new Error(`no retro: ${reason}`);
    const job = newJob(ctx, retro, true, false);
    print(await build(ctx, job.id, !flags['no-push']));
    return;
  }
  // Long-running commands park their job on Ctrl-C instead of dying mid-step.
  catchStops();
  if (verb === 'serve') {
    const { serve } = await import('./serve.ts');
    await serve(ctx, { once: Boolean(flags.once) });
    return;
  }
  if (verb === 'replan') {
    print(await replan(ctx, positional[0]!));
    return;
  }
  if (verb === 'rework') {
    if (typeof flags.note !== 'string') throw new Error('rework needs --note <file>');
    const note = readFileSync(flags.note, 'utf8').trim();
    if (!note || note.length > 64 * 1024)
      throw new Error('the rework note must be 1 byte to 64 KiB');
    const target = loadJob(ctx.root, positional[0]!);
    if (target.stage !== 'parked' && !ACTIVE.includes(target.stage)) {
      throw new Error(
        `job ${target.id} is ${target.stage}; rework takes a parked or interrupted job`,
      );
    }
    writeFileSync(jobFile(ctx.root, positional[0]!, `rework-${Date.now()}.md`), note + '\n', {
      mode: 0o600,
    });
    print(await build(ctx, positional[0]!, !flags['no-push'], { retry: true, note }));
    return;
  }
  if (verb === 'status') {
    print(
      positional[0]
        ? loadJob(ctx.root, positional[0])
        : listJobs(ctx.root).map(({ id, stage, title, pr, parked }) => ({
            id,
            stage,
            title,
            pr,
            parked,
          })),
    );
    return;
  }
  if (verb === 'approve') {
    print(
      approve(
        ctx,
        loadJob(ctx.root, positional[0]!),
        typeof flags.by === 'string' ? flags.by : whoAmI(ctx.root),
      ),
    );
    return;
  }
  if (verb === 'build') {
    print(await build(ctx, positional[0]!, !flags['no-push'], { retry: Boolean(flags.retry) }));
    return;
  }
  const job = newJob(ctx, source(ctx, flags), verb === 'run', Boolean(flags.fix));
  print(verb === 'plan' ? await plan(ctx, job) : await build(ctx, job.id, !flags['no-push']));
}
