import type { TestContext } from 'node:test';
import type { FactoryJob } from '../core/types.ts';
import './environment.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { factoryConfig } from '../core/flow-config.ts';
import { factoryCommand, sampled } from '../core/factory.ts';
import { jobEvents, metrics } from '../core/factory-board.ts';
import { changeClass, ciState } from '../core/factory-outcomes.ts';
import { changedFiles } from '../core/factory-ship.ts';
import { createJob, jobFile, loadJob, recordEvent, repoHome } from '../core/factory-store.ts';
import { pluginRoot } from '../core/runtime.ts';
import { commit, env, repo, stubs } from './factory-stubs.ts';

const DAY = 24 * 3600 * 1000;

function brief(t: TestContext, root: string) {
  const file = join(root, '..', `brief-${root.split('/').at(-1)}.md`);
  writeFileSync(file, '## Goal\n\nMake source.txt say implemented.\n');
  t.after(() => rmSync(file, { force: true }));
  return file;
}

const run = (t: TestContext, root: string, id: string) =>
  factoryCommand(root, [
    'run',
    '--brief',
    brief(t, root),
    '--title',
    `Job ${id}`,
    '--id',
    id,
    '--no-push',
  ]);

// A scenarios folder outside the repository: check.js passes when source.txt holds the
// text in want.txt, and writes into the checkout when write.txt exists.
function holdoutDir(t: TestContext, want: string, write = false) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-holdout-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'want.txt'), want);
  if (write) writeFileSync(join(dir, 'write.txt'), 'yes');
  writeFileSync(
    join(dir, 'check.js'),
    `const fs = require('fs');
const path = require('path');
const scenarios = process.env.HALVARD_HOLDOUT_DIR;
console.log('SECRET-SCENARIO base ' + process.env.HALVARD_FACTORY_BASE);
if (fs.existsSync(path.join(scenarios, 'write.txt'))) fs.writeFileSync('stray.txt', 'x');
const want = fs.readFileSync(path.join(scenarios, 'want.txt'), 'utf8').trim();
process.exit(fs.readFileSync('source.txt', 'utf8').includes(want) ? 0 : 1);
`,
  );
  return dir;
}

const holdoutRepo = (
  t: TestContext,
  dir: string,
  extra: Record<string, unknown> = {},
  factory: Record<string, unknown> = {},
) =>
  repo(t, {
    factory: {
      author: 'claude',
      reviewers: ['grok'],
      holdout: [
        { name: 'scenarios', dir, command: [process.execPath, join(dir, 'check.js')], ...extra },
      ],
      autoMerge: { classes: { source: ['source.txt'] } },
      ...factory,
    },
  });

