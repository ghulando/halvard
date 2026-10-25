import type {
  AutoMergeConfig,
  ContainerConfig,
  FactoryConfig,
  FlowConfig,
  Harness,
  HoldoutCheck,
  ReadCommand,
  RetroConfig,
  TeamConfig,
} from './types.ts';
import { HARNESSES } from './types.ts';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const authors: string[] = [...HARNESSES];
export const AUTHOR_ERROR = `author must be ${authors.join(', ')}`;

// Headless review providers: each runs a CLI on this machine.
export const providers = ['claude', 'codex', 'grok', 'cursor', 'ollama'];

export const reviewerChoices: Record<string, string[]> = {
  pi: ['claude', 'codex', 'grok', 'cursor'],
  codex: ['ollama', 'claude', 'grok', 'cursor'],
  claude: ['ollama', 'codex', 'grok', 'cursor'],
  grok: ['ollama', 'claude', 'codex', 'cursor'],
  cursor: ['ollama', 'claude', 'codex', 'grok'],
};

export const assignment = (workflow: FlowConfig, author: string) =>
  Object.hasOwn(workflow.reviewers, author) && workflow.reviewers[author]!.reviewer !== undefined
    ? workflow.reviewers[author]!
    : null;

// An assigned author has exactly one reviewer; others choose among unassigned providers.
export const eligibleReviewers = (workflow: FlowConfig, author: string) => {
  const assigned = assignment(workflow, author);
  if (assigned) return [assigned.reviewer!];
  return (reviewerChoices[author] ?? []).filter(
    (name) =>
      Object.hasOwn(workflow.reviewers, name) && workflow.reviewers[name]!.reviewer === undefined,
  );
};

export function reviewerSettings(workflow: FlowConfig, author: string, reviewer: string) {
  if (!eligibleReviewers(workflow, author).includes(reviewer)) return null;
  const { model, transport } = assignment(workflow, author) ?? workflow.reviewers[reviewer]!;
  return { model, transport };
}

export const personalRoot = () =>
  resolve(process.env.HALVARD_HOME || resolve(homedir(), '.config/halvard'));

// Team briefs and reports live here, one folder per repository and task.
export const workspaceRoot = (home = homedir()) =>
  resolve(process.env.HALVARD_WORKSPACE || resolve(home, '.halvard'));

