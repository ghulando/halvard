import type {
  AutoMergeConfig,
  FactoryConfig,
  Harness,
  HoldoutCheck,
  RetroConfig,
} from '../types.ts';
import { HARNESSES } from '../types.ts';
import { absolute, containerConfig } from './container.ts';
import { isHarness } from './team.ts';
import { providers } from './reviewers.ts';

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