test('holdout, auto-merge and retro settings are checked', () => {
  const check = { name: 'scenarios', dir: '/srv/scenarios', command: ['run'] };
  assert.throws(
    () => factoryConfig({ holdout: [{ ...check, dir: 'scenarios' }] }),
    /absolute host folder/,
  );
  assert.throws(() => factoryConfig({ holdout: [{ ...check, sample: 0 }] }), /sample/);
  assert.throws(() => factoryConfig({ holdout: [check, check] }), /distinct/);
  assert.throws(() => factoryConfig({ holdout: [{ ...check, extra: 1 }] }), /unknown/);
  assert.deepEqual(factoryConfig({ holdout: [check] }).holdout, [
    { ...check, sample: 1, blocking: true },
  ]);
  const defaults = factoryConfig({});
  assert.deepEqual(defaults.autoMerge, {
    enabled: false,
    classes: {},
    minPrs: 30,
    minCleanRate: 95,
    maxLines: 200,
    windowDays: 30,
    requiredChecks: [],
  });
  assert.throws(
    () => factoryConfig({ autoMerge: { enabled: true, requiredChecks: ['build'] } }),
    /needs container mode/,
  );
  assert.throws(
    () => factoryConfig({ container: { image: 'x' }, autoMerge: { enabled: true } }),
    /needs requiredChecks/,
  );
  // What a retro may change is always a risk path, and so is shared guidance.
  const risky = factoryConfig({ retro: { paths: ['skills/**'] } }).riskPaths;
  assert.ok(['skills/**', 'AGENTS.md', 'CLAUDE.md'].every((path) => risky.includes(path)));
  assert.equal(defaults.retro, null);
  assert.deepEqual(factoryConfig({ retro: {} }).retro, {
    everyDays: 7,
    paths: ['AGENTS.md', 'skills/**'],
  });
  assert.throws(() => factoryConfig({ autoMerge: { classes: { Docs: ['docs/**'] } } }), /slug/);
  assert.throws(
    () => factoryConfig({ autoMerge: { classes: { docs: ['/etc/**'] } } }),
    /repo-relative/,
  );
  assert.throws(() => factoryConfig({ autoMerge: { minCleanRate: 20 } }), /50\.\.100/);
  assert.throws(() => factoryConfig({ retro: { paths: [] } }), /repo-relative/);

  const half = { name: 'mutation', dir: '/x', command: ['x'], sample: 0.5, blocking: false };
  const picked = Array.from({ length: 200 }, (_, i) => sampled(`job-${i}`, half));
  const count = picked.filter(Boolean).length;
  assert.ok(count > 60 && count < 140, `sampled ${count} of 200`);
  assert.deepEqual(
    picked,
    Array.from({ length: 200 }, (_, i) => sampled(`job-${i}`, half)),
  );
  assert.ok(sampled('any', { ...half, sample: 1 }));

  assert.equal(ciState([]), 'none');
  assert.equal(
    ciState([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }]),
    'green',
  );
  assert.equal(
    ciState([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }]),
    'pending',
  );
  assert.equal(
    ciState([{ status: 'COMPLETED', conclusion: 'FAILURE' }, { status: 'QUEUED' }]),
    'red',
  );
  assert.equal(changeClass(['docs/a.md', 'docs/b/c.md'], { docs: ['docs/**'] }), 'docs');
  assert.equal(changeClass(['docs/a.md', 'core/x.ts'], { docs: ['docs/**'] }), null);
  assert.equal(changeClass([], { docs: ['docs/**'] }), null);
  // A required check that has not reported yet keeps the pull request pending.
  const bot = [{ name: 'cla', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  assert.equal(ciState(bot, ['build']), 'pending');
  assert.equal(
    ciState([...bot, { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }], ['build']),
    'green',
  );
});

test('a passing holdout check goes into the evidence, and the commit records its class', async (t) => {
  const calls = stubs(t);
  const dir = holdoutDir(t, 'implemented');
  const root = holdoutRepo(t, dir);
  await run(t, root, 'held');
  const job = loadJob(root, 'held');
  assert.equal(job.stage, 'committed', job.parked?.detail);
  const evidence = readFileSync(jobFile(root, 'held', 'evidence.md'), 'utf8');
  assert.match(evidence, /## Holdout checks[\s\S]*- scenarios: passed/);
  assert.match(evidence, /Class: `source`; 1 lines; gate and review passed first time/);
  const committed = jobEvents(root, 'held').find((event) => event.event === 'committed')!;
  assert.equal(committed.class, 'source');
  assert.equal(committed.lines, 1);
  assert.equal(committed.firstTry, true);
  assert.deepEqual(committed.files, ['source.txt']);
  assert.equal(
    committed.head,
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: job.worktree!, encoding: 'utf8' }).trim(),
  );
  // The check saw the scenarios and the base; nothing of it reached an agent.
  assert.match(
    readFileSync(jobFile(root, 'held', 'holdout.log'), 'utf8'),
    /SECRET-SCENARIO base [0-9a-f]{40}/,
  );
  assert.ok(calls().every((call) => !call.prompt.includes('SECRET-SCENARIO')));
});