export function flowConfig(input: unknown = {}): FlowConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('workflow must be an object');
  }
  const defaults: FlowConfig = {
    taskDirectory: 'docs/tasks',
    baseBranch: 'main',
    featurePrefix: 'feature/',
    fixPrefix: 'fix/',
    requireReview: true,
    reviewers: {},
    reviewTimeout: 900,
    reviewExclude: [],
    reviewContext: [],
    reviewExceptions: {},
    reviewDeferrals: {},
    stacks: null,
  };
  // shellApproval is accepted from older configurations; shell commands no longer ask.
  const { shellApproval, ...settings } = input as Record<string, unknown>;
  for (const key of Object.keys(settings)) {
    if (!Object.hasOwn(defaults, key)) throw new Error(`unknown workflow setting: ${key}`);
  }
  if (shellApproval !== undefined && !['workflow', 'native'].includes(shellApproval as string)) {
    throw new Error('invalid workflow shellApproval');
  }
  const value = { ...defaults, ...settings } as FlowConfig;
  for (const key of ['taskDirectory', 'baseBranch', 'featurePrefix', 'fixPrefix'] as const) {
    if (
      typeof value[key] !== 'string' ||
      !value[key] ||
      value[key].includes('\0') ||
      /[\r\n]/.test(value[key])
    ) {
      throw new Error(`invalid workflow ${key}`);
    }
  }
  if (
    value.taskDirectory.startsWith('/') ||
    value.taskDirectory.split('/').some((part) => part === '..' || !part)
  ) {
    throw new Error('taskDirectory must be a relative directory');
  }
  if (typeof value.requireReview !== 'boolean') throw new Error('requireReview must be boolean');
  // A home-relative path lets teammates share one project setting.
  if (
    value.stacks !== null &&
    (typeof value.stacks !== 'string' ||
      !(value.stacks.startsWith('/') || value.stacks.startsWith('~/')) ||
      /[\r\n\0]/.test(value.stacks))
  ) {
    throw new Error('stacks must be an absolute or ~/ directory path');
  }
  for (const key of ['reviewExclude', 'reviewContext'] as const) {
    if (
      !Array.isArray(value[key]) ||
      value[key].some(
        (path) =>
          typeof path !== 'string' ||
          !path ||
          path.startsWith('/') ||
          path.split('/').includes('..'),
      )
    ) {
      throw new Error(`${key} must contain repo-relative patterns`);
    }
  }
  if (
    !Number.isInteger(value.reviewTimeout) ||
    value.reviewTimeout < 1 ||
    value.reviewTimeout > 3600
  ) {
    throw new Error('reviewTimeout must be 1..3600 seconds');
  }
  if (
    !value.reviewExceptions ||
    typeof value.reviewExceptions !== 'object' ||
    Array.isArray(value.reviewExceptions)
  ) {
    throw new Error('reviewExceptions must be an object');
  }
  for (const [task, exception] of Object.entries(value.reviewExceptions)) {
    if (
      !task ||
      task.startsWith('/') ||
      task.split('/').some((part) => !part || part === '..') ||
      /[\r\n\0]/.test(task) ||
      !exception ||
      typeof exception !== 'object' ||
      Array.isArray(exception) ||
      Object.keys(exception).some((key) => !['maxRound', 'reason'].includes(key)) ||
      !Number.isInteger(exception.maxRound) ||
      exception.maxRound < 3 ||
      exception.maxRound > 10 ||
      typeof exception.reason !== 'string' ||
      !exception.reason.trim()
    ) {
      throw new Error('invalid task review exception');
    }
  }
  if (
    !value.reviewDeferrals ||
    typeof value.reviewDeferrals !== 'object' ||
    Array.isArray(value.reviewDeferrals)
  ) {
    throw new Error('reviewDeferrals must be an object');
  }
  // Each entry is a user decision, so it lives in configuration the guard asks before editing.
  for (const [task, deferrals] of Object.entries(value.reviewDeferrals)) {
    if (
      !task ||
      task.startsWith('/') ||
      task.split('/').some((part) => !part || part === '..') ||
      /[\r\n\0]/.test(task) ||
      !Array.isArray(deferrals) ||
      deferrals.some(
        (deferral) =>
          !deferral ||
          typeof deferral !== 'object' ||
          Array.isArray(deferral) ||
          Object.keys(deferral).some(
            (key) => !['finding', 'approvedBy', 'reason', 'override'].includes(key),
          ) ||
          typeof deferral.finding !== 'string' ||
          !/^round(?:[1-9]|10)#[1-9][0-9]*$/.test(deferral.finding) ||
          ['approvedBy', 'reason'].some(
            (key) =>
              typeof deferral[key as 'approvedBy' | 'reason'] !== 'string' ||
              !deferral[key as 'approvedBy' | 'reason'].trim() ||
              /[\r\n\0]/.test(deferral[key as 'approvedBy' | 'reason']),
          ) ||
          (deferral.override !== undefined && deferral.override !== true),
      ) ||
      new Set(deferrals.map((deferral) => deferral.finding)).size !== deferrals.length
    ) {
      throw new Error('invalid task review deferral');
    }
  }
  if (!value.reviewers || typeof value.reviewers !== 'object' || Array.isArray(value.reviewers)) {
    throw new Error('reviewers must be an object');
  }
  for (const [key, settings] of Object.entries(value.reviewers)) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error('invalid reviewer');
    }
    // An entry with `reviewer` is keyed by author and assigns that author's reviewer.
    const assigned = settings.reviewer !== undefined;
    const name = assigned ? settings.reviewer! : key;
    if (assigned) {
      if (!authors.includes(key)) throw new Error(`reviewer assignment for unknown author ${key}`);
      if (typeof name !== 'string' || !providers.includes(name)) {
        throw new Error(`invalid reviewer for author ${key}`);
      }
      if (name === key ? !settings.model : !reviewerChoices[key]!.includes(name)) {
        throw new Error(
          name === key
            ? `${key} reviewing its own work requires an explicit model`
            : `${name} cannot review work by ${key}`,
        );
      }
    } else if (!providers.includes(key)) {
      throw new Error('invalid reviewer');
    }
    if (
      Object.keys(settings).some(
        (field) =>
          field !== 'model' &&
          !(assigned && field === 'reviewer') &&
          !(name === 'ollama' && field === 'transport'),
      ) ||
      (settings.model !== undefined &&
        (typeof settings.model !== 'string' ||
          !settings.model ||
          settings.model.startsWith('-') ||
          /[\r\n\0]/.test(settings.model)))
    ) {
      throw new Error(`invalid ${name} reviewer settings`);
    }
    if (settings.transport !== undefined && !['cli', 'pi'].includes(settings.transport)) {
      throw new Error('Ollama transport must be cli or pi');
    }
    if (name === 'ollama' && !settings.model) throw new Error('Ollama requires an explicit model');
  }
  return value;
}

