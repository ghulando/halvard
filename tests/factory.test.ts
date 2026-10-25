import type { TestContext } from 'node:test';
import type { FactoryConfig, FactoryJob } from '../core/types.ts';
import './environment.ts';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { completeTask, handle, runGate } from '../core/runtime.ts';
import { runReview } from '../core/workflow/review.ts';
import { factoryConfig } from '../core/flow-config.ts';
import { loadProject } from '../core/project.ts';
import {
  approvedPlan,
  nested,
  planDigest,
  planIntact,
  readTask,
  startTask,
} from '../core/workflow/tasks.ts';
import { sessionKey } from '../core/state.ts';
import { agentCommand, agentEnv, agentStatus } from '../core/factory/harness.ts';
import { factoryCommand } from '../core/factory/pipeline.ts';
import { loadJob } from '../core/factory/store.ts';
import { env, repo, stubs } from './factory-stubs.ts';

const bash = (root: string, command: string, extra = {}) =>
  handle('claude', {
    cwd: root,
    session_id: 'factory-test',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    ...extra,
  });

const config = (overrides = {}): FactoryConfig => factoryConfig({ author: 'claude', ...overrides });

test('unattended runs deny what would ask, and refuse chat approvals', async (t) => {
  const root = repo(t);
  execFileSync('git', ['switch', '-qc', 'feature/x'], { cwd: root });
  assert.equal((await bash(root, 'git commit -m probe')).decision, 'ask');
  env(t, { HALVARD_UNATTENDED: '1' });
  const denied = await bash(root, 'git commit -m probe');
  assert.equal(denied.decision, 'deny');
  assert.match(denied.reason!, /unattended factory run/);
  assert.equal(denied.request, undefined);
  const edit = await handle('claude', {
    cwd: root,
    session_id: 'factory-test',
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: join(root, '.halvard.json'), content: '{}' },
  });
  assert.equal(edit.decision, 'deny');
  const prompt = await handle('claude', {
    cwd: root,
    session_id: 'factory-test',
    hook_event_name: 'UserPromptSubmit',
    prompt: `approve halvard ${'a'.repeat(64)}`,
  });
  assert.match(prompt.context!, /Approval refused/);
});

test('HALVARD_READONLY keeps a feature branch read-only for any harness', async (t) => {
  const root = repo(t);
  execFileSync('git', ['switch', '-qc', 'feature/x'], { cwd: root });
  env(t, { HALVARD_READONLY: '1' });
  const write = await handle('grok', {
    cwd: root,
    session_id: 'factory-test',
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: join(root, 'source.txt'), content: 'changed' },
  });
  assert.equal(write.decision, 'deny');
  assert.deepEqual(await bash(root, 'cat source.txt'), {});
});

test('agents cannot drive the factory, but may mention it', async (t) => {
  const root = repo(t);
  execFileSync('git', ['switch', '-qc', 'feature/x'], { cwd: root });
  for (const command of [
    'node /opt/halvard/bin/halvard.ts factory approve issue-1',
    'halvard factory build issue-1',
    'cd /tmp && node bin/halvard.ts factory run --issue 3',
  ]) {
    const result = await bash(root, command);
    assert.equal(result.decision, 'deny', command);
    assert.match(result.reason!, /your own terminal/);
  }
  assert.deepEqual(await bash(root, 'grep -n "halvard factory" source.txt'), {});
  env(t, { HALVARD_UNATTENDED: '1' });
  await assert.rejects(factoryCommand(root, ['status']), /your own terminal/);
});

