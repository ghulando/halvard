import type { TestContext } from 'node:test';
import type { ReviewRecord, RunningReview, PackageMetadata } from '../core/types.ts';
import './environment.ts';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { parseCommand } from '../core/cli.ts';
import { doctor } from '../core/setup/doctor.ts';
import { handle } from '../core/runtime.ts';
import { pluginRoot, quote } from '../core/shared/plugin.ts';
import { recoverReview, reviewKey } from '../core/workflow/review.ts';
import {
  handoffTask,
  resumeTask,
  startTask,
  readTask,
  taskWorkspace,
} from '../core/workflow/tasks.ts';
import { loadProject } from '../core/project.ts';
import { sessionKey, withState } from '../core/state.ts';

function fixture(t: TestContext, workflow = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-lifecycle-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: root });
  writeFileSync(
    join(root, '.halvard.json'),
    JSON.stringify({
      gate: [process.execPath, '-e', 'process.exit(0)'],
      workflow: { reviewers: { claude: {}, codex: {} }, ...workflow },
    }),
  );
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ],
    { cwd: root },
  );
  return root;
}

test('command grammar accepts option reordering but rejects duplicates, unknowns and missing values', () => {
  const parsed = parseCommand('review', [
    '--round',
    '1',
    '--author',
    'codex',
    'docs/tasks/task.md',
    '--gate-session',
    'key',
    '--reviewer',
    'claude',
  ]);
  assert.equal(parsed.flags.round, '1');
  assert.deepEqual(parsed.positional, ['docs/tasks/task.md']);
  for (const args of [
    ['--author', 'codex', '--author', 'claude'],
    ['--author'],
    ['--unknown', 'x'],
  ]) {
    assert.throws(() => parseCommand('doctor', args));
  }
  assert.throws(() => parseCommand('doctor', ['--author', 'ollama']));
});

test('doctor reports incompatible review configuration and task-start leaves the branch untouched', (t) => {
  const root = fixture(t, { reviewers: { codex: {} } });
  assert.match(doctor(root, 'codex').issues.join(' '), /No configured independent reviewer/);
  assert.throws(
    () => startTask(root, { id: 'task', title: 'Task', author: 'codex' }),
    /no configured independent reviewer/,
  );
  assert.equal(
    execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim(),
    'main',
  );
});

test('hooks recognize reordered review arguments and identical runner copies without trusting modified copies', async (t) => {
  const root = fixture(t);
  const copy = join(root, 'copy');
  mkdirSync(copy);
  for (const path of [
    ...(
      JSON.parse(readFileSync(join(pluginRoot, 'package.json')).toString('utf8')) as PackageMetadata
    ).files,
    'package.json',
  ]) {
    cpSync(join(pluginRoot, path), join(copy, path), { recursive: true });
  }
  const key = sessionKey(root, 'codex', 'contract');
  const payload = (command: string) => ({
    cwd: root,
    session_id: 'contract',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
  });
  assert.equal(
    (await handle('codex', payload(`node ${quote(join(copy, 'bin/halvard.ts'))} gate ${key}`)))
      .decision,
    undefined,
  );
  const command = `node ${quote(join(copy, 'bin/halvard.ts'))} review --round 1 --author codex docs/tasks/task.md --gate-session ${key} --reviewer claude`;
  assert.equal((await handle('codex', payload(command))).decision, undefined);
  assert.equal((await handle('codex', payload(command + ' --extra'))).decision, 'deny');
  writeFileSync(join(copy, 'core/runtime.ts'), 'modified runner');
  assert.equal(
    (await handle('codex', payload(`node ${quote(join(copy, 'bin/halvard.ts'))} gate ${key}`)))
      .decision,
    'deny',
  );
});

