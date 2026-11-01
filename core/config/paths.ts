import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

// Halvard keeps everything it writes for you under one hidden folder:
//
//   ~/.halvard/
//     config/      personal settings and the installed copies; agents never write here
//     factory/     factory jobs, worktrees and boards; agents never write here
//     logs/        the run log of solo and team work, kept for good; agents never write here
//     workspace/   task folders and retro logs; the one folder harness sandboxes may write
//
// HALVARD_DATA moves the whole folder; HALVARD_HOME, HALVARD_WORKSPACE and
// HALVARD_FACTORY_HOME still move one part each. Folders from the earlier layout,
// ~/.config/halvard, ~/.halvard-factory and a ~/.halvard that was itself the workspace,
// stay in use until `halvard migrate` moves them.

export const LAYOUT_MARKER = '.layout';
// Where migrate gathers the earlier workspace before it becomes workspace/.
export const WORKSPACE_NEXT = '.workspace.next';
export const MIGRATE_LOCK = '.migrate.lock';

const env = (name: string) => process.env[name] || null;

export const dataRoot = (home = homedir()) =>
  resolve(env('HALVARD_DATA') ?? resolve(home, '.halvard'));

export const legacyPaths = (home = homedir()) => ({
  personal: resolve(home, '.config/halvard'),
  factory: resolve(home, '.halvard-factory'),
  // The earlier workspace was the root itself.
  workspace: dataRoot(home),
});

// The root uses the new layout once it carries the marker, and while it does not exist or
// is empty. Anything else, even a lone folder named config or workspace, may be an earlier
// workspace's repository. A migration that stopped half way leaves its staging folder, and
// the root stays in the earlier layout until it ends.
export function rootIsCurrent(home = homedir()) {
  const root = dataRoot(home);
  if (!existsSync(root)) return true;
  if (existsSync(resolve(root, WORKSPACE_NEXT))) return false;
  if (existsSync(resolve(root, LAYOUT_MARKER))) return true;
  try {
    return readdirSync(root).every((name) => name === MIGRATE_LOCK);
  } catch {
    return false;
  }
}

// Creates the root with its marker, so a later call cannot take a fresh root for an
// earlier workspace. An earlier workspace is left alone until `halvard migrate`.
export function ensureRoot(home = homedir()) {
  const root = dataRoot(home);
  if (!rootIsCurrent(home)) return root;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const marker = resolve(root, LAYOUT_MARKER);
  if (!existsSync(marker)) {
    try {
      writeFileSync(marker, '2\n', { flag: 'wx', mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  return root;
}

// Creates a folder for Halvard's data, and first the root with its marker when the folder
// lies under it.
export function makeDataDir(path: string, home = homedir()) {
  const root = dataRoot(home);
  if (path === root || path.startsWith(`${root}/`)) ensureRoot(home);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

// A part stays in its earlier folder until migrate creates it under the root: while that
// folder exists, and while the root is still an earlier workspace, so nothing new is
// created inside one.
function inLegacy(home: string, part: string, legacy: string) {
  // In an earlier workspace, config/ or factory/ is a repository's folder.
  if (!rootIsCurrent(home)) return legacy;
  const current = resolve(dataRoot(home), part);
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

// Personal settings; the earlier folder stays in use until migrate creates config/.
export function personalRoot(home = homedir()) {
  const set = env('HALVARD_HOME');
  if (set) return resolve(set);
  return inLegacy(home, 'config', legacyPaths(home).personal);
}

// Task folders and retro logs: the only folder agents write outside a repository.
export function workspaceRoot(home = homedir()) {
  const set = env('HALVARD_WORKSPACE');
  if (set) return resolve(set);
  return rootIsCurrent(home) ? resolve(dataRoot(home), 'workspace') : legacyPaths(home).workspace;
}

// Factory jobs, logs and worktrees.
export function factoryHome(home = homedir()) {
  const set = env('HALVARD_FACTORY_HOME');
  if (set) return resolve(set);
  return inLegacy(home, 'factory', legacyPaths(home).factory);
}

// The run log of solo and team work, kept for good; agents read it but never write it.
export const logRoot = (home = homedir()) => resolve(dataRoot(home), 'logs');

// Retro logs, one per harness, shared by every repository. An earlier workspace kept them
// at its top, and still does until migrate.
export const retroLogRoot = (home = homedir()) =>
  !env('HALVARD_WORKSPACE') && !rootIsCurrent(home)
    ? workspaceRoot(home)
    : resolve(workspaceRoot(home), 'retro-logs');

// The workspace set by HALVARD_WORKSPACE is the data root or holds it, so config/ and
// factory/ there would sit inside the folder agents write.
export function workspaceHoldsRoot(home = homedir()) {
  const set = env('HALVARD_WORKSPACE');
  if (!set) return false;
  const workspace = realPath(resolve(set));
  const root = realPath(dataRoot(home));
  return root === workspace || root.startsWith(`${workspace}/`);
}

// The real path of a folder that exists, else the path as given.
export const realPath = (path: string) => (existsSync(path) ? realpathSync(path) : path);

// A project that holds Halvard's data, such as a repository at the home folder, does not
// make that data project files.
export function projectHoldsData(project: string, home = homedir()) {
  const root = realPath(project);
  return protectedRoots(home).some((path) => {
    const real = realPath(path);
    return real === root || real.startsWith(`${root}/`);
  });
}

// Folders under Halvard's data that agents may read but never write. The workspace is
// excluded even when it sits inside one of them.
export function protectedRoots(home = homedir()) {
  const workspace = workspaceRoot(home);
  return [dataRoot(home), personalRoot(home), factoryHome(home)].filter(
    (path, i, all) => all.indexOf(path) === i && path !== workspace,
  );
}

// Data in the earlier layout that `halvard migrate` would move. Parts set by an
// environment variable stay where they are.
export function legacyData(home = homedir()) {
  const legacy = legacyPaths(home);
  const found: string[] = [];
  if (!env('HALVARD_WORKSPACE') && !rootIsCurrent(home)) found.push(legacy.workspace);
  if (
    !env('HALVARD_HOME') &&
    personalRoot(home) === legacy.personal &&
    existsSync(legacy.personal)
  ) {
    found.push(legacy.personal);
  }
  if (
    !env('HALVARD_FACTORY_HOME') &&
    factoryHome(home) === legacy.factory &&
    existsSync(legacy.factory)
  ) {
    found.push(legacy.factory);
  }
  return found;
}
