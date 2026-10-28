import type { FactoryJob } from './store.ts';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { personalRoot } from '../config/paths.ts';
import { loadProject, matches } from '../project.ts';
import { protectedPatterns } from '../guard/protected.ts';
import { digest } from '../state.ts';
import { nested, planDigest, startTask } from '../workflow/tasks.ts';
import { baseRef, changedFiles, exec, gitRunner, hasOrigin } from './ship.ts';
import { gitlink, isolated, nestedRepo, unsafeGitDir } from './isolation.ts';
import { jobFile, recordEvent, saveJob, worktreePath } from './store.ts';
import type { Context } from './context.ts';
import { Parked } from './jobs.ts';

// Container mode builds no repository with submodules; that is a setting to change, not
// tampering, so the job parks as infra before any agent runs.
export function checkBaseSubmodule(ctx: Context, checkout: string) {
  const link = ctx.factory.container ? gitlink(ctx, checkout) : null;
  if (link) {
    throw new Parked(
      'infra',
      `the base has the submodule ${link}, and container mode builds no repository with submodules`,
    );
  }
}

export const branchName = (ctx: Context, job: FactoryJob) => {
  const { featurePrefix, fixPrefix } = ctx.project.config.workflow;
  return (job.fix ? fixPrefix : featurePrefix) + job.id;
};

// The files under the acceptance-test folder and a digest of their contents. Links are
// hashed by their target text and never followed; anything but a file, folder or link is
// refused, because reading a pipe or device could hang or exhaust the runner.
export function testFiles(worktree: string, dir: string) {
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
export function removeCheckout(ctx: Context, path: string) {
  if (ctx.factory.container) {
    rmSync(path, { recursive: true, force: true });
  } else {
    exec('git', ['worktree', 'remove', '--force', path], ctx.root);
    exec('git', ['worktree', 'prune'], ctx.root);
  }
}

// A worktree normally. In container mode a standalone clone instead, because a worktree's
// Git directory lies in the main checkout, which a container must not mount.
export function freshCheckout(ctx: Context, path: string, base: string) {
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
export function latestBase(ctx: Context, checkout: string, base: string) {
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
export function checkScope(
  ctx: Context,
  job: FactoryJob,
  worktree: string,
  base: string,
  task: string,
) {
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

// The job's task checkout and what the runner read from it before any agent ran.
export interface Checkout {
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

// A fresh checkout on the job's task branch, with the task file written by task-start.
export function checkout(ctx: Context, job: FactoryJob): Checkout {
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
export function checkTampering(ctx: Context, job: FactoryJob, run: Checkout) {
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
