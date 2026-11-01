import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  dataRoot,
  ensureRoot,
  legacyData,
  LAYOUT_MARKER,
  legacyPaths,
  MIGRATE_LOCK,
  rootIsCurrent,
  WORKSPACE_NEXT,
  workspaceHoldsRoot,
  workspaceRoot,
} from '../config/paths.ts';

export interface MigrationStep {
  what: 'workspace' | 'retro-logs' | 'factory' | 'config';
  from: string;
  to: string;
}

const RETRO_LOG = /^[a-z]+-retro-log\.md$/;

// What `halvard migrate` would move from the earlier layout into the one data folder. It
// refuses a root it cannot turn into the new layout, rather than move settings or factory
// jobs into a folder that agents write or that Halvard would not find again.
export function migrationPlan(home = homedir()): MigrationStep[] {
  const root = dataRoot(home);
  const legacy = legacyPaths(home);
  const found = legacyData(home);
  if (workspaceHoldsRoot(home)) {
    throw new Error(
      `HALVARD_WORKSPACE is ${root} or holds it, so settings and factory jobs there would be writable by agents; point HALVARD_WORKSPACE at ${resolve(root, 'workspace')}, or unset it`,
    );
  }
  if (!found.includes(legacy.workspace) && !rootIsCurrent(home) && found.length) {
    throw new Error(
      `${root} holds files that are not Halvard's new layout, and HALVARD_WORKSPACE keeps the workspace elsewhere; move them out of ${root} or set HALVARD_DATA to another folder`,
    );
  }
  const steps: MigrationStep[] = [];
  if (found.includes(legacy.workspace)) {
    steps.push({ what: 'workspace', from: legacy.workspace, to: resolve(root, 'workspace') });
  } else {
    // Retro logs once sat at the top of the workspace; they now have their own folder.
    const workspace = workspaceRoot(home);
    const logs = existsSync(workspace)
      ? readdirSync(workspace).filter((name) => RETRO_LOG.test(name))
      : [];
    if (logs.length) {
      steps.push({ what: 'retro-logs', from: workspace, to: resolve(workspace, 'retro-logs') });
    }
  }
  if (found.includes(legacy.factory)) {
    steps.push({ what: 'factory', from: legacy.factory, to: resolve(root, 'factory') });
  }
  if (found.includes(legacy.personal)) {
    steps.push({ what: 'config', from: legacy.personal, to: resolve(root, 'config') });
  }
  return steps;
}

// Each running factory process holds a lock file; moving its folder under it would strand it.
function runningFactory(dir: string) {
  if (!existsSync(dir)) return null;
  for (const repo of readdirSync(dir)) {
    const locks = [join(dir, repo, 'serve.lock')];
    const jobs = join(dir, repo, 'jobs');
    if (existsSync(jobs) && lstatSync(jobs).isDirectory()) {
      for (const job of readdirSync(jobs)) locks.push(join(jobs, job, 'runner.lock'));
    }
    for (const lock of locks) {
      if (!existsSync(lock)) continue;
      const pid = Number(readFileSync(lock, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      try {
        process.kill(pid, 0);
        return lock;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EPERM') return lock;
      }
    }
  }
  return null;
}

function move(from: string, to: string) {
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      throw new Error(
        `${from} is on another file system than ${to}; move it yourself, or keep it there with the matching HALVARD_* variable`,
      );
    }
    throw err;
  }
}

// Moves one retro log into the retro-logs folder, never over another.
function moveLog(from: string, logs: string, name: string) {
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const to = resolve(logs, name);
  if (existsSync(to)) throw new Error(`both ${from} and ${to} exist; merge them by hand`);
  move(from, to);
}

// Where each entry of the earlier workspace lands, checked before anything moves, so a
// clash stops migrate with the workspace untouched rather than half staged.
function workspaceClashes(root: string) {
  const next = resolve(root, WORKSPACE_NEXT);
  const skip = new Set([WORKSPACE_NEXT, MIGRATE_LOCK, LAYOUT_MARKER]);
  const targets = new Map<string, string>();
  const claim = (to: string, from: string) => {
    const other = targets.get(to) ?? (existsSync(resolve(next, to)) ? resolve(next, to) : null);
    if (other) throw new Error(`both ${from} and ${other} exist; merge them by hand`);
    targets.set(to, from);
  };
  for (const name of readdirSync(root)) {
    if (skip.has(name)) continue;
    const from = resolve(root, name);
    if (RETRO_LOG.test(name) && lstatSync(from).isFile()) {
      claim(`retro-logs/${name}`, from);
    } else if (name === 'retro-logs' && lstatSync(from).isDirectory()) {
      for (const log of readdirSync(from)) claim(`retro-logs/${log}`, resolve(from, log));
    } else {
      claim(name, from);
    }
  }
}