test('a failed blocking holdout parks the job without a fix pass', async (t) => {
  const calls = stubs(t);
  const root = holdoutRepo(t, holdoutDir(t, 'never'));
  await run(t, root, 'hidden');
  const job = loadJob(root, 'hidden');
  assert.equal(job.parked!.reason, 'holdout-failed');
  assert.match(job.parked!.detail, /scenarios failed; its output is in .*holdout\.log/);
  assert.equal(calls().filter((call) => !call.reviewer).length, 1);
  assert.equal(calls().filter((call) => call.reviewer).length, 0);
});

test('a failed check that is not blocking only shows in the evidence', async (t) => {
  stubs(t);
  const root = holdoutRepo(t, holdoutDir(t, 'never'), { blocking: false });
  await run(t, root, 'advisory');
  assert.equal(loadJob(root, 'advisory').stage, 'committed');
  assert.match(
    readFileSync(jobFile(root, 'advisory', 'evidence.md'), 'utf8'),
    /- scenarios: failed \(not blocking\)/,
  );
});

test('a holdout check may not change the checkout, nor live where the agent can read it', async (t) => {
  stubs(t);
  const root = holdoutRepo(t, holdoutDir(t, 'implemented', true));
  await run(t, root, 'writer');
  const job = loadJob(root, 'writer');
  assert.equal(job.parked!.reason, 'infra');
  assert.match(job.parked!.detail, /scenarios changed the checkout/);

  const inside = repo(t);
  const config = JSON.parse(readFileSync(join(inside, '.halvard.json'), 'utf8'));
  config.factory.holdout = [{ name: 'scenarios', dir: join(inside, 'scenarios'), command: ['x'] }];
  writeFileSync(join(inside, '.halvard.json'), JSON.stringify(config));
  await assert.rejects(factoryCommand(inside, ['status']), /holdout scenarios folder .* overlaps/);
});

test('a moved file counts at its old path too, so a move cannot leave a risk path unseen', (t) => {
  const root = repo(t);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/auth.ts'), 'export const secret = 1;\n'.repeat(20));
  execFileSync('git', ['add', '.'], { cwd: root });
  commit(root, 'auth');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  mkdirSync(join(root, 'docs'));
  execFileSync('git', ['mv', 'src/auth.ts', 'docs/auth.md'], { cwd: root });
  assert.deepEqual(changedFiles(root, base), ['docs/auth.md', 'src/auth.ts']);
});

