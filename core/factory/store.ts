import type { FactoryJob } from '../types.ts';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { privateDirectory } from '../state.ts';

// Factory jobs, logs and worktrees live outside the repository and outside the team
// workspace, whose files the guard treats by writer prefix.
export const factoryHome = () =>
  resolve(process.env.HALVARD_FACTORY_HOME || resolve(homedir(), '.halvard-factory'));

const JOB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function jobId(value: string) {
  if (!JOB_ID.test(value) || value.length > 64)
    throw new Error('job id must be a short lowercase slug');
  return value;
}

// One folder per repository; the marker keeps two repositories with the same name apart.
export function repoHome(root: string) {
  mkdirSync(factoryHome(), { recursive: true, mode: 0o700 });
  const dir = privateDirectory(join(factoryHome(), basename(root)));
  const marker = join(dir, '.repo');
  if (lstatSync(marker, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`factory marker ${marker} is a symlink`);
  }
  try {
    writeFileSync(marker, root + '\n', { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  if (readFileSync(marker, 'utf8').trim() !== root) {
    throw new Error(
      `factory folder ${dir} belongs to another repository; set HALVARD_FACTORY_HOME`,
    );
  }
  mkdirSync(join(dir, 'jobs'), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, 'worktrees'), { recursive: true, mode: 0o700 });
  return dir;
}

export const jobDirectory = (root: string, id: string) => join(repoHome(root), 'jobs', jobId(id));
// The task workspace is named after the worktree folder, so the folder carries the
// repository's name: two repositories with a job issue-1 each must not share one.
export const worktreePath = (root: string, id: string, suffix = '') =>
  join(repoHome(root), 'worktrees', `${basename(root)}-${jobId(id)}${suffix}`);

// The runner is the only writer of job.json, and it rewrites the whole file each time.
export function saveJob(root: string, job: FactoryJob) {
  const dir = jobDirectory(root, job.id);
  job.updated = new Date().toISOString();
  const temp = join(dir, `.job.${randomUUID()}.tmp`);
  writeFileSync(temp, JSON.stringify(job, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temp, join(dir, 'job.json'));
  return job;
}

// mkdir without recursion claims the id; a second claim of the same job fails.
export function createJob(root: string, job: Omit<FactoryJob, 'created' | 'updated'>) {
  const dir = jobDirectory(root, job.id);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`factory job ${job.id} already exists; see factory status ${job.id}`);
    }
    throw err;
  }
  const now = new Date().toISOString();
  return saveJob(root, { ...job, created: now, updated: now });
}

const STAGES = [
  'awaiting-plan',
  'planning',
  'awaiting-approval',
  'approved',
  'testing',
  'building',
  'gating',
  'reviewing',
  'shipping',
  'committed',
  'pr-open',
  'parked',
];

const text = (value: unknown) => typeof value === 'string';
const optional = (value: unknown, check: (value: unknown) => boolean) =>
  value === null || check(value);

// job.json is outside the worktree but still in the user's home, so the runner checks
// every field and the paths it acts on before trusting it.
export function loadJob(root: string, id: string): FactoryJob {
  const file = join(jobDirectory(root, id), 'job.json');
  if (!existsSync(file)) throw new Error(`no factory job ${id}`);
  const job = JSON.parse(readFileSync(file, 'utf8')) as FactoryJob;
  const plan = job.plan as unknown as Record<string, unknown> | null;
  const valid =
    job.version === 1 &&
    job.id === id &&
    job.repo === root &&
    text(job.title) &&
    STAGES.includes(job.stage) &&
    typeof job.small === 'boolean' &&
    typeof job.fix === 'boolean' &&
    text(job.author) &&
    optional(job.issue, (issue) => {
      const value = issue as Record<string, unknown>;
      return Number.isSafeInteger(value.number) && text(value.url);
    }) &&
    optional(job.worktree, (path) => path === worktreePath(root, id)) &&
    optional(job.branch, text) &&
    optional(job.task, text) &&
    optional(plan, () =>
      Boolean(
        plan &&
        /^[a-f0-9]{64}$/.test(String(plan.digest)) &&
        optional(plan.approvedBy, text) &&
        optional(plan.at, text) &&
        optional(plan.proposedAt ?? null, text),
      ),
    ) &&
    optional(job.reviewer, text) &&
    Number.isSafeInteger(job.round) &&
    Number.isSafeInteger(job.fixPasses) &&
    optional(job.parked, (parked) => text((parked as Record<string, unknown>).reason)) &&
    optional(job.tests ?? null, (tests) => {
      const value = tests as Record<string, unknown>;
      return text(value.dir) && /^[a-f0-9]{64}$/.test(String(value.digest));
    }) &&
    optional(job.pr, text) &&
    typeof job.costUsd === 'number';
  if (!valid) throw new Error(`invalid factory job file ${file}`);
  return job;
}

const jobNames = (root: string) => {
  const dir = join(repoHome(root), 'jobs');
  return readdirSync(dir)
    .filter((name) => JOB_ID.test(name) && existsSync(join(dir, name, 'job.json')))
    .sort();
};

const readable = (root: string, name: string) => {
  try {
    return loadJob(root, name);
  } catch {
    return null;
  }
};

// Every job whose file reads and validates; jobProblems names the others.
export const listJobs = (root: string) =>
  jobNames(root).flatMap((name) => readable(root, name) ?? []);

export const jobProblems = (root: string) =>
  jobNames(root).filter((name) => readable(root, name) === null);

// Append-only record of what the runner did, for the board, metrics and retros.
export function recordEvent(root: string, id: string, event: string, data: object = {}) {
  appendFileSync(
    join(jobDirectory(root, id), 'events.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n',
    { mode: 0o600 },
  );
}

export const jobFile = (root: string, id: string, name: string) =>
  join(jobDirectory(root, id), name);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

// The job whose runner is alive, if any. Commands that approve or start work refuse while
// one runs, so an agent inside a run cannot approve or launch another job.
export function activeRun(root: string) {
  const dir = join(repoHome(root), 'jobs');
  for (const name of readdirSync(dir)) {
    const lock = join(dir, name, 'runner.lock');
    if (!existsSync(lock)) continue;
    const pid = Number(readFileSync(lock, 'utf8'));
    if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) return name;
  }
  return null;
}

// One runner works a job at a time. A lock whose process is gone is reclaimed.
export const lockJob = (root: string, id: string) =>
  lockFile(jobFile(root, id, 'runner.lock'), `factory job ${id}`);

// One daemon serves a repository at a time.
export const lockServe = (root: string) =>
  lockFile(join(repoHome(root), 'serve.lock'), 'factory serve for this repository');

// The process that holds a lock file, while it is alive.
export function lockHolder(path: string) {
  if (!existsSync(path)) return null;
  const pid = Number(readFileSync(path, 'utf8'));
  return Number.isSafeInteger(pid) && pid > 0 && alive(pid) ? pid : null;
}

function lockFile(lock: string, what: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
      return () => rmSync(lock, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const pid = Number(readFileSync(lock, 'utf8'));
      if (alive(pid)) throw new Error(`${what} is already running in process ${pid}`);
      rmSync(lock, { force: true });
    }
  }
  throw new Error(`cannot lock ${what}`);
}
