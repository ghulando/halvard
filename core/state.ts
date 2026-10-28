import type { WorkflowState } from './types.ts';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { git } from './project.ts';
import { personalRoot } from './config/paths.ts';

export const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function sessionKey(root: string, harness: string, session: unknown) {
  if (typeof session !== 'string' || !session || session.length > 512) {
    throw new Error('a session id is required');
  }
  return digest([realpathSync(root), harness, session]);
}

export function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    (process.getuid && stat.uid !== process.getuid()) ||
    stat.mode & 0o077
  ) {
    throw new Error('unsafe workflow state directory');
  }
  return path;
}

export function stateDirectory(root: string) {
  const base = privateDirectory(join(tmpdir(), `halvard-${process.getuid?.() ?? 'user'}`));
  return privateDirectory(join(base, digest(root)));
}

// Legacy directory locks have no owner record and are never reclaimed.
function lockOwner(lock: string) {
  try {
    const pid = Number(readFileSync(lock, 'utf8'));
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch (err) {
    if (['ENOENT', 'EISDIR'].includes((err as NodeJS.ErrnoException).code as string)) return null;
    throw err;
  }
}

function running(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// A hook killed by its harness timeout leaves its lock behind. Reclaim it only
// when the recorded owner no longer exists; gate and review runs are tracked
// in state, not by this lock. Only the holder of the reclaim guard removes a
// stale lock, and nothing else removes a dead owner's lock, so the lock it
// checked is the lock it removes. A reclaimer that dies here leaves the guard
// behind and waiters fail closed, as they did before reclamation existed.
function reclaim(lock: string) {
  const owner = lockOwner(lock);
  if (!owner || running(owner)) return false;
  const guard = `${lock}.reclaim`;
  try {
    mkdirSync(guard, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    const current = lockOwner(lock);
    if (!current || running(current)) return false;
    rmSync(lock);
    return true;
  } finally {
    rmSync(guard, { recursive: true });
  }
}

export async function withState<T>(
  root: string,
  key: string,
  action: (state: WorkflowState) => T | Promise<T>,
): Promise<T> {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('invalid state key');
  const dir = stateDirectory(root);
  const lock = join(dir, `${key}.lock`);
  const file = join(dir, `${key}.json`);
  // Link a file that already holds the owner's PID, so a lock never exists without one.
  const owner = join(dir, `${key}.${randomUUID()}.owner`);
  writeFileSync(owner, String(process.pid), { mode: 0o600, flag: 'wx' });
  let locked = false;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        linkSync(owner, lock);
        locked = true;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        if (reclaim(lock)) continue;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  } finally {
    rmSync(owner);
  }
  if (!locked) {
    throw new Error(
      'workflow state is busy; retry (remove a stale lock only after its owner stops)',
    );
  }
  try {
    let state: WorkflowState = {
      revision: 0,
      pass: null,
      pending: null,
      approved: null,
      gate: null,
    };
    if (existsSync(file)) {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('invalid workflow state file');
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      state = parsed as WorkflowState;
      if (!Number.isSafeInteger(state.revision) || state.revision < 0) {
        throw new Error('corrupt workflow state');
      }
    }
    const result = await action(state);
    const temp = join(dir, `${key}.${randomUUID()}.tmp`);
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
    return result;
  } finally {
    rmSync(lock);
  }
}

// Hooks run under a harness timeout, and a timed-out hook lets the tool run.
// Hook callers pass a deadline below that timeout so an oversized tree fails closed.
export const HOOK_BUDGET = 40000;

const OVER_BUDGET =
  'worktree too large to verify within the hook time budget; ignore generated or large files';

// Include index metadata and HEAD: a checkout, chmod, add, delete or untracked
// source edit must invalidate a pass even if the guard never observed it.
export function fingerprint(
  root: string,
  ancestors: Set<string> = new Set(),
  deadline = Infinity,
): string {
  root = realpathSync(root);
  if (ancestors.has(root)) throw new Error('recursive submodule path');
  const visited = new Set([...ancestors, root]);
  const hash = createHash('sha256');
  const add = (value: string | Buffer) => {
    const bytes = Buffer.from(value);
    hash.update(String(bytes.length) + ':');
    hash.update(bytes);
  };
  const personal = join(personalRoot(), 'personal.json');
  add(existsSync(personal) ? readFileSync(personal) : 'no personal config');
  try {
    add(git(root, ['rev-parse', 'HEAD']));
  } catch {
    add('unborn');
  }
  try {
    add(git(root, ['symbolic-ref', '--quiet', 'HEAD']));
  } catch {
    add('detached');
  }
  const index = git(root, ['ls-files', '--stage', '-z']);
  add(index);
  const submodules = new Set(
    index
      .split('\0')
      .filter((entry) => entry.startsWith('160000 '))
      .map((entry) => entry.slice(entry.indexOf('\t') + 1)),
  );
  const files = [
    ...new Set(
      git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
        .split('\0')
        .filter(Boolean),
    ),
  ].sort();
  const buffer = Buffer.alloc(64 * 1024);
  for (const path of files) {
    if (Date.now() > deadline) throw new Error(OVER_BUDGET);
    add(path);
    const file = resolve(root, path);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) {
      add('missing');
      continue;
    }
    add(String(stat.mode));
    if (stat.isSymbolicLink()) {
      add(readlinkSync(file));
      continue;
    }
    if (submodules.has(path) && stat.isDirectory()) {
      if (!existsSync(join(file, '.git'))) {
        add('uninitialized gitlink');
        continue;
      }
      add(fingerprint(file, visited, deadline));
      continue;
    }
    if (stat.isDirectory() && existsSync(join(file, '.git'))) {
      let valid;
      try {
        // An empty .git directory can make Git silently use the parent repo.
        valid =
          realpathSync(git(file, ['rev-parse', '--show-toplevel']).trim()) === realpathSync(file);
      } catch {
        valid = false;
      }
      if (valid) {
        add(fingerprint(file, visited, deadline));
      } else {
        add('unreadable nested repository');
      }
      continue;
    }
    if (!stat.isFile()) {
      add('non-file');
      continue;
    }
    const fileHash = createHash('sha256');
    const fd = openSync(file, 'r');
    try {
      let n;
      while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        if (Date.now() > deadline) throw new Error(OVER_BUDGET);
        fileHash.update(buffer.subarray(0, n));
      }
    } finally {
      closeSync(fd);
    }
    add(fileHash.digest('hex'));
  }
  if (Date.now() > deadline) throw new Error(OVER_BUDGET);
  return hash.digest('hex');
}

export function invalidate(state: WorkflowState) {
  state.revision++;
  state.pass = null;
  state.approved = null;
}