// personal.json holds workflow settings plus read commands trusted in every repo.
// Projects validate the read commands together with their own.
export function personalSettings(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('personal configuration must be an object');
  }
  const { readCommands = [], ...workflow } = input as Partial<FlowConfig> & {
    readCommands?: ReadCommand[];
  };
  // The guard asks before project configuration edits but not before personal ones.
  const { reviewDeferrals } = workflow;
  if (
    reviewDeferrals &&
    typeof reviewDeferrals === 'object' &&
    Object.keys(reviewDeferrals).length
  ) {
    throw new Error('reviewDeferrals belong in project configuration');
  }
  flowConfig(workflow);
  return { workflow, readCommands };
}

export function personalConfig() {
  const file = resolve(personalRoot(), 'personal.json');
  if (!existsSync(file)) return { workflow: {}, readCommands: [] };
  if (statSync(file).size > 64 * 1024) throw new Error('personal configuration is oversized');
  return personalSettings(JSON.parse(readFileSync(file, 'utf8')));
}

const TEAM_ROLES = ['lead', 'dev', 'reviewer'] as const;
const APPROVALS = ['reads-edits-gate', 'none'];

const isHarness = (value: unknown): value is Harness =>
  typeof value === 'string' && (HARNESSES as readonly string[]).includes(value);

// A Herdr team: three required roles and an optional investigator, each one harness.
export function teamConfig(input: unknown): TeamConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('team must be an object');
  }
  const value = input as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (![...TEAM_ROLES, 'investigator', 'monitor'].includes(key)) {
      throw new Error(`unknown team option: ${key}`);
    }
  }
  for (const role of TEAM_ROLES) {
    if (!isHarness(value[role])) throw new Error(`team ${role} must be ${HARNESSES.join(', ')}`);
  }
  const investigator = value.investigator ?? null;
  if (investigator !== null && !isHarness(investigator)) {
    throw new Error(`team investigator must be ${HARNESSES.join(', ')} or null`);
  }
  if (value.lead === value.dev)
    throw new Error('the team lead and dev must be different harnesses');
  if (value.reviewer === value.dev) {
    throw new Error('the team reviewer must not be the dev, whose work it reviews');
  }
  if (
    value.monitor !== undefined &&
    (!value.monitor || typeof value.monitor !== 'object' || Array.isArray(value.monitor))
  ) {
    throw new Error('team monitor must be an object');
  }
  const monitor: Record<string, unknown> = {
    watch: true,
    nudge: true,
    approve: 'reads-edits-gate',
    ...(value.monitor as Record<string, unknown> | undefined),
  };
  if (
    Object.keys(monitor).some((key) => !['watch', 'nudge', 'approve'].includes(key)) ||
    typeof monitor.watch !== 'boolean' ||
    typeof monitor.nudge !== 'boolean' ||
    !APPROVALS.includes(monitor.approve as string)
  ) {
    throw new Error(
      'team monitor takes watch and nudge (true or false) and approve (reads-edits-gate or none)',
    );
  }
  return {
    lead: value.lead as Harness,
    dev: value.dev as Harness,
    reviewer: value.reviewer as Harness,
    investigator: investigator as Harness | null,
    monitor: monitor as TeamConfig['monitor'],
  };
}

