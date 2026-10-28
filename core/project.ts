import type { Project, ProjectConfig } from './types.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { factoryConfig } from './config/factory.ts';
import { flowConfig, personalConfig } from './config/workflow.ts';
import { teamConfig } from './config/team.ts';

export const CONFIG = '.halvard.json';

export function git(root: string, args: string[]) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitRoot(dir: string) {
  if (!existsSync(resolve(dir, '.git'))) return false;
  try {
    return realpathSync(git(dir, ['rev-parse', '--show-toplevel']).trim()) === dir;
  } catch {
    return false;
  }
}

export function findRoot(cwd: string) {
  const start = realpathSync(cwd);
  // Worktrees have a .git file rather than a directory. An enclosing repository
  // wins over a nested configuration, which must not shrink the guarded area.
  // Git ignores an empty or malformed marker and uses the parent, and so do we.
  for (let dir = start; ; dir = dirname(dir)) {
    if (gitRoot(dir)) return dir;
    if (dirname(dir) === dir) break;
  }
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(resolve(dir, CONFIG))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

// The location a write reaches: the real path of the nearest existing
// ancestor, following a dangling symlink to the file it would create.
export function physicalPath(absolute: string) {
  for (let hops = 0; hops < 40; hops++) {
    let parent = absolute;
    while (!existsSync(parent) && !lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()) {
      parent = dirname(parent);
    }
    if (existsSync(parent)) return resolve(realpathSync(parent), relative(parent, absolute));
    absolute = resolve(dirname(parent), readlinkSync(parent), relative(parent, absolute));
  }
  throw new Error('too many levels of symbolic links');
}

// A path is outside the project when neither its physical location nor any
// literal ancestor is in the root. An outside alias that resolves into the
// project is a project path; a path through the root that resolves elsewhere
// is a symlink escape.
export function outsideProject(root: string, cwd: string, file: unknown) {
  if (typeof file !== 'string' || file === '' || file.includes('\0')) return false;
  const absolute = resolve(realpathSync(cwd), file);
  if (inside(root, physicalPath(absolute))) return false;
  for (let dir = absolute; ; dir = dirname(dir)) {
    if (existsSync(dir) && realpathSync(dir) === root) return false;
    if (dirname(dir) === dir) return true;
  }
}

export function inside(root: string, file: string) {
  const rel = relative(root, file);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function projectPath(root: string, cwd: string, file: unknown) {
  if (typeof file !== 'string' || file === '' || file.includes('\0')) {
    throw new Error('missing or invalid file path');
  }
  const physical = physicalPath(resolve(realpathSync(cwd), file));
  if (!inside(root, physical)) {
    throw new Error('file is outside the project or a symlink escapes it');
  }
  return relative(root, physical).split(sep).join('/');
}

export function matches(path: string, patterns: string[]) {
  return patterns.some((pattern) => {
    const regex = pattern
      .split(/(\*\*|\*)/)
      .map((part) =>
        part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      )
      .join('');
    return new RegExp(`^${regex}$`).test(path);
  });
}

function strings(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v)) {
    throw new Error(`${key} must be an array of nonempty strings`);
  }
  return value as string[];
}