test('review recovery requires stopped owners and preserves prior verdicts and reports', async (t) => {
  const root = fixture(t);
  const started = startTask(root, { id: 'task', title: 'Task', author: 'codex' });
  const key = reviewKey(readTask(loadProject(root), started.task));
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  const first = { verdict: 'blocked', report: 'retained-report.json' };
  await withState(root, key, (state) => {
    state.first = first as ReviewRecord;
    state.running = {
      id: 'run',
      ownerPid: dead,
      reviewerPid: process.pid,
      phase: 'reviewing',
    } as unknown as RunningReview;
  });
  await assert.rejects(recoverReview(root, started.task), /still running/);
  await withState(root, key, (state) => {
    state.running!.reviewerPid = dead;
  });
  assert.equal((await recoverReview(root, started.task)).recovered, true);
  await withState(root, key, (state) => {
    assert.deepEqual(state.first, first);
    assert.equal(state.running, null);
    assert.equal(state.history![0]!.event, 'recovered-stopped-review');
  });
  await withState(root, key, (state) => {
    state.running = {
      id: 'run',
      ownerPid: process.pid,
      phase: 'preparing',
    } as unknown as RunningReview;
  });
  await assert.rejects(recoverReview(root, started.task), /coordinator is still running/);
  await withState(root, key, (state) => {
    state.running = 'legacy' as unknown as RunningReview;
  });
  await assert.rejects(recoverReview(root, started.task), /legacy/);
  await withState(root, key, (state) => {
    state.running = {
      ownerPid: dead,
      phase: 'launching',
      reviewerPid: null,
    } as unknown as RunningReview;
  });
  await assert.rejects(recoverReview(root, started.task), /ownership is unknown/);
});

test('explicit stopped-reviewer recovery handles launch records without losing verdicts', async (t) => {
  const root = fixture(t);
  const started = startTask(root, { id: 'recover', title: 'Recovery', author: 'codex' });
  const key = reviewKey(readTask(loadProject(root), started.task));
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  await withState(root, key, (state) => {
    state.first = { verdict: 'blocked' } as ReviewRecord;
    state.running = { ownerPid: dead, phase: 'launching' } as unknown as RunningReview;
  });
  assert.equal(
    (await recoverReview(root, started.task, { stoppedReviewer: true })).recovered,
    true,
  );
  await withState(root, key, (state) => assert.equal(state.first!.verdict, 'blocked'));
});