// Paths whose change always makes a factory PR high risk. Repositories add their own.
const RISK_PATHS = [
  '.github/**',
  '.gitlab-ci.yml',
  '.halvard.json',
  '.claude/**',
  '.codex/**',
  '.grok/**',
  '.cursor/**',
  '.agents/**',
  '.pi/**',
  // Guidance every later agent and reviewer reads.
  'AGENTS.md',
  'CLAUDE.md',
  '**/AGENTS.md',
  '**/CLAUDE.md',
];

const argv = (value: unknown, name: string) => {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some((part) => typeof part !== 'string' || !part || /[\0\r\n]/.test(part))
  ) {
    throw new Error(`factory ${name} must be a nonempty array of strings`);
  }
  return value as string[];
};

const seconds = (value: unknown, name: string) => {
  if (!Number.isInteger(value) || (value as number) < 60 || (value as number) > 4 * 3600) {
    throw new Error(`factory timeouts.${name} must be 60..14400 seconds`);
  }
  return value as number;
};

// The factory block of .halvard.json. Edits to it ask like every workflow setting.
export function factoryConfig(input: unknown): FactoryConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('factory must be an object');
  }
  const value = input as Record<string, unknown>;
  const keys = [
    'author',
    'reviewers',
    'setup',
    'auth',
    'harnessArgs',
    'timeouts',
    'budgetUsd',
    'maxFixPasses',
    'draft',
    'riskPaths',
    'monthlyUsd',
    'pollSeconds',
    'tests',
    'concurrency',
    'container',
    'holdout',
    'autoMerge',
    'retro',
  ];
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`unknown factory option: ${key}`);
  }
  const author = value.author ?? 'claude';
  if (!isHarness(author)) throw new Error(`factory author must be ${HARNESSES.join(', ')}`);
  const reviewers = value.reviewers ?? [];
  if (
    !Array.isArray(reviewers) ||
    reviewers.some((name) => typeof name !== 'string' || !providers.includes(name)) ||
    new Set(reviewers).size !== reviewers.length
  ) {
    throw new Error(`factory reviewers must list distinct providers: ${providers.join(', ')}`);
  }
  const rawSetup = value.setup ?? [];
  if (!Array.isArray(rawSetup)) throw new Error('factory setup must be a command or a list');
  const setup = (
    rawSetup.length && !Array.isArray(rawSetup[0]) ? [rawSetup] : (rawSetup as unknown[])
  ).map((step) => argv(step, 'setup step'));
  const harnessMap = <T>(raw: unknown, name: string, check: (entry: unknown) => T) => {
    if (raw === undefined) return {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`factory ${name} must be an object keyed by harness`);
    }
    return Object.fromEntries(
      Object.entries(raw).map(([harness, entry]) => {
        if (!isHarness(harness))
          throw new Error(`factory ${name} names unknown harness ${harness}`);
        return [harness, check(entry)];
      }),
    ) as Partial<Record<Harness, T>>;
  };
  const auth = harnessMap(value.auth, 'auth', (entry) => {
    if (entry !== 'api' && entry !== 'subscription') {
      throw new Error('factory auth values must be api or subscription');
    }
    return entry;
  });
  const harnessArgs = harnessMap(value.harnessArgs, 'harnessArgs', (entry) =>
    Array.isArray(entry) && !entry.length ? [] : argv(entry, 'harnessArgs entry'),
  );
  const timeouts = (value.timeouts === undefined ? {} : value.timeouts) as Record<string, unknown>;
  if (!timeouts || typeof timeouts !== 'object' || Array.isArray(timeouts)) {
    throw new Error('factory timeouts must be an object');
  }
  for (const key of Object.keys(timeouts)) {
    if (!['plan', 'build'].includes(key)) throw new Error(`unknown factory timeout: ${key}`);
  }
  const budgetUsd = value.budgetUsd ?? 5;
  if (typeof budgetUsd !== 'number' || !(budgetUsd > 0) || budgetUsd > 1000) {
    throw new Error('factory budgetUsd must be a positive number up to 1000');
  }
  const maxFixPasses = value.maxFixPasses ?? 2;
  if (
    !Number.isInteger(maxFixPasses) ||
    (maxFixPasses as number) < 0 ||
    (maxFixPasses as number) > 3
  ) {
    throw new Error('factory maxFixPasses must be 0..3');
  }
  const draft = value.draft ?? true;
  if (typeof draft !== 'boolean') throw new Error('factory draft must be true or false');
  const riskPaths = value.riskPaths ?? [];
  if (
    !Array.isArray(riskPaths) ||
    riskPaths.some(
      (path) =>
        typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').includes('..'),
    )
  ) {
    throw new Error('factory riskPaths must contain repo-relative patterns');
  }
  const monthlyUsd = value.monthlyUsd ?? 200;
  if (typeof monthlyUsd !== 'number' || !(monthlyUsd > 0) || monthlyUsd > 100000) {
    throw new Error('factory monthlyUsd must be a positive number');
  }
  const pollSeconds = value.pollSeconds ?? 300;
  if (
    !Number.isInteger(pollSeconds) ||
    (pollSeconds as number) < 60 ||
    (pollSeconds as number) > 3600
  ) {
    throw new Error('factory pollSeconds must be 60..3600');
  }
  let tests: FactoryConfig['tests'] = null;
  if (value.tests !== undefined && value.tests !== null) {
    const raw = value.tests as Record<string, unknown>;
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      Object.keys(raw).some((key) => !['by', 'dir'].includes(key)) ||
      !isHarness(raw.by) ||
      typeof raw.dir !== 'string' ||
      raw.dir.startsWith('/') ||
      !raw.dir.replace(/\/+$/, '') ||
      raw.dir
        .replace(/\/+$/, '')
        .split('/')
        .some((part) => !part || part === '..' || part === '.git')
    ) {
      throw new Error('factory tests needs by (a harness) and dir (a relative folder)');
    }
    // The point of the second harness is that the builder did not write its own tests.
    if (raw.by === author)
      throw new Error('factory tests must be written by another harness than the author');
    tests = { by: raw.by, dir: raw.dir.replace(/\/+$/, '') };
  }
  const concurrency = value.concurrency ?? 1;
  if (
    !Number.isInteger(concurrency) ||
    (concurrency as number) < 1 ||
    (concurrency as number) > 4
  ) {
    throw new Error('factory concurrency must be 1..4');
  }
  const container =
    value.container === undefined || value.container === null
      ? null
      : containerConfig(value.container);
  const autoMerge = autoMergeConfig(value.autoMerge);
  // Without containers the agent runs as you and could rewrite what the runner recorded.
  if (autoMerge.enabled && !container) {
    throw new Error('factory autoMerge needs container mode before it may merge');
  }
  if (autoMerge.enabled && !autoMerge.requiredChecks.length) {
    throw new Error('factory autoMerge needs requiredChecks before it may merge');
  }
  const retro = value.retro === undefined || value.retro === null ? null : retroConfig(value.retro);
  return {
    author,
    reviewers: reviewers as string[],
    setup,
    auth,
    harnessArgs,
    timeouts: {
      plan: seconds(timeouts.plan ?? 900, 'plan'),
      build: seconds(timeouts.build ?? 2700, 'build'),
    },
    budgetUsd,
    maxFixPasses: maxFixPasses as number,
    draft,
    // What a retro may change is guidance, so a person always reads it.
    riskPaths: [...new Set([...RISK_PATHS, ...(riskPaths as string[]), ...(retro?.paths ?? [])])],
    monthlyUsd,
    pollSeconds: pollSeconds as number,
    tests,
    concurrency: concurrency as number,
    container,
    holdout: holdoutChecks(value.holdout),
    autoMerge,
    retro,
  };
}