test('in container mode a holdout check gets no network and a read-only checkout', async (t) => {
  stubs(t);
  const dir = holdoutDir(t, 'implemented');
  const cache = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-cache-')));
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  const root = holdoutRepo(
    t,
    dir,
    {},
    {
      container: {
        image: 'halvard-factory-test',
        runner: join(pluginRoot, 'bin/halvard.ts'),
        env: ['STUB_LOG'],
        mounts: [`${cache}:${cache}`],
      },
    },
  );
  await run(t, root, 'boxed');
  const job = loadJob(root, 'boxed');
  assert.equal(job.stage, 'committed', job.parked?.detail);
  const log = readFileSync(join(process.env.STUB_DOCKER_LOG!), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  const check = log.find((args) => args.some((arg) => arg.includes('-holdout-scenarios-')))!;
  assert.equal(check[check.indexOf('--network') + 1], 'none');
  assert.ok(check.includes(`type=bind,src=${job.worktree},dst=${job.worktree},readonly`));
  assert.ok(check.includes(`type=bind,src=${dir},dst=${dir},readonly`));
  // Only the scratch folder is writable: nothing the check writes reaches a later agent.
  const writable = check.filter(
    (arg, i) => check[i - 1] === '--mount' && !arg.endsWith(',readonly'),
  );
  assert.deepEqual(
    writable.map((arg) => arg.match(/dst=([^,]+)/)![1]),
    [jobFile(root, 'boxed', 'holdout-tmp')],
  );
  assert.ok(check.includes(`type=bind,src=${cache},dst=${cache},readonly`));
  // The agent's own containers never mount the scenarios.
  const agents = log.filter((args) => args.some((arg) => /-(plan|build)-/.test(arg)));
  assert.ok(agents.length);
  assert.ok(agents.every((args) => !args.some((arg) => arg.includes(dir))));
});

// A job as the runner leaves it after opening a pull request.
function shippedJob(
  root: string,
  id: string,
  facts: {
    class: string | null;
    files: string[];
    head: string;
    lines?: number;
    firstTry?: boolean;
    scope?: string[];
    holdoutFailed?: boolean;
  },
) {
  mkdirSync(join(repoHome(root), 'jobs'), { recursive: true });
  const job: Omit<FactoryJob, 'created' | 'updated'> = {
    version: 1,
    id,
    repo: root,
    title: `Job ${id}`,
    issue: null,
    small: true,
    fix: false,
    author: 'claude',
    stage: 'pr-open',
    worktree: null,
    branch: `feature/${id}`,
    task: null,
    plan: null,
    reviewer: 'grok',
    round: 1,
    fixPasses: 0,
    parked: null,
    scope: facts.scope ?? null,
    pr: `https://github.com/example/repo/pull/${id}`,
    costUsd: 1,
  };
  createJob(root, job);
  recordEvent(root, id, 'committed', {
    tree: 'x',
    risk: 'normal',
    head: facts.head,
    files: facts.files,
    class: facts.class,
    lines: facts.lines ?? 10,
    firstTry: facts.firstTry ?? true,
    holdoutFailed: facts.holdoutFailed ?? false,
  });
  return job.pr!;
}

const green = [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const pull = (
  state: string,
  head: string,
  extra: {
    mergedAt?: string;
    mergeCommit?: string;
    commits?: string[];
    reviews?: string[];
    labels?: string[];
  } = {},
) => ({
  state,
  isDraft: false,
  mergedAt: extra.mergedAt ?? null,
  mergeCommit: extra.mergeCommit ? { oid: extra.mergeCommit } : null,
  headRefOid: head,
  commits: (extra.commits ?? [head]).map((oid) => ({ oid })),
  statusCheckRollup: green,
  reviewDecision: null,
  reviews: (extra.reviews ?? []).map((state) => ({ state })),
  labels: (extra.labels ?? []).map((name) => ({ name })),
});

const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();

const sha = (n: number) => String(n).repeat(40).slice(0, 40);

test('the dry run reports which pull requests would have merged, and human edits per class', async (t) => {
  const calls = stubs(t);
  const root = repo(t, {
    factory: {
      author: 'claude',
      reviewers: ['grok'],
      autoMerge: { classes: { docs: ['docs/**'] }, minPrs: 2, minCleanRate: 50 },
    },
  });
  const clean = shippedJob(root, 'clean', { class: 'docs', files: ['docs/a.md'], head: sha(1) });
  const edited = shippedJob(root, 'edited', { class: 'docs', files: ['docs/b.md'], head: sha(2) });
  const pushed = shippedJob(root, 'pushed', { class: 'docs', files: ['docs/c.md'], head: sha(3) });
  const open = shippedJob(root, 'open', { class: 'docs', files: ['docs/d.md'], head: sha(4) });
  const code = shippedJob(root, 'code', { class: null, files: ['core/x.ts'], head: sha(5) });
  const guidance = shippedJob(root, 'guidance', {
    class: 'docs',
    files: ['docs/e.md'],
    head: sha(10),
    scope: ['docs/**'],
  });
  // A person changed docs/b.md five days after its merge: a human edit after merge.
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs/b.md'), 'fixed by hand\n');
  execFileSync('git', ['add', 'docs/b.md'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'Fix the factory docs'], {
    cwd: root,
    env: { ...process.env, GIT_AUTHOR_DATE: daysAgo(25), GIT_COMMITTER_DATE: daysAgo(25) },
  });
  const state = calls.github.read();
  state.views = {
    [clean]: pull('MERGED', sha(1), { mergedAt: daysAgo(40), mergeCommit: sha(6) }),
    [edited]: pull('MERGED', sha(2), { mergedAt: daysAgo(30), mergeCommit: sha(7) }),
    // A human pushed a commit to this one before it merged.
    [pushed]: pull('MERGED', sha(8), {
      mergedAt: daysAgo(20),
      mergeCommit: sha(9),
      commits: [sha(3), sha(8)],
    }),
    [open]: pull('OPEN', sha(4), { reviews: ['COMMENTED'] }),
    [code]: pull('OPEN', sha(5)),
    [guidance]: pull('OPEN', sha(10)),
  };
  calls.github.write(state);
  // The real command in its own process: the test runner writes its own messages to this
  // process's stdout, so capturing it here would mix them in.
  const report = JSON.parse(
    execFileSync(process.execPath, [join(pluginRoot, 'bin/halvard.ts'), 'factory', 'automerge'], {
      cwd: root,
      encoding: 'utf8',
    }),
  ) as {
    enabled: boolean;
    merged: { job: string; qualifies: boolean; reasons: string[] }[];
    open: { job: string; qualifies: boolean; reasons: string[] }[];
    classes: Record<string, { merged: number; humanEdited: number; rate: number }>;
  } | null;
  assert.equal(report!.enabled, false);
  // When the first one merged, no docs pull request had merged yet.
  const first = report!.merged.find((row) => row.job === 'clean')!;
  assert.equal(first.qualifies, false);
  assert.match(first.reasons.join('\n'), /class docs has 0 merged pull requests, fewer than 2/);
  assert.deepEqual(report!.classes.docs, { merged: 3, humanEdited: 2, rate: 66.7, reverted: 0 });
  // Two of three were edited by a person: under the 50% clean rate, so the open one waits.
  const waiting = report!.open.find((row) => row.job === 'open')!;
  assert.equal(waiting.qualifies, false);
  assert.match(waiting.reasons.join('\n'), /merged 33\.3% without human edits, under 50%/);
  assert.match(waiting.reasons.join('\n'), /a review that is not an approval/);
  assert.match(
    report!.open.find((row) => row.job === 'guidance')!.reasons.join('\n'),
    /a retro job, which a person merges/,
  );
  assert.match(
    report!.open.find((row) => row.job === 'code')!.reasons.join('\n'),
    /fit no change class/,
  );
  // The cached outcomes feed the metrics without calling GitHub.
  const numbers = metrics(root);
  assert.equal(numbers.mergedPullRequests, 3);
  assert.equal(numbers.humanEditRate, 66.7);
  assert.equal(
    JSON.parse(readFileSync(jobFile(root, 'edited', 'outcome.json'), 'utf8')).followUps.length,
    1,
  );
});

test('factory serve merges a qualifying pull request only while FACTORY_AUTOMERGE is on', async (t) => {
  const calls = stubs(t);
  const root = repo(t, {
    factory: {
      author: 'claude',
      reviewers: ['grok'],
      container: { image: 'halvard-factory-test' },
      autoMerge: {
        enabled: true,
        classes: { docs: ['docs/**'] },
        minPrs: 1,
        minCleanRate: 90,
        requiredChecks: ['build'],
      },
    },
  });
  const done = shippedJob(root, 'done', { class: 'docs', files: ['docs/a.md'], head: sha(1) });
  const ready = shippedJob(root, 'ready', { class: 'docs', files: ['docs/b.md'], head: sha(2) });
  const big = shippedJob(root, 'big', {
    class: 'docs',
    files: ['docs/c.md'],
    head: sha(3),
    lines: 900,
  });
  const held = shippedJob(root, 'held', {
    class: 'docs',
    files: ['docs/d.md'],
    head: sha(5),
    holdoutFailed: true,
  });
  const objected = shippedJob(root, 'objected', {
    class: 'docs',
    files: ['docs/e.md'],
    head: sha(6),
  });
  const state = calls.github.read();
  state.views = {
    // Merged by a person long enough ago that its follow-up window has closed.
    [done]: pull('MERGED', sha(1), { mergedAt: daysAgo(20), mergeCommit: sha(4) }),
    [ready]: pull('OPEN', sha(2)),
    [big]: pull('OPEN', sha(3)),
    [held]: pull('OPEN', sha(5)),
    [objected]: pull('OPEN', sha(6), { labels: ['factory:stop'] }),
  };
  state.variables = { FACTORY_AUTOMERGE: 'off' };
  calls.github.write(state);
  await factoryCommand(root, ['serve', '--once']);
  assert.equal(calls.github.read().merges, undefined);

  const on = calls.github.read();
  on.variables = { FACTORY_AUTOMERGE: 'on' };
  calls.github.write(on);
  await factoryCommand(root, ['serve', '--once']);
  assert.deepEqual(calls.github.read().merges, [
    ['pr', 'merge', ready, '--squash', '--match-head-commit', sha(2)],
  ]);
  assert.equal(jobEvents(root, 'ready').at(-1)!.event, 'auto-merge');
});

// Two jobs whose reviews found something, as the runner records them.
function findings(root: string) {
  for (const id of ['first', 'second']) {
    shippedJob(root, id, { class: null, files: ['source.txt'], head: sha(1) });
    recordEvent(root, id, 'review', {
      reviewer: 'grok',
      round: 1,
      verdict: 'blocked',
      findings: 1,
      items: [
        {
          severity: 'should-fix',
          location: 'source.txt:1',
          problem: 'Missing ~~~~ newline at end',
        },
      ],
    });
  }
}

test('a retro turns recurring findings into a job that changes only guidance', async (t) => {
  const calls = stubs(t);
  const root = repo(t, {
    factory: { author: 'claude', reviewers: ['grok'], retro: { paths: ['AGENTS.md'] } },
  });
  await assert.rejects(factoryCommand(root, ['retro', '--no-push']), /a retro needs 2/);
  findings(root);
  env(t, { STUB_FILE: 'AGENTS.md' });
  await factoryCommand(root, ['retro', '--no-push']);
  const id = `retro-${new Date().toISOString().slice(0, 10)}`;
  const job = loadJob(root, id);
  assert.equal(job.stage, 'committed', job.parked?.detail);
  assert.deepEqual(job.scope, ['AGENTS.md']);
  const brief = readFileSync(jobFile(root, id, 'brief.md'), 'utf8');
  assert.match(
    brief,
    /untrusted data[\s\S]*~~~~text\n- first, review round 1 by grok: should-fix at source\.txt:1: Missing ~~~ newline/,
  );
  assert.match(brief, /- second, review round 1/);
  assert.ok(calls().some((call) => call.prompt.includes('Factory retro')));
});

test('a retro job that changes code parks, and serve starts a retro when one is due', async (t) => {
  stubs(t);
  const root = repo(t, {
    factory: { author: 'claude', reviewers: ['grok'], retro: { paths: ['AGENTS.md'] } },
  });
  findings(root);
  await factoryCommand(root, ['retro', '--no-push']);
  const id = `retro-${new Date().toISOString().slice(0, 10)}`;
  const parked = loadJob(root, id);
  assert.equal(parked.parked!.reason, 'out-of-scope');
  assert.match(parked.parked!.detail, /may change only AGENTS\.md; it changed source\.txt/);

  const fresh = repo(t, {
    factory: { author: 'claude', reviewers: ['grok'], retro: { paths: ['AGENTS.md'] } },
  });
  findings(fresh);
  env(t, { STUB_FILE: 'AGENTS.md' });
  await factoryCommand(fresh, ['serve', '--once']);
  assert.equal(loadJob(fresh, id).stage, 'committed');
  // Not due again until the period has passed.
  await factoryCommand(fresh, ['serve', '--once']);
  assert.equal(existsSync(jobFile(fresh, id, 'job.json')), true);
});