test('CLI help, doctor exit status and current-harness diagnostics are observable', async (t) => {
  const root = fixture(t, { reviewers: {} });
  const runner = join(pluginRoot, 'bin/halvard.ts');
  const help = spawnSync(process.execPath, [runner], { cwd: root, encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /halvard commands/);
  const diagnosed = spawnSync(process.execPath, [runner, 'doctor', '--author', 'codex'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(diagnosed.status, 1);
  const context = (
    await handle('codex', { cwd: root, session_id: 'warnings', hook_event_name: 'SessionStart' })
  ).context;
  assert.match(context!, /No configured independent reviewer for codex/);
  assert.doesNotMatch(context!, /No configured independent reviewer for (pi|claude)/);
  assert.doesNotMatch(doctor(root).issues.join(' '), /independent reviewer/);
  const configFile = join(root, '.halvard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, review: ['scripts/review.sh'] }));
  assert.match(doctor(root).issues.join(' '), /Review wrapper scripts\/review.sh is missing/);
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts/review.sh'), '#!/bin/sh\n', { mode: 0o644 });
  assert.match(doctor(root).issues.join(' '), /not executable/);
  chmodSync(join(root, 'scripts/review.sh'), 0o755);
  assert.doesNotMatch(doctor(root).issues.join(' '), /Review wrapper/);
  writeFileSync(configFile, JSON.stringify({ ...config, review: ['scripts/review.sh/run'] }));
  assert.match(doctor(root).issues.join(' '), /Review wrapper scripts\/review.sh\/run is missing/);
  writeFileSync(configFile, JSON.stringify(config));
  const copy = join(root, 'plugins/halvard');
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(copy, 'package.json'), '{"name":"halvard","version":"9.9.9"}');
  mkdirSync(join(root, 'plugins/halvard.next-leftover'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  mkdirSync(join(root, '.claude/other.next-cache'));
  mkdirSync(join(root, '.claude/other.previous'));
  mkdirSync(join(root, '.claude/.other.workflow-cache'));
  mkdirSync(join(root, '.claude/.settings.json.workflow-leftover'));
  mkdirSync(join(root, 'plugins/other.next-cache'));
  mkdirSync(join(root, 'plugins/halvard.next-old.previous'));
  mkdirSync(join(root, '..halvard.json.workflow-leftover'));
  const issues = doctor(root, 'codex').issues.join(' ');
  assert.match(issues!, /vendored package upgrade/);
  assert.doesNotMatch(issues!, /install-user --repair/);
  assert.match(issues!, /staging leftover/);
  assert.match(issues!, /settings.json.workflow-leftover/);
  assert.match(issues!, /halvard.next-old.previous/);
  assert.match(issues!, /halvard.json.workflow-leftover/);
  assert.doesNotMatch(issues!, /other.next-cache|other.previous|other.workflow-cache/);
});

test('README setup and task-start work in an isolated HOME and repository', (t) => {
  const root = fixture(t);
  const home = join(root, '../quickstart-home-' + root.split('/').pop());
  mkdirSync(home);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = {
    ...process.env,
    HOME: home,
    HALVARD_HOME: join(home, '.config/halvard'),
  };
  const run = (...args: string[]) =>
    execFileSync(process.execPath, [join(pluginRoot, 'bin/halvard.ts'), ...args], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
  run('install-user', '--apply');
  const proposal = JSON.parse(run('setup', '.')) as ReturnType<
    typeof import('../core/setup/setup.ts').proposeSetup
  >;
  proposal.config.workflow.reviewers = { claude: {} };
  const path = join(home, 'proposal.json');
  writeFileSync(path, JSON.stringify(proposal));
  run('setup-apply', '.', path);
  run('doctor', '--author', 'codex');
  execFileSync('git', ['add', '.halvard.json'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'Configure Halvard',
    ],
    { cwd: root },
  );
  const started = JSON.parse(
    run('task-start', 'login', 'Add login', '--author', 'codex'),
  ) as ReturnType<typeof startTask>;
  assert.equal(started.branch, 'feature/login');
});

test('task commands share one private workspace per repository and task, owned file by file', async (t) => {
  const root = fixture(t);
  const started = startTask(root, { id: 'team', title: 'Team', author: 'codex' });
  assert.equal(started.workspace, join(process.env.HALVARD_WORKSPACE!, basename(root), 'team'));
  assert.equal(statSync(started.workspace).mode & 0o077, 0);
  assert.equal(resumeTask(root, started.task).workspace, started.workspace);
  assert.equal(handoffTask(root, started.task, 'claude').workspace, started.workspace);
  const twin = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-twin-')));
  t.after(() => rmSync(twin, { recursive: true, force: true }));
  mkdirSync(join(twin, basename(root)));
  assert.throws(
    () => taskWorkspace(join(twin, basename(root)), 'team'),
    /belongs to another repository/,
  );
  const call = (harness: string, tool: string, input: Record<string, unknown>) =>
    handle(harness, {
      cwd: root,
      session_id: 'team',
      hook_event_name: 'PreToolUse',
      tool_name: tool,
      tool_input: input,
    });
  const own = join(started.workspace, 'pi-findings.md');
  const other = join(started.workspace, 'claude-brief-codex.md');
  assert.equal((await call('pi', 'write', { path: own, content: 'x' })).decision, undefined);
  assert.match((await call('pi', 'write', { path: other, content: 'x' })).reason!, /not yours/);
  assert.equal(
    (await call('claude', 'Write', { file_path: other, content: 'x' })).decision,
    undefined,
  );
  assert.match(
    (await call('claude', 'Edit', { file_path: own, old_string: 'x', new_string: 'y' })).reason!,
    /not yours/,
  );
  const patch = (path: string) => ({
    command: `*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch`,
  });
  assert.equal(
    (await call('codex', 'apply_patch', patch(join(started.workspace, 'codex-report.md'))))
      .decision,
    undefined,
  );
  assert.match((await call('codex', 'apply_patch', patch(own))).reason!, /not yours/);
  await assert.rejects(
    call('codex', 'apply_patch', {
      command: `*** Begin Patch\n*** Add File: ${join(started.workspace, 'codex-report.md')}\n+x\n*** Add File: source.txt\n+x\n*** End Patch`,
    }),
    /patch mixes task workspace and other files; send workspace files and repository files as separate patches$/,
  );
  assert.equal(existsSync(join(started.workspace, '.repo')), true);
});

test('a workspace ownership denial names the prefix to use and where the file is', async (t) => {
  const root = fixture(t);
  const started = startTask(root, { id: 'owner', title: 'Owner', author: 'codex' });
  const write = (path: string) =>
    handle('claude', {
      cwd: root,
      session_id: 'owner',
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: path, content: 'x' },
    });
  assert.equal(
    (await write(join(process.env.HALVARD_WORKSPACE!, 'halvard-fix-prompt.md'))).reason,
    'halvard-fix-prompt.md in the agent workspace is not yours. Each file there has one writer, named by its prefix; write claude-halvard-fix-prompt.md instead.',
  );
  assert.equal(
    (await write(join(started.workspace, 'codex-report.md'))).reason,
    'codex-report.md in the task workspace is not yours. Each file there has one writer, named by its prefix; write claude-report.md instead.',
  );
  assert.equal(
    (await write(join(process.env.HALVARD_WORKSPACE!, 'claude-fix-prompt.md'))).decision,
    undefined,
  );
});

test("a dangling outside alias cannot write another writer's workspace file", async (t) => {
  const root = fixture(t);
  const started = startTask(root, { id: 'alias', title: 'Alias', author: 'codex' });
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-ws-alias-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(join(started.workspace, 'claude-victim.md'), join(outside, 'pi-alias.md'));
  const result = await handle('pi', {
    cwd: root,
    session_id: 'alias',
    hook_event_name: 'PreToolUse',
    tool_name: 'write',
    tool_input: { path: join(outside, 'pi-alias.md'), content: 'x' },
  });
  assert.match(result.reason!, /claude-victim\.md in the task workspace is not yours/);
});

test('workspace writes refuse hard links and workspaces must be private real directories', async (t) => {
  const root = fixture(t);
  const started = startTask(root, { id: 'links', title: 'Links', author: 'codex' });
  writeFileSync(join(started.workspace, 'claude-brief.md'), 'brief');
  linkSync(join(started.workspace, 'claude-brief.md'), join(started.workspace, 'pi-alias.md'));
  const call = (input: Record<string, unknown>, tool = 'write', harness = 'pi') =>
    handle(harness, {
      cwd: root,
      session_id: 'links',
      hook_event_name: 'PreToolUse',
      tool_name: tool,
      tool_input: input,
    });
  await assert.rejects(
    call({ path: join(started.workspace, 'pi-alias.md'), content: 'x' }),
    /multiple hard links/,
  );
  linkSync(join(root, '.halvard.json'), join(started.workspace, 'codex-config.md'));
  await assert.rejects(
    call(
      {
        command: `*** Begin Patch\n*** Update File: ${join(started.workspace, 'codex-config.md')}\n@@\n-x\n+y\n*** End Patch`,
      },
      'apply_patch',
      'codex',
    ),
    /multiple hard links/,
  );
  await assert.rejects(
    call(
      {
        command: `*** Begin Patch\r\n*** Update File: ${join(started.workspace, 'codex-config.md')}\r\n@@\r\n-x\r\n+y\r\n*** End Patch\r\n`,
      },
      'apply_patch',
      'codex',
    ),
    /multiple hard links/,
  );
  writeFileSync(join(started.workspace, 'claude-notes.md'), 'notes\n');
  symlinkSync(join(started.workspace, 'claude-notes.md'), join(started.workspace, 'codex-link.md'));
  assert.match(
    (
      await call(
        {
          command: `*** Begin Patch\r\n*** Update File: ${join(started.workspace, 'codex-link.md')}\r\n@@\r\n-notes\r\n+x\r\n*** End Patch\r\n`,
        },
        'apply_patch',
        'codex',
      )
    ).reason!,
    /claude-notes\.md in the task workspace is not yours/,
  );
  const target = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-ws-target-')));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  symlinkSync(target, join(process.env.HALVARD_WORKSPACE!, basename(root), 'linked'));
  assert.throws(() => taskWorkspace(root, 'linked'), /unsafe/);
  mkdirSync(join(process.env.HALVARD_WORKSPACE!, basename(root), 'shared'), { mode: 0o755 });
  chmodSync(join(process.env.HALVARD_WORKSPACE!, basename(root), 'shared'), 0o755);
  assert.throws(() => taskWorkspace(root, 'shared'), /unsafe/);
});
