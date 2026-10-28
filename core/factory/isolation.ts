import type { FactoryJob } from './store.ts';
import type { Context } from './context.ts';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { personalRoot, workspaceRoot } from '../config/paths.ts';
import { boxCommand, boxName, removeBox, type Box } from './container.ts';
import { scrubbedEnv, type Wrapped } from './harness.ts';
import { gitRunner } from './ship.ts';
import { jobFile } from './store.ts';

// An empty gh configuration for agents, so the gh CLI there has no login.
export function ghShield(ctx: Context, job: FactoryJob) {
  const dir = jobFile(ctx.root, job.id, 'gh-empty');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// In container mode a step runs in its own container, with the checkout and the listed
// folders mounted at the same paths; otherwise it runs here with the scrubbed environment.
export function boxed(
  ctx: Context,
  job: FactoryJob,
  step: string,
  argv: string[],
  box: Box,
): Wrapped {
  const config = ctx.factory.container;
  if (!config) return { argv, cleanup: () => {} };
  const name = boxName([basename(ctx.root), job.id, step]);
  return { argv: boxCommand(config, name, box, argv), cleanup: () => removeBox(name) };
}

// The checkout writable, its Git directory read-only: a container that could write .git could
// leave links there that the runner's own Git commands on the host write through.
export const checkoutMounts = (checkout: string) => [
  { path: checkout, readonly: false },
  { path: join(checkout, '.git'), readonly: true },
];

// Git on both sides of a fingerprint must read the same configuration; your global and
// system files, such as a personal excludes file, exist only on the host.
const ISOLATED_GIT = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

// Runs fn with Git reading only the repository's own configuration, in container mode, and
// never starting an fsmonitor the clone's configuration names.
export function isolated<T>(ctx: Context, fn: () => T): T {
  if (!ctx.factory.container) return fn();
  const offset = Number(process.env.GIT_CONFIG_COUNT) || 0;
  const extra = {
    ...ISOLATED_GIT,
    GIT_CONFIG_COUNT: String(offset + 1),
    [`GIT_CONFIG_KEY_${offset}`]: 'core.fsmonitor',
    [`GIT_CONFIG_VALUE_${offset}`]: 'false',
  };
  const saved = Object.keys(extra).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, extra);
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// A link or special file in the clone's Git directory would let Git on the host write
// outside the clone; containers mount .git read-only, and this checks it before Git runs.
export function unsafeGitDir(checkout: string): string | null {
  const walk = (dir: string): string | null => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const stat = lstatSync(full);
      if (stat.isDirectory()) {
        const found = walk(full);
        if (found) return found;
      } else if (!stat.isFile()) {
        return `${relative(checkout, full)} in the clone's Git directory is not a plain file`;
      }
    }
    return null;
  };
  return walk(join(checkout, '.git'));
}

// The first submodule in the clone's index, if any.
export function gitlink(ctx: Context, checkout: string) {
  const index = isolated(ctx, () => gitRunner(checkout, ['ls-files', '--stage', '-z']));
  const link = index.split('\0').find((line) => line.startsWith('160000 '));
  return link ? link.slice(link.indexOf('\t') + 1) : null;
}

// A repository inside the clone has a configuration and attributes the agent wrote, and the
// host's Git would run its fsmonitor or filters while walking the tree. Containers may hold
// none: no .git below the top, in any case, and no gitlink in the index. Folders Git ignores
// are skipped, because the host's Git never walks them, and setup may leave a .git there.
export function nestedRepo(ctx: Context, checkout: string): string | null {
  const ignored = new Set(
    isolated(ctx, () =>
      gitRunner(checkout, [
        'ls-files',
        '-z',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--directory',
      ]),
    )
      .split('\0')
      .filter((path) => path.endsWith('/'))
      .map((path) => path.slice(0, -1)),
  );
  const stack = [checkout];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.name.toLowerCase() === '.git') {
        if (dir !== checkout) return `${relative(checkout, full)} is a nested repository`;
        continue;
      }
      if (entry.isDirectory() && !ignored.has(relative(checkout, full))) stack.push(full);
    }
  }
  const link = gitlink(ctx, checkout);
  return link ? `${link} is a submodule` : null;
}

// The variables the container block lists reach the container even when they look like
// credentials, because you listed them; nothing else does.
export function listedEnv(ctx: Context) {
  const names = ctx.factory.container?.env ?? [];
  return Object.fromEntries(
    names.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]!]])),
  );
}

// The runner's state for a job's gate and review receipts in container mode. Agent
// containers never mount it. Code the agent wrote runs in the gate's container, which does,
// but trust rests on each step's own exit status and output, not on receipts found there.
function stateFolder(ctx: Context, job: FactoryJob) {
  const dir = jobFile(ctx.root, job.id, 'state');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// The folders a runner step needs: the checkout, the receipts, the task workspace and,
// read-only, your personal settings, which feed the configuration and the tree fingerprint.
export function runnerBox(ctx: Context, job: FactoryJob, checkout: string): Box {
  const workspace = resolve(workspaceRoot(), basename(checkout));
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const personal = resolve(personalRoot(), 'personal.json');
  return {
    workdir: checkout,
    mounts: [
      ...checkoutMounts(checkout),
      { path: stateFolder(ctx, job), readonly: false },
      { path: workspace, readonly: false },
      // Only the settings file, by its real path, so a linked file reads the same inside.
      ...(existsSync(personal)
        ? [{ path: personal, readonly: true, source: realpathSync(personal) }]
        : []),
    ],
    env: ['TMPDIR', 'HALVARD_HOME', 'HALVARD_WORKSPACE', ...Object.keys(ISOLATED_GIT)],
  };
}

export function runnerEnv(ctx: Context, job: FactoryJob) {
  return scrubbedEnv(
    ghShield(ctx, job),
    ctx.factory.container
      ? {
          ...listedEnv(ctx),
          ...ISOLATED_GIT,
          TMPDIR: stateFolder(ctx, job),
          HALVARD_HOME: personalRoot(),
          HALVARD_WORKSPACE: workspaceRoot(),
        }
      : {},
  );
}