const relativePatterns = (value: unknown, name: string) => {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some(
      (path) =>
        typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').includes('..'),
    )
  ) {
    throw new Error(`factory ${name} must list repo-relative patterns`);
  }
  return value as string[];
};

const object = (value: unknown, name: string, keys: string[]) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`factory ${name} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`unknown factory ${name} option: ${key}`);
  }
  return value as Record<string, unknown>;
};

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

function holdoutChecks(input: unknown): HoldoutCheck[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error('factory holdout must be a list of checks');
  const checks = input.map((entry) => {
    const value = object(entry, 'holdout', ['name', 'dir', 'command', 'sample', 'blocking']);
    if (typeof value.name !== 'string' || !NAME.test(value.name)) {
      throw new Error('factory holdout name must be a short lowercase slug');
    }
    // The scenarios live outside the repository, so the builder never finds them in the tree.
    if (typeof value.dir !== 'string' || !absolute(value.dir)) {
      throw new Error(`factory holdout ${value.name} needs dir, an absolute host folder`);
    }
    const sample = value.sample ?? 1;
    if (typeof sample !== 'number' || !(sample > 0) || sample > 1) {
      throw new Error(`factory holdout ${value.name} sample must be above 0 and at most 1`);
    }
    const blocking = value.blocking ?? true;
    if (typeof blocking !== 'boolean') {
      throw new Error(`factory holdout ${value.name} blocking must be true or false`);
    }
    return {
      name: value.name,
      dir: value.dir.replace(/(?<=.)\/+$/, ''),
      command: argv(value.command, `holdout ${value.name} command`),
      sample,
      blocking,
    };
  });
  if (new Set(checks.map((check) => check.name)).size !== checks.length) {
    throw new Error('factory holdout names must be distinct');
  }
  return checks;
}

const bounded = (value: unknown, name: string, low: number, high: number) => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < low || value > high) {
    throw new Error(`factory ${name} must be ${low}..${high}`);
  }
  return value;
};

function autoMergeConfig(input: unknown): AutoMergeConfig {
  const value = object(input ?? {}, 'autoMerge', [
    'enabled',
    'classes',
    'minPrs',
    'minCleanRate',
    'maxLines',
    'windowDays',
    'requiredChecks',
  ]);
  const enabled = value.enabled ?? false;
  if (typeof enabled !== 'boolean')
    throw new Error('factory autoMerge enabled must be true or false');
  const raw = value.classes ?? {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('factory autoMerge classes must map class names to patterns');
  }
  const classes = Object.fromEntries(
    Object.entries(raw).map(([name, patterns]) => {
      if (!NAME.test(name)) throw new Error(`factory autoMerge class ${name} needs a slug name`);
      return [name, relativePatterns(patterns, `autoMerge class ${name}`)];
    }),
  );
  return {
    enabled,
    classes,
    minPrs: bounded(value.minPrs ?? 30, 'autoMerge minPrs', 1, 1000),
    minCleanRate: bounded(value.minCleanRate ?? 95, 'autoMerge minCleanRate', 50, 100),
    maxLines: bounded(value.maxLines ?? 200, 'autoMerge maxLines', 1, 5000),
    windowDays: bounded(value.windowDays ?? 30, 'autoMerge windowDays', 1, 365),
    requiredChecks: checkNames(value.requiredChecks ?? []),
  };
}

function checkNames(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.some((name) => typeof name !== 'string' || !name.trim() || name.length > 200)
  ) {
    throw new Error('factory autoMerge requiredChecks must list check names');
  }
  return value as string[];
}

function retroConfig(input: unknown): RetroConfig {
  const value = object(input, 'retro', ['everyDays', 'paths']);
  return {
    everyDays: bounded(value.everyDays ?? 7, 'retro everyDays', 1, 90),
    paths: relativePatterns(value.paths ?? ['AGENTS.md', 'skills/**'], 'retro paths'),
  };
}

// Model credentials the harnesses read. Agents keep them while every other credential is
// scrubbed, and containers get them by default.
export const MODEL_KEY_NAMES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'XAI_API_KEY',
  'GROK_CODE_XAI_API_KEY',
  'CURSOR_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
];

// Names the runner sets itself or that would change how a container finds its tools.
// GitHub and SSH credentials stay with the runner even when a configuration lists them.
const RESERVED =
  /^(?:PATH|HOME|USER|TMPDIR|PWD|SHELL|HALVARD_\w*|GIT_\w*|DOCKER_\w*|NODE_OPTIONS|GH_\w*|GITHUB_\w*|SSH_\w*)$/;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const absolute = (path: string) =>
  path.startsWith('/') && !path.split('/').includes('..') && !/[:\0\r\n,]/.test(path);

function containerConfig(input: unknown): ContainerConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('factory container must be an object');
  }
  const value = input as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!['image', 'network', 'env', 'mounts', 'runner', 'memory', 'cpus'].includes(key)) {
      throw new Error(`unknown factory container option: ${key}`);
    }
  }
  if (typeof value.image !== 'string' || !/^[a-z0-9][\w.\-/:@]*$/.test(value.image)) {
    throw new Error('factory container needs an image name');
  }
  const network = value.network ?? 'none';
  if (typeof network !== 'string' || !/^[A-Za-z0-9][\w.-]*$/.test(network) || network === 'host') {
    throw new Error('factory container network must name a Docker network other than host');
  }
  const env = value.env ?? MODEL_KEY_NAMES;
  if (
    !Array.isArray(env) ||
    env.some((name) => typeof name !== 'string' || !ENV_NAME.test(name) || RESERVED.test(name))
  ) {
    throw new Error(
      'factory container env must list variable names other than PATH, HOME, TMPDIR and HALVARD_, GIT_, DOCKER_, GH_, GITHUB_ or SSH_ ones',
    );
  }
  const mounts = (value.mounts ?? []) as unknown[];
  if (!Array.isArray(mounts)) throw new Error('factory container mounts must be a list');
  const runner = value.runner ?? '/opt/halvard/bin/halvard.ts';
  if (typeof runner !== 'string' || !absolute(runner)) {
    throw new Error('factory container runner must be an absolute path');
  }
  const memory = value.memory ?? null;
  if (memory !== null && (typeof memory !== 'string' || !/^[0-9]+[kmg]$/i.test(memory))) {
    throw new Error('factory container memory takes a size such as 4g');
  }
  const cpus = value.cpus ?? null;
  if (cpus !== null && (typeof cpus !== 'number' || !(cpus > 0) || cpus > 64)) {
    throw new Error('factory container cpus must be a positive number');
  }
  return {
    image: value.image,
    network,
    env: [...new Set(env as string[])],
    mounts: mounts.map((mount) => {
      const parts = typeof mount === 'string' ? mount.split(':') : [];
      if (
        parts.length < 2 ||
        parts.length > 3 ||
        !absolute(parts[0]!) ||
        !absolute(parts[1]!) ||
        (parts[2] !== undefined && parts[2] !== 'ro')
      ) {
        throw new Error('factory container mounts take /host/path:/container/path[:ro]');
      }
      return { host: parts[0]!, container: parts[1]!, readonly: parts[2] === 'ro' };
    }),
    runner,
    memory,
    cpus,
  };
}
