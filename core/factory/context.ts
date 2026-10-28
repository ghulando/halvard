import type { FactoryConfig, Project } from '../types.ts';
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { personalRoot, workspaceRoot } from '../config/paths.ts';
import { loadProject } from '../project.ts';
import { factoryHome } from './store.ts';

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