test('the factory block validates strictly and fills defaults', (t) => {
  const defaults = config();
  assert.equal(defaults.maxFixPasses, 2);
  assert.equal(defaults.draft, true);
  assert.deepEqual(defaults.timeouts, { plan: 900, build: 2700 });
  assert.ok(defaults.riskPaths.includes('.github/**'));
  assert.deepEqual(config({ setup: ['npm', 'ci'] }).setup, [['npm', 'ci']]);
  assert.deepEqual(
    config({
      setup: [
        ['npm', 'ci'],
        ['npm', 'run', 'build'],
      ],
    }).setup.length,
    2,
  );
  for (const bad of [
    { unknown: true },
    { author: 'ollama' },
    { reviewers: ['grok', 'grok'] },
    { reviewers: ['someone'] },
    { auth: { claude: 'token' } },
    { auth: { nobody: 'api' } },
    { timeouts: { build: 10 } },
    { timeouts: { review: 600 } },
    { budgetUsd: 0 },
    { maxFixPasses: 4 },
    { setup: [[]] },
    { riskPaths: ['/abs'] },
  ]) {
    assert.throws(() => factoryConfig(bad), /factory/, JSON.stringify(bad));
  }
  const root = repo(t, { factory: { author: 'grok', budgetUsd: 2 } });
  assert.equal(loadProject(root).config.factory!.author, 'grok');
  assert.equal(loadProject(repo(t, { factory: undefined })).config.factory, null);
});