// Every entry of the earlier workspace, the root itself, moves into a staging folder that
// becomes workspace/. A run that stopped half way continues from the staging folder. The
// root is scanned until empty, so a folder a session created meanwhile moves too, and the
// marker is written before the last move, so a stop between the two cannot leave a root
// that looks like an earlier workspace holding a repository named workspace.
function migrateWorkspace(root: string) {
  workspaceClashes(root);
  const next = resolve(root, WORKSPACE_NEXT);
  mkdirSync(next, { recursive: true, mode: 0o700 });
  const skip = new Set([WORKSPACE_NEXT, MIGRATE_LOCK, LAYOUT_MARKER]);
  for (let pass = 0; pass < 5; pass++) {
    const names = readdirSync(root).filter((name) => !skip.has(name));
    if (!names.length) break;
    for (const name of names) {
      const from = resolve(root, name);
      const logs = resolve(next, 'retro-logs');
      if (RETRO_LOG.test(name) && lstatSync(from).isFile()) {
        moveLog(from, logs, name);
      } else if (name === 'retro-logs' && lstatSync(from).isDirectory() && existsSync(logs)) {
        for (const log of readdirSync(from)) moveLog(resolve(from, log), logs, log);
        rmdirIfEmpty(from);
      } else {
        if (existsSync(resolve(next, name))) {
          throw new Error(`both ${from} and ${resolve(next, name)} exist; merge them by hand`);
        }
        move(from, resolve(next, name));
      }
    }
  }
  const marker = resolve(root, LAYOUT_MARKER);
  if (!existsSync(marker)) writeFileSync(marker, '2\n', { mode: 0o600 });
  move(next, resolve(root, 'workspace'));
}

function rmdirIfEmpty(path: string) {
  if (existsSync(path) && !readdirSync(path).length) rmSync(path, { recursive: true });
}

function migrateRetroLogs(workspace: string) {
  for (const name of readdirSync(workspace)) {
    const from = resolve(workspace, name);
    if (RETRO_LOG.test(name) && lstatSync(from).isFile()) {
      moveLog(from, resolve(workspace, 'retro-logs'), name);
    }
  }
}

// Job files name their worktree by absolute path, and Git names a linked worktree's path
// in the repository; both follow the move.
function migrateFactory(from: string, to: string) {
  // A job may have recorded the folder through a symlink or by its real path.
  const real = realpathSync(from);
  move(from, to);
  const notes: string[] = [];
  for (const repo of readdirSync(to)) {
    const jobs = join(to, repo, 'jobs');
    if (!existsSync(jobs) || !lstatSync(jobs).isDirectory()) continue;
    for (const id of readdirSync(jobs)) {
      const file = join(jobs, id, 'job.json');
      if (!existsSync(file)) continue;
      let job: { repo?: unknown; worktree?: unknown };
      try {
        job = JSON.parse(readFileSync(file, 'utf8')) as typeof job;
      } catch {
        notes.push(`${file} does not read; its worktree path was not updated`);
        continue;
      }
      if (typeof job.worktree !== 'string') continue;
      const prefix = [from, real].find((path) => (job.worktree as string).startsWith(`${path}/`));
      if (!prefix) {
        notes.push(`${file} names its worktree outside ${from}; it was not updated`);
        continue;
      }
      const worktree = to + job.worktree.slice(prefix.length);
      writeFileSync(`${file}.tmp`, JSON.stringify({ ...job, worktree }, null, 2) + '\n', {
        mode: 0o600,
      });
      renameSync(`${file}.tmp`, file);
      // A linked worktree has a .git file; a container clone has its own .git folder.
      const git = join(worktree, '.git');
      if (typeof job.repo === 'string' && existsSync(git) && lstatSync(git).isFile()) {
        const run = spawnSync('git', ['-C', job.repo, 'worktree', 'repair', worktree], {
          encoding: 'utf8',
        });
        if (run.status !== 0) {
          notes.push(`git worktree repair failed for ${worktree}: ${run.stderr.trim()}`);
        }
      }
    }
  }
  return notes;
}

// Only personal.json is copied. The installed copies in the earlier folder stay in use by
// your harnesses until the installer runs again and installs them under config/.
function migrateConfig(from: string, to: string) {
  mkdirSync(to, { recursive: true, mode: 0o700 });
  const settings = resolve(from, 'personal.json');
  if (existsSync(settings)) copyFileSync(settings, resolve(to, 'personal.json'));
  return [`Run the Halvard installer again so your harnesses use ${to}; then delete ${from}.`];
}

export function migrate(home = homedir(), apply = false) {
  const steps = migrationPlan(home);
  if (!apply || !steps.length) {
    return {
      applied: false,
      steps,
      notes: steps.length
        ? [
            'Preview only. Close running Halvard sessions and factory runs, then run migrate --apply.',
          ]
        : ['Nothing to migrate.'],
    };
  }
  const root = dataRoot(home);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = resolve(root, MIGRATE_LOCK);
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    throw new Error(`another migrate is running; if none is, remove ${lock}`);
  }
  const notes: string[] = [];
  try {
    const factory = steps.find((step) => step.what === 'factory');
    const busy = factory && runningFactory(factory.from);
    if (busy) throw new Error(`a factory process holds ${busy}; stop it before migrating`);
    // Without an earlier workspace the root is empty but for the lock; mark it before
    // factory/ or config/ appears in it.
    if (rootIsCurrent(home)) ensureRoot(home);
    for (const step of steps) {
      if (step.what === 'workspace') migrateWorkspace(root);
      else if (step.what === 'retro-logs') migrateRetroLogs(step.from);
      else if (step.what === 'factory') notes.push(...migrateFactory(step.from, step.to));
      else notes.push(...migrateConfig(step.from, step.to));
    }
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
  notes.push(
    `Harness sandboxes need write access to ${workspaceRoot(home)} only; narrow any grant for ${root} itself.`,
  );
  return { applied: true, steps, notes };
}