export function loadProject(cwd: string, proposed?: unknown): Project {
  const root = findRoot(cwd);
  if (!root) throw new Error('no repository or workflow configuration found');
  const file = resolve(root, CONFIG);
  const raw: unknown = proposed ?? (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
  const keys = [
    'version',
    'protectedBranches',
    'taskFiles',
    'doneMarker',
    'gate',
    'skillRoots',
    'requiredSkills',
    'readCommands',
    'readOnlyTools',
    'extensions',
    'review',
    'stack',
    'team',
    'factory',
    'workflow',
  ];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('workflow configuration must be an object');
  }
  // protectedPaths is accepted from older configurations and ignored; built-in paths stay protected.
  const { protectedPaths, ...input } = raw as Partial<ProjectConfig> & { protectedPaths?: unknown };
  if (protectedPaths !== undefined) strings(protectedPaths, 'protectedPaths');
  for (const key of Object.keys(input)) {
    if (!keys.includes(key)) throw new Error(`unknown workflow option: ${key}`);
  }
  if (input.version !== undefined && input.version !== 1) {
    throw new Error('unsupported workflow configuration version');
  }
  const config = {
    protectedBranches: ['main', 'master'],
    taskFiles: ['docs/tasks/**.md', 'tasks/**.md'],
    doneMarker: '**Status:** done.',
    gate: null,
    skillRoots: ['.agents/skills'],
    requiredSkills: [],
    readCommands: [],
    readOnlyTools: [],
    extensions: [],
    review: null,
    stack: null,
    team: null,
    factory: null,
    ...input,
  } as ProjectConfig;
  if (config.team !== null) config.team = teamConfig(config.team);
  if (config.factory !== null) config.factory = factoryConfig(config.factory);
  for (const key of [
    'protectedBranches',
    'taskFiles',
    'skillRoots',
    'requiredSkills',
    'readOnlyTools',
    'extensions',
  ] as const) {
    strings(config[key], key);
  }
  if (typeof config.doneMarker !== 'string' || !config.doneMarker) {
    throw new Error('doneMarker must be a nonempty string');
  }
  const personal = personalConfig();
  if (!Array.isArray(config.readCommands) || !Array.isArray(personal.readCommands)) {
    throw new Error('readCommands must be an array');
  }
  config.readCommands = [...config.readCommands, ...personal.readCommands];
  config.readCommands.forEach((command) => {
    const prefix = Array.isArray(command) ? command : command?.prefix;
    strings(prefix, 'readCommands prefix');
    if (!prefix.length) throw new Error('empty read command');
    if (Array.isArray(command)) return;
    const { options, positionals } = command;
    if (
      Object.keys(command).some((key) => !['prefix', 'options', 'positionals'].includes(key)) ||
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.entries(options).some(
        ([name, type]) =>
          !/^(?:--[a-zA-Z][\w-]*|-[a-zA-Z])$/.test(name) ||
          !['flag', 'string', 'positiveInteger'].includes(type),
      ) ||
      !positionals ||
      typeof positionals !== 'object' ||
      Array.isArray(positionals) ||
      Object.keys(positionals).some((key) => !['min', 'max'].includes(key)) ||
      !Number.isSafeInteger(positionals.min) ||
      !Number.isSafeInteger(positionals.max) ||
      positionals.min < 0 ||
      positionals.max < positionals.min
    ) {
      throw new Error('invalid readCommands entry');
    }
  });
  for (const key of ['gate', 'review'] as const) {
    if (config[key] === null) continue;
    if (key === 'gate' && Array.isArray(config.gate) && Array.isArray(config.gate[0])) {
      for (const step of config.gate) strings(step, 'gate step');
      if (config.gate.some((step) => step.length === 0)) throw new Error('gate step is empty');
      continue;
    }
    strings(config[key], key);
    if (config[key].length === 0) throw new Error(`${key} command is empty`);
  }
  if (config.stack !== null) {
    const { stack } = config;
    if (
      !stack ||
      typeof stack !== 'object' ||
      Array.isArray(stack) ||
      Object.keys(stack).some((key) => !['name', 'commit', 'modified', 'gate'].includes(key)) ||
      typeof stack.name !== 'string' ||
      !/^[a-z0-9][a-z0-9-]*$/.test(stack.name) ||
      (stack.commit !== null &&
        (typeof stack.commit !== 'string' || !/^[0-9a-f]{7,64}$/.test(stack.commit))) ||
      typeof stack.modified !== 'boolean' ||
      !Array.isArray(stack.gate)
    ) {
      throw new Error('invalid stack entry');
    }
    for (const step of stack.gate) strings(step, 'stack gate step');
    if (stack.gate.some((step) => step.length === 0)) throw new Error('stack gate step is empty');
  }
  const local = config.workflow ?? {};
  if (
    input.workflow === null ||
    (input.workflow !== undefined &&
      (typeof input.workflow !== 'object' || Array.isArray(input.workflow)))
  ) {
    throw new Error('workflow must be an object');
  }
  config.workflow = flowConfig({
    ...personal.workflow,
    ...local,
    reviewers: { ...(personal.workflow.reviewers ?? {}), ...(local.reviewers ?? {}) },
  });
  projectPath(root, root, config.workflow.taskDirectory);
  config.taskFiles = [...new Set([...config.taskFiles, `${config.workflow.taskDirectory}/**.md`])];
  return { root, config };
}

// A gate is one command or a list of steps run in order.
export const gateSteps = (gate: string[] | string[][]) =>
  (Array.isArray(gate[0]) ? gate : [gate]) as string[][];

export function currentBranch(root: string) {
  try {
    return git(root, ['branch', '--show-current']).trim() || null;
  } catch {
    return null;
  }
}

// Another path to the same inode would bypass path-based protection.
export function singleLink(file: string) {
  if ((lstatSync(file, { throwIfNoEntry: false })?.nlink ?? 1) > 1) {
    throw new Error('target has multiple hard links; edit it through a single path');
  }
}

export function readText(root: string, path: string) {
  const file = resolve(root, path);
  if (!existsSync(file)) return '';
  const stat = lstatSync(file);
  if (!stat.isFile()) throw new Error('target is not a regular file');
  singleLink(file);
  if (stat.size > 4 * 1024 * 1024) throw new Error('file exceeds the 4 MiB preview limit');
  return readFileSync(file, 'utf8');
}