test('task-start records a brief and an approved plan whose edits void the approval', (t) => {
  const root = repo(t);
  const plan = '## Acceptance criteria\n\n1. It works.\n\n## Plan\n\n1. Do it.';
  assert.throws(
    () => startTask(root, { id: 'p', title: 'P', author: 'claude', plan }),
    /name of its approver/,
  );
  const created = startTask(root, {
    id: 'planned',
    title: 'Planned task',
    author: 'claude',
    brief: '# Issue\n\nMake it work.',
    base: 'main',
    plan,
    approvedBy: 'Reviewer Person',
  });
  const task = readTask(loadProject(root), created.task);
  assert.match(task.content, /## Brief\n\n### Issue\n\nMake it work\./);
  assert.match(task.content, /## Approved plan\n\n#### Acceptance criteria/);
  assert.match(task.content, /## Out of scope/);
  assert.equal(task.metadata.plan!.approvedBy, 'Reviewer Person');
  assert.equal(task.metadata.plan!.digest, planDigest(approvedPlan(task.content)!));
  assert.equal(planIntact(task), true);
  writeFileSync(
    join(root, created.task),
    task.content.replace('1. It works.', '1. Anything goes.'),
  );
  assert.equal(planIntact(readTask(loadProject(root), created.task)), false);
  assert.throws(
    () => startTask(root, { id: 'x', title: 'X', author: 'claude', base: '--all' }),
    /invalid base ref/,
  );
});

test('task-done needs the session gate and the review on this tree, and an intact plan', async (t) => {
  const root = repo(t);
  stubs(t);
  const created = startTask(root, {
    id: 'done',
    title: 'Done task',
    author: 'claude',
    plan: '## Acceptance criteria\n\n1. Works.',
    approvedBy: 'Person',
  });
  writeFileSync(join(root, 'source.txt'), 'changed\n');
  const key = sessionKey(root, 'factory', 'done-test');
  await assert.rejects(completeTask(root, created.task, key), /gate on this tree/);
  await runGate(root, key);
  await assert.rejects(completeTask(root, created.task, key), /independent review/);
  await runReview(root, created.task, {
    author: 'claude',
    reviewer: 'grok',
    round: 1,
    gateSession: key,
  });
  const done = await completeTask(root, created.task, key);
  assert.equal(done.task, created.task);
  assert.match(readFileSync(join(root, created.task), 'utf8'), /^\*\*Status:\*\* done\.$/m);
  await assert.rejects(completeTask(root, created.task, key), /already done/);

  const other = repo(t);
  const second = startTask(other, {
    id: 'tampered',
    title: 'Tampered',
    author: 'claude',
    plan: '## Acceptance criteria\n\n1. Works.',
    approvedBy: 'Person',
  });
  const file = join(other, second.task);
  writeFileSync(file, readFileSync(file, 'utf8').replace('1. Works.', '1. Whatever.'));
  await assert.rejects(completeTask(other, second.task, key), /Approved plan section changed/);
});

test('headless command lines follow the harness, stage and auth mode', () => {
  const base = {
    prompt: 'PROMPT',
    promptFile: '/p/prompt.md',
    output: '/p/out',
    workspace: '/w',
    budgetUsd: 3,
  };
  const api = agentCommand('claude', 'build', {
    ...base,
    config: config({ auth: { claude: 'api' } }),
  });
  assert.ok(api.includes('--bare') && api.includes('--plugin-dir'));
  assert.equal(api[api.indexOf('--max-budget-usd') + 1], '3.00');
  assert.equal(api[api.indexOf('--permission-prompts') + 1], 'none');
  assert.equal(api.at(-1), 'PROMPT');
  const subscription = agentCommand('claude', 'plan', { ...base, config: config() });
  assert.equal(subscription.includes('--bare'), false);
  assert.equal(subscription[subscription.indexOf('--permission-mode') + 1], 'dontAsk');
  const grok = agentCommand('grok', 'build', {
    ...base,
    config: config({ harnessArgs: { grok: ['--always-approve'] } }),
  });
  assert.equal(grok[grok.indexOf('--prompt-file') + 1], '/p/prompt.md');
  assert.equal(grok.at(-1), '--always-approve');
  assert.equal(grok.includes('PROMPT'), false);
  const cursor = agentCommand('cursor', 'plan', { ...base, config: config() });
  assert.equal(cursor[cursor.indexOf('--mode') + 1], 'ask');
  assert.ok(agentCommand('cursor', 'build', { ...base, config: config() }).includes('--force'));
  const codex = agentCommand('codex', 'plan', { ...base, config: config() });
  assert.equal(codex[codex.indexOf('--sandbox') + 1], 'read-only');
});

test('agents get no push credentials and the unattended markers', () => {
  const build = agentEnv('build', '/empty-gh', {
    PATH: '/bin',
    GH_TOKEN: 'secret',
    GITHUB_TOKEN: 'secret',
    SSH_AUTH_SOCK: '/agent.sock',
    ANTHROPIC_API_KEY: 'model-key',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'user.name',
    GIT_CONFIG_VALUE_0: 'Kept',
    HALVARD_REVIEW: '1',
  });
  assert.equal(build.GH_TOKEN, undefined);
  assert.equal(build.GITHUB_TOKEN, undefined);
  assert.equal(build.SSH_AUTH_SOCK, undefined);
  assert.equal(build.HALVARD_REVIEW, undefined);
  assert.equal(build.ANTHROPIC_API_KEY, 'model-key');
  assert.equal(build.GH_CONFIG_DIR, '/empty-gh');
  assert.equal(build.HALVARD_UNATTENDED, '1');
  assert.equal(build.HALVARD_READONLY, undefined);
  assert.equal(build.GIT_CONFIG_KEY_0, 'user.name');
  assert.equal(build.GIT_CONFIG_KEY_1, 'credential.helper');
  assert.equal(build.GIT_CONFIG_VALUE_2, 'no-push://factory-agent');
  assert.equal(build.GIT_CONFIG_COUNT, '4');
  assert.equal(agentEnv('plan', '/g', {}).HALVARD_READONLY, '1');
});

test('agent status lines are read from the final message', () => {
  assert.deepEqual(agentStatus('Work done.\nSTATUS: READY'), { status: 'READY', reason: '' });
  assert.equal(
    agentStatus('STATUS: BLOCKED: needs a product decision').reason,
    'needs a product decision',
  );
  assert.equal(agentStatus('All good, I think.').status, 'BLOCKED');
});

test('factory run builds a small task, gates, reviews and commits without pushing', async (t) => {
  const root = repo(t);
  const calls = stubs(t);
  const brief = join(root, '..', `brief-${Date.now()}.md`);
  writeFileSync(brief, 'Append the word implemented to source.txt.');
  t.after(() => rmSync(brief, { force: true }));
  await factoryCommand(root, [
    'run',
    '--brief',
    brief,
    '--title',
    'Add implemented',
    '--id',
    'small-one',
    '--no-push',
  ]);
  const job = loadJob(root, 'small-one');
  assert.equal(job.stage, 'committed', JSON.stringify(job.parked));
  assert.equal(job.reviewer, 'grok');
  assert.equal(job.round, 1);
  assert.equal(job.costUsd, 0.25);
  const log = execFileSync('git', ['log', '--format=%s', '-1', job.branch!], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(log.trim(), 'Add implemented');
  const shown = execFileSync('git', ['show', `${job.branch}:${job.task}`], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.match(shown, /^\*\*Status:\*\* done\.$/m);
  assert.match(shown, /## Brief\n\nAppend the word implemented/);
  assert.equal(
    execFileSync('git', ['show', `${job.branch}:source.txt`], { cwd: root, encoding: 'utf8' }),
    'original\nimplemented\n',
  );
  // The main checkout is untouched.
  assert.equal(
    execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim(),
    'main',
  );
  assert.equal(readFileSync(join(root, 'source.txt'), 'utf8'), 'original\n');
  const agent = calls().find((call) => !call.reviewer)!;
  assert.equal(agent.unattended, '1');
  assert.equal(agent.readonly, null);
  assert.equal(agent.ghToken, null);
  assert.match(agent.prompt, /unattended Halvard factory run/);
  assert.match(agent.prompt, /docs\/tasks\/small-one\.md/);
  const review = calls().find((call) => call.reviewer)!;
  assert.equal(review.name, 'grok');
  assert.equal(review.ghToken, null);
  const evidence = readFileSync(
    join(process.env.HALVARD_FACTORY_HOME!, basename(root), 'jobs/small-one/evidence.md'),
    'utf8',
  );
  assert.match(evidence, /reviewed by grok/);
  assert.match(evidence, /Round 1 by grok/);
  const events = readFileSync(
    join(process.env.HALVARD_FACTORY_HOME!, basename(root), 'jobs/small-one/events.jsonl'),
    'utf8',
  );
  for (const event of ['created', 'started', 'agent', 'gate', 'review', 'committed']) {
    assert.match(events, new RegExp(`"event":"${event}"`));
  }
});

test('a planned job waits for approval, then builds from the approved plan', async (t) => {
  const root = repo(t);
  const calls = stubs(t);
  const brief = join(root, '..', `brief-plan-${Date.now()}.md`);
  writeFileSync(brief, 'Make source.txt say implemented.');
  t.after(() => rmSync(brief, { force: true }));
  await factoryCommand(root, [
    'plan',
    '--brief',
    brief,
    '--title',
    'Planned change',
    '--id',
    'planned',
  ]);
  let job = loadJob(root, 'planned');
  assert.equal(job.stage, 'awaiting-approval');
  const planner = calls()[0]!;
  assert.equal(planner.readonly, '1');
  assert.equal(planner.args[planner.args.indexOf('--permission-mode') + 1], 'dontAsk');
  await assert.rejects(
    factoryCommand(root, ['build', 'planned', '--no-push']),
    /approved plan first/,
  );
  await factoryCommand(root, ['approve', 'planned', '--by', 'Maintainer']);
  await factoryCommand(root, ['build', 'planned', '--no-push']);
  job = loadJob(root, 'planned');
  assert.equal(job.stage, 'committed', JSON.stringify(job.parked));
  assert.equal(job.plan!.approvedBy, 'Maintainer');
  const shown = execFileSync('git', ['show', `${job.branch}:${job.task}`], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.match(
    shown,
    /## Approved plan\n\n#### Acceptance criteria\n\n1\. source\.txt says implemented\./,
  );
  assert.match(shown, /"approvedBy":"Maintainer"/);
  assert.equal(existsSync(job.worktree!), true);
});

test('a blocked agent and a review blocked twice park the job', async (t) => {
  const root = repo(t);
  stubs(t);
  const brief = join(root, '..', `brief-park-${Date.now()}.md`);
  writeFileSync(brief, 'Anything.');
  t.after(() => rmSync(brief, { force: true }));
  env(t, { STUB_AGENT: 'blocked' });
  await factoryCommand(root, [
    'run',
    '--brief',
    brief,
    '--title',
    'Blocked',
    '--id',
    'blocked-one',
    '--no-push',
  ]);
  let job: FactoryJob = loadJob(root, 'blocked-one');
  assert.equal(job.stage, 'parked');
  assert.deepEqual(
    { reason: job.parked!.reason, detail: job.parked!.detail },
    { reason: 'agent-blocked', detail: 'the brief contradicts itself' },
  );

  env(t, { STUB_AGENT: undefined, STUB_REVIEW: 'blocked' });
  await factoryCommand(root, [
    'run',
    '--brief',
    brief,
    '--title',
    'Rejected',
    '--id',
    'rejected',
    '--no-push',
  ]);
  job = loadJob(root, 'rejected');
  assert.equal(job.stage, 'parked');
  assert.equal(job.parked!.reason, 'review-blocked');
  assert.equal(job.round, 2);
  assert.equal(job.fixPasses, 1);

  // A retry starts again on a fresh worktree and branch.
  env(t, { STUB_REVIEW: undefined });
  await factoryCommand(root, ['build', 'rejected', '--no-push', '--retry']);
  job = loadJob(root, 'rejected');
  assert.equal(job.stage, 'committed', JSON.stringify(job.parked));
  await assert.rejects(
    factoryCommand(root, ['build', 'rejected', '--retry']),
    /only a parked or interrupted job/,
  );
});

test('a done edit is refused in the hook once the approved plan changed', async (t) => {
  const root = repo(t, { workflow: { requireReview: false } });
  const created = startTask(root, {
    id: 'hooked',
    title: 'Hooked',
    author: 'claude',
    plan: '## Acceptance criteria\n\n1. Works.',
    approvedBy: 'Person',
  });
  const file = join(root, created.task);
  const tampered = readFileSync(file, 'utf8').replace('1. Works.', '1. Anything.');
  writeFileSync(file, tampered);
  await runGate(root, sessionKey(root, 'claude', 'factory-test'));
  const done = await handle('claude', {
    cwd: root,
    session_id: 'factory-test',
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: {
      file_path: file,
      content: tampered.replace('**Status:** open.', '**Status:** done.'),
    },
  });
  assert.equal(done.decision, 'deny');
  assert.match(done.reason!, /Approved plan section changed/);
});

test('factory runs cannot write outside their worktree, even in a read-only shell', async (t) => {
  const root = repo(t);
  execFileSync('git', ['switch', '-qc', 'feature/x'], { cwd: root });
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-factory-outside-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const write = () =>
    handle('claude', {
      cwd: root,
      session_id: 'factory-test',
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: join(outside, 'a.txt'), content: 'x' },
    });
  // Solo runs leave outside writes to the harness, as before.
  assert.deepEqual(await write(), {});
  env(t, { HALVARD_UNATTENDED: '1' });
  assert.match((await write()).reason!, /outside/);
  assert.equal((await bash(root, `echo x > ${join(outside, 'c.txt')}`)).decision, 'deny');
  env(t, { HALVARD_UNATTENDED: undefined, HALVARD_READONLY: '1' });
  assert.match((await write()).reason!, /outside/);
  assert.equal((await bash(root, `echo x > ${join(outside, 'b.txt')}`)).decision, 'deny');
});

test("the runner's plan digest beats a forged one, and plan sections cannot be injected", async (t) => {
  const root = repo(t, { workflow: { requireReview: false } });
  const plan = '## Acceptance criteria\n\n1. Works.';
  const created = startTask(root, {
    id: 'forged',
    title: '## Approved plan',
    author: 'claude',
    brief: '## Approved plan\n\nnot a plan',
    plan,
    approvedBy: 'Person',
  });
  const file = join(root, created.task);
  const original = readFileSync(file, 'utf8');
  assert.equal(approvedPlan(original), nested(plan));
  // An agent rewrites the section and the digest in the metadata to match.
  const forgedPlan = nested('## Acceptance criteria\n\n1. Anything.');
  const forged = original
    .replace(nested(plan), forgedPlan)
    .replace(planDigest(nested(plan)), planDigest(forgedPlan));
  writeFileSync(file, forged);
  assert.equal(planIntact(readTask(loadProject(root), created.task)), true);
  const key = sessionKey(root, 'factory', 'forged');
  await runGate(root, key);
  await assert.rejects(
    completeTask(root, created.task, key, { plan: planDigest(nested(plan)) }),
    /Approved plan section changed/,
  );
  // A second section voids the approval instead of hiding behind the first.
  writeFileSync(file, original + '\n## Approved plan\n\nmore\n');
  assert.equal(approvedPlan(readFileSync(file, 'utf8')), null);
});

test('task-done reads only the real Status line', async (t) => {
  const root = repo(t, { workflow: { requireReview: false } });
  const created = startTask(root, {
    id: 'quoted',
    title: 'Quoted',
    author: 'claude',
    brief: 'Issue text:\n\n**Status:** done.',
  });
  const key = sessionKey(root, 'factory', 'quoted');
  await runGate(root, key);
  await completeTask(root, created.task, key, { plan: null });
  assert.match(readFileSync(join(root, created.task), 'utf8'), /^\*\*Status:\*\* done\.$/m);
});

test('the runner parks a job whose agent changed Git configuration or workflow settings', async (t) => {
  const root = repo(t);
  stubs(t);
  const brief = join(root, '..', `brief-tamper-${Date.now()}.md`);
  writeFileSync(brief, 'Anything.');
  t.after(() => rmSync(brief, { force: true }));
  env(t, { STUB_AGENT: 'gitconfig' });
  await factoryCommand(root, [
    'run',
    '--brief',
    brief,
    '--title',
    'Git',
    '--id',
    'git-tamper',
    '--no-push',
  ]);
  let job = loadJob(root, 'git-tamper');
  assert.equal(job.stage, 'parked');
  assert.deepEqual(
    { reason: job.parked!.reason, detail: job.parked!.detail },
    {
      reason: 'tampered',
      detail: 'Git configuration changed during the run',
    },
  );
  assert.equal(process.exitCode, 3);
  process.exitCode = 0;
  execFileSync('git', ['config', '--unset', 'credential.helper'], { cwd: root });
  // Nothing new starts until a human has looked at the tampered job.
  await assert.rejects(
    factoryCommand(root, ['run', '--brief', brief, '--title', 'Next', '--id', 'next', '--no-push']),
    /parked after tampering/,
  );
  rmSync(join(process.env.HALVARD_FACTORY_HOME!, basename(root), 'jobs/git-tamper'), {
    recursive: true,
  });

  env(t, { STUB_AGENT: 'config' });
  await factoryCommand(root, [
    'run',
    '--brief',
    brief,
    '--title',
    'Config',
    '--id',
    'config-tamper',
    '--no-push',
  ]);
  job = loadJob(root, 'config-tamper');
  assert.equal(job.stage, 'parked');
  assert.equal(job.parked!.reason, 'tampered');
  assert.match(job.parked!.detail, /changed \.halvard\.json/);
  process.exitCode = 0;
});

test('job files are checked, retries never touch other paths, and a live run blocks approvals', async (t) => {
  const root = repo(t);
  stubs(t);
  const brief = join(root, '..', `brief-store-${Date.now()}.md`);
  writeFileSync(brief, 'Anything.');
  t.after(() => rmSync(brief, { force: true }));
  env(t, { STUB_AGENT: 'blocked' });
  await factoryCommand(root, [
    'run',
    '--brief',
    brief,
    '--title',
    'Store',
    '--id',
    'store',
    '--no-push',
  ]);
  process.exitCode = 0;
  const file = join(process.env.HALVARD_FACTORY_HOME!, basename(root), 'jobs/store/job.json');
  const saved = readFileSync(file, 'utf8');
  writeFileSync(file, saved.replace(/"worktree": "[^"]+"/, `"worktree": "${root}"`));
  assert.throws(() => loadJob(root, 'store'), /invalid factory job/);
  // A branch name pointing at the user's work is not deleted on retry.
  execFileSync('git', ['branch', 'users-work'], { cwd: root });
  writeFileSync(file, saved.replace(/"branch": "[^"]+"/, '"branch": "users-work"'));
  env(t, { STUB_AGENT: undefined });
  await factoryCommand(root, ['build', 'store', '--no-push', '--retry']);
  assert.equal(
    execFileSync('git', ['branch', '--list', 'users-work'], { cwd: root, encoding: 'utf8' }).trim(),
    'users-work',
  );
  // While another job's runner is alive, approvals and new runs are refused.
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  t.after(() => sleeper.kill());
  writeFileSync(
    join(process.env.HALVARD_FACTORY_HOME!, basename(root), 'jobs/store/runner.lock'),
    String(sleeper.pid),
  );
  await assert.rejects(factoryCommand(root, ['approve', 'store']), /is running/);
  await assert.rejects(
    factoryCommand(root, ['run', '--brief', brief, '--title', 'X', '--id', 'other', '--no-push']),
    /is running/,
  );
});
