import type { TestContext } from 'node:test';
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
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { handle } from '../core/runtime.ts';
import { toHookPayload } from '../core/harnesses/index.ts';
import { logRoot } from '../core/config/paths.ts';
import { eventFile, readEvents, repoLogDirectory, writeEvent } from '../core/events.ts';
import { startTask } from '../core/workflow/tasks.ts';
import { runGate } from '../core/workflow/gate.ts';
import { retroEvents } from '../core/workflow/retro.ts';
import { sessionKey } from '../core/state.ts';

function fixture(t: TestContext, gate = 'process.exit(0)', workflow = {}, extra = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-events-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: root });
  writeFileSync(
    join(root, '.halvard.json'),
    JSON.stringify({
      gate: [process.execPath, '-e', gate],
      workflow: { reviewers: { claude: {}, codex: {}, grok: {}, cursor: {} }, ...workflow },
      ...extra,
    }),
  );
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync(
    'git',
    ['-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'fixture'],
    { cwd: root },
  );
  return root;
}

const write = (root: string, harness: string, session: string, file = 'a.txt') =>
  handle(harness, {
    cwd: root,
    session_id: session,
    hook_event_name: 'PreToolUse',
    tool_name: harness === 'pi' ? 'write' : 'Write',
    tool_input: harness === 'pi' ? { path: file, content: 'x' } : { file_path: file, content: 'x' },
  });

test('a denial on a branch without a task goes to the repository log, by session key', async (t) => {
  const root = fixture(t);
  const result = await write(root, 'grok', 'raw-session-id');
  assert.equal(result.decision, 'deny');
  const file = eventFile(repoLogDirectory(root), null);
  const events = readEvents(file);
  const deny = events.find((event) => event.kind === 'deny')!;
  assert.equal(deny.harness, 'grok');
  assert.equal(deny.branch, 'main');
  assert.equal(deny.task, null);
  assert.equal(deny.session, sessionKey(root, 'grok', 'raw-session-id'));
  assert.equal(readFileSync(file, 'utf8').includes('raw-session-id'), false);
  assert.match(String(deny.reason), /\S/);
});

test('session starts are logged for the repository', async (t) => {
  const root = fixture(t);
  await handle('cursor', { cwd: root, session_id: 's1', hook_event_name: 'SessionStart' });
  const events = readEvents(eventFile(repoLogDirectory(root), null));
  assert.deepEqual(
    events.map((event) => [event.kind, event.harness]),
    [['session', 'cursor']],
  );
});

test('skill loads are logged after the call, for every way a harness loads one', async (t) => {
  const root = fixture(t);
  const after = (harness: string, tool_name: string, tool_input: object, is_error = false) =>
    handle(harness, {
      cwd: root,
      session_id: 's1',
      hook_event_name: 'PostToolUse',
      tool_name,
      tool_input,
      is_error,
    });
  await after('claude', 'Skill', { skill: 'halvard:halvard-review', args: 'x' });
  await after('pi', 'read', { path: '/opt/halvard/skills/halvard-test/SKILL.md' });
  await after('grok', 'Read', { target_file: '/opt/halvard/skills/halvard-debug/SKILL.md' });
  await after('codex', 'exec_command', {
    cmd: "sed -n '1,200p' /opt/halvard/skills/halvard-spec/SKILL.md",
  });
  await after('claude', 'Bash', {
    command: 'cd /opt/halvard && cat skills/halvard-design/SKILL.md',
  });
  // A separator inside sed's quoted script does not split the command.
  await after('codex', 'exec_command', {
    cmd: "sed -n '1p;2p' /opt/halvard/skills/halvard-correct/SKILL.md",
  });
  // A failed load, a search or an echo that names a skill file and an ordinary read load nothing.
  await after('claude', 'Skill', { skill: 'halvard-verify' }, true);
  await after('codex', 'exec_command', {
    cmd: 'grep -n gate /opt/halvard/skills/halvard/SKILL.md',
  });
  await after('codex', 'exec_command', { cmd: 'cat README.md; echo skills/halvard/SKILL.md' });
  // A read whose failure the command hides, or one only a comment names, proves nothing.
  await after('codex', 'exec_command', { cmd: 'cat missing/skills/halvard/SKILL.md || true' });
  // A reader sent to the background reports a successful launch even when the read fails.
  await after('codex', 'exec_command', { cmd: 'cat /missing/skills/halvard-test/SKILL.md &' });
  // A reader skipped by ||, a sed that prints nothing and a zero count load nothing either.
  await after('codex', 'exec_command', { cmd: 'true || cat /opt/halvard/skills/halvard/SKILL.md' });
  await after('codex', 'exec_command', { cmd: "sed -n 'd' /opt/halvard/skills/halvard/SKILL.md" });
  await after('codex', 'exec_command', { cmd: "sed '1p' /opt/halvard/skills/halvard/SKILL.md" });
  await after('codex', 'exec_command', { cmd: 'head -n 0 /opt/halvard/skills/halvard/SKILL.md' });
  await after('codex', 'exec_command', { cmd: 'tail -c0 /opt/halvard/skills/halvard/SKILL.md' });
  // sed numbers lines across its files, so '1p' here prints only README.md's first line.
  await after('codex', 'exec_command', {
    cmd: "sed -n '1p' README.md /opt/halvard/skills/halvard/SKILL.md",
  });
  // A negative head count leaves out the last lines or bytes, all of a shorter file.
  await after('codex', 'exec_command', {
    cmd: 'head -n -999999 /opt/halvard/skills/halvard/SKILL.md',
  });
  await after('codex', 'exec_command', { cmd: 'head -c -5 /opt/halvard/skills/halvard/SKILL.md' });
  // A range that starts after the first line may start past the end and print nothing.
  await after('codex', 'exec_command', {
    cmd: "sed -n '999999p' /opt/halvard/skills/halvard/SKILL.md",
  });
  await after('codex', 'exec_command', { cmd: 'tail -n +40 /opt/halvard/skills/halvard/SKILL.md' });
  await after('codex', 'exec_command', {
    cmd: 'bat -r 40:60 /opt/halvard/skills/halvard/SKILL.md',
  });
  // A skill path that is only an option's value, here nl's line separator, is not read.
  await after('codex', 'exec_command', {
    cmd: 'nl -s /opt/halvard/skills/halvard/SKILL.md README.md',
  });
  // Output sent to /dev/null never reaches the agent.
  await after('codex', 'exec_command', {
    cmd: 'cat /opt/halvard/skills/halvard/SKILL.md >/dev/null',
  });
  await after('codex', 'exec_command', {
    cmd: 'cat /opt/halvard/skills/halvard/SKILL.md 1>/dev/null 2>&1',
  });
  // A help, version or zero-count long option prints something other than the file.
  await after('codex', 'exec_command', { cmd: 'cat --help /opt/halvard/skills/halvard/SKILL.md' });
  await after('codex', 'exec_command', {
    cmd: 'head --lines=0 /opt/halvard/skills/halvard/SKILL.md',
  });
  await after('codex', 'exec_command', { cmd: 'bat -V /opt/halvard/skills/halvard/SKILL.md' });
  await after('codex', 'exec_command', { cmd: 'cat /opt/halvard/skills/halvard/SKILL.md | head' });
  await after('codex', 'exec_command', {
    cmd: "sed -n '1p' README.md # skills/halvard/SKILL.md",
  });
  await after('claude', 'Read', { file_path: join(root, 'README.md') });
  // Grok's search reaches the engine as Read; its query marks it as a search.
  await handle(
    'grok',
    toHookPayload('grok', {
      cwd: root,
      sessionId: 's1',
      hookEventName: 'post_tool_use',
      toolName: 'grep_search',
      toolInput: { query: 'gate', path: '/opt/halvard/skills/halvard/SKILL.md' },
    }),
  );
  // Grok can deliver one call to several Halvard entries, with other calls in between; each
  // call's load is logged once.
  for (const [call, skill] of [
    ['grok-call-1', 'halvard-benchmark'],
    ['grok-call-2', 'halvard-bootstrap'],
    ['grok-call-1', 'halvard-benchmark'],
  ]) {
    await handle(
      'grok',
      toHookPayload('grok', {
        cwd: root,
        sessionId: 's1',
        hookEventName: 'post_tool_use',
        toolName: 'read_file',
        toolUseId: call,
        toolInput: { target_file: `/opt/halvard/skills/${skill}/SKILL.md` },
      }),
    );
  }
  // Cursor's afterShellExecution has no exit status, so a read that may have failed is not counted.
  await handle(
    'cursor',
    toHookPayload('cursor', {
      cwd: root,
      workspace_roots: [root],
      conversation_id: 's1',
      hook_event_name: 'afterShellExecution',
      command: 'cat /opt/halvard/skills/halvard-retro/SKILL.md',
      output: 'cat: /opt/halvard/skills/halvard-retro/SKILL.md: No such file or directory',
    }),
  );
  // A PreToolUse is not a load yet.
  await handle('claude', {
    cwd: root,
    session_id: 's1',
    hook_event_name: 'PreToolUse',
    tool_name: 'Skill',
    tool_input: { skill: 'halvard-handoff' },
  });
  const events = readEvents(eventFile(repoLogDirectory(root), null));
  assert.deepEqual(
    events.map((event) => [event.kind, event.harness, event.skill, event.branch]),
    [
      ['skill', 'claude', 'halvard-review', 'main'],
      ['skill', 'pi', 'halvard-test', 'main'],
      ['skill', 'grok', 'halvard-debug', 'main'],
      ['skill', 'codex', 'halvard-spec', 'main'],
      ['skill', 'claude', 'halvard-design', 'main'],
      ['skill', 'codex', 'halvard-correct', 'main'],
      ['skill', 'grok', 'halvard-benchmark', 'main'],
      ['skill', 'grok', 'halvard-bootstrap', 'main'],
    ],
  );
  assert.equal(events[0]!.session, sessionKey(root, 'claude', 's1'));
});

test('a skill read followed by ; or a newline counts only when its file is readable', async (t) => {
  const root = fixture(t);
  for (const skill of ['halvard-debug', 'halvard-spec', 'halvard-test', 'halvard-retro']) {
    mkdirSync(join(root, 'skills', skill), { recursive: true });
    writeFileSync(join(root, 'skills', skill, 'SKILL.md'), `# ${skill}\n`);
  }
  mkdirSync(join(root, 'skills', 'halvard-write', 'SKILL.md'), { recursive: true });
  const after = (cmd: string) =>
    handle('codex', {
      cwd: root,
      session_id: 's1',
      hook_event_name: 'PostToolUse',
      tool_name: 'exec_command',
      tool_input: { cmd },
    });
  // A successful read of an existing file, then ; or a newline and more commands.
  await after(`cat ${join(root, 'skills/halvard-debug/SKILL.md')}; cat .halvard.json`);
  await after("sed -n '1,200p' skills/halvard-spec/SKILL.md\ncat .halvard.json");
  await after('cat skills/halvard-test/SKILL.md && cat .halvard.json; ls');
  // A read that failed is hidden by the ; that follows it, so it does not count: a missing
  // file, a folder, a relative path after cd, or a reader skipped by ||.
  await after('cat /missing/skills/halvard-handoff/SKILL.md; true');
  await after('cat skills/halvard-write/SKILL.md; true');
  await after('cd /tmp; cat skills/halvard-retro/SKILL.md; true');
  await after('false || cat skills/halvard-retro/SKILL.md; true');
  // A pipe after the reader still proves nothing about the read.
  await after('cat skills/halvard-retro/SKILL.md | head; true');
  const events = readEvents(eventFile(repoLogDirectory(root), null));
  assert.deepEqual(
    events.map((event) => [event.kind, event.skill]),
    [
      ['skill', 'halvard-debug'],
      ['skill', 'halvard-spec'],
      ['skill', 'halvard-test'],
    ],
  );
});

test('a task run logs its start, mode, gate and denials in the task log', async (t) => {
  const root = fixture(
    t,
    'process.exit(0)',
    {},
    { team: { lead: 'claude', dev: 'cursor', reviewer: 'codex' } },
  );
  startTask(root, { id: 'team-run', title: 'Team run', author: 'cursor', team: true });
  const task = readFileSync(join(root, 'docs/tasks/team-run.md'), 'utf8');
  assert.match(task, /"mode":"team"/);
  const key = sessionKey(root, 'cursor', 'c1');
  await handle('cursor', { cwd: root, session_id: 'c1', hook_event_name: 'SessionStart' });
  await runGate(root, key);
  // An edit to the workflow configuration asks on a task branch.
  const ask = await write(root, 'cursor', 'c1', '.halvard.json');
  assert.equal(ask.decision, 'ask');
  const events = readEvents(eventFile(repoLogDirectory(root), 'team-run'));
  assert.deepEqual(
    events.map((event) => event.kind),
    ['task-start', 'gate', 'ask'],
  );
  assert.ok(events.every((event) => event.mode === 'team' && event.task === 'team-run'));
  assert.equal(events[1]!.passed, true);
  assert.equal(events[1]!.session, key);

  const retro = await retroEvents(root, 'team-run');
  assert.equal(retro.source, 'log');
  assert.equal(retro.events.cursor!.gatePasses, 1);
  assert.equal(retro.events.cursor!.asks.length, 1);
  assert.deepEqual(retro.events.cursor!.sessions, [key]);
});

test('a failed gate is logged with its reason', async (t) => {
  const root = fixture(t, 'process.exit(1)');
  startTask(root, { id: 'failing', title: 'Failing', author: 'grok' });
  const key = sessionKey(root, 'grok', 'g1');
  await assert.rejects(runGate(root, key), /gate failed/);
  const gate = readEvents(eventFile(repoLogDirectory(root), 'failing')).find(
    (event) => event.kind === 'gate',
  )!;
  assert.equal(gate.passed, false);
  assert.equal(gate.reason, 'checks failed or timed out');
  assert.equal(gate.mode, 'solo');
});

test('a log that cannot be written does not change the decision', async (t) => {
  const root = fixture(t);
  // A file where the log folder belongs, so no event can be written.
  rmSync(logRoot(), { recursive: true, force: true });
  writeFileSync(logRoot(), 'not a folder');
  t.after(() => rmSync(logRoot(), { force: true }));
  const result = await write(root, 'claude', 'c1');
  assert.equal(result.decision, 'deny');
  assert.equal(readFileSync(logRoot(), 'utf8'), 'not a folder');
});

test('a factory run keeps no run log here', async (t) => {
  const root = fixture(t);
  const previous = process.env.HALVARD_UNATTENDED;
  process.env.HALVARD_UNATTENDED = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.HALVARD_UNATTENDED;
    else process.env.HALVARD_UNATTENDED = previous;
  });
  await write(root, 'codex', 'f1');
  assert.equal(existsSync(join(logRoot(), basename(root))), false);
});

test('two repositories with one folder name keep separate logs', (t) => {
  const first = fixture(t);
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-events-other-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const second = join(parent, basename(first));
  mkdirSync(second);
  assert.notEqual(repoLogDirectory(first), repoLogDirectory(second));
  assert.equal(repoLogDirectory(first), repoLogDirectory(first));
});

test('a hook error that blocks the tool is logged as a denial without its message', async (t) => {
  const root = fixture(t);
  startTask(root, { id: 'mixed', title: 'Mixed', author: 'codex' });
  const workspace = process.env.HALVARD_WORKSPACE!;
  await assert.rejects(
    handle('codex', {
      cwd: root,
      session_id: 'x1',
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: {
        command: `*** Begin Patch\n*** Add File: ${join(workspace, basename(root), 'mixed', 'codex-a.md')}\n+x\n*** Add File: source.txt\n+x\n*** End Patch`,
      },
    }),
    /patch mixes/,
  );
  const deny = readEvents(eventFile(repoLogDirectory(root), 'mixed')).find(
    (event) => event.kind === 'deny',
  )!;
  assert.equal(deny.reason, 'hook error');
  assert.equal(deny.harness, 'codex');
});

test('a task id that is not a slug never becomes a log path', (t) => {
  const root = fixture(t);
  writeEvent(root, 'probe', { task: '..', harness: 'pi' });
  writeEvent(root, 'probe', { task: '../escape', harness: 'pi' });
  const events = readEvents(eventFile(repoLogDirectory(root), null));
  assert.deepEqual(
    events.map((event) => event.task),
    [null, null],
  );
  assert.equal(existsSync(join(logRoot(), 'escape')), false);
});

test('a symlink planted in the log folder is not written through', (t) => {
  const root = fixture(t);
  const dir = repoLogDirectory(root);
  const target = join(realpathSync(mkdtempSync(join(tmpdir(), 'workflow-events-target-'))), 'x');
  t.after(() => rmSync(dirname(target), { recursive: true, force: true }));
  writeFileSync(target, 'original');
  symlinkSync(target, join(dir, 'events.jsonl'));
  writeEvent(root, 'probe', { harness: 'pi' });
  mkdirSync(join(dir, 'planted'));
  rmSync(join(dir, 'planted'), { recursive: true });
  symlinkSync(dirname(target), join(dir, 'planted'));
  writeEvent(root, 'probe', { harness: 'pi', task: 'planted' });
  assert.equal(readFileSync(target, 'utf8'), 'original');
  assert.equal(existsSync(join(dirname(target), 'events.jsonl')), false);
});

test('marking one of two tasks on a branch done logs it in that task', async (t) => {
  // Without required review, a passing gate is all a done edit needs.
  const root = fixture(t, 'process.exit(0)', { requireReview: false });
  startTask(root, { id: 'first', title: 'First', author: 'claude' });
  // A follow-up on the same branch, newer than the first.
  const second = readFileSync(join(root, 'docs/tasks/first.md'), 'utf8');
  writeFileSync(join(root, 'docs/tasks/second.md'), second.replace('# First', '# Second'));
  const key = sessionKey(root, 'claude', 'd1');
  await runGate(root, key);
  const before = readFileSync(join(root, 'docs/tasks/first.md'), 'utf8');
  const result = await handle('claude', {
    cwd: root,
    session_id: 'd1',
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: {
      file_path: 'docs/tasks/first.md',
      content: before.replace('**Status:** open.', '**Status:** done.'),
    },
  });
  assert.equal(result.decision, undefined, result.reason);
  const done = readEvents(eventFile(repoLogDirectory(root), 'first')).filter(
    (event) => event.kind === 'task-done',
  );
  assert.equal(done.length, 1);
  assert.equal(
    readEvents(eventFile(repoLogDirectory(root), 'second')).some(
      (event) => event.kind === 'task-done',
    ),
    false,
  );
});

test('a gate run whose session no event names is counted as unattributed', async (t) => {
  const root = fixture(t);
  startTask(root, { id: 'orphan', title: 'Orphan', author: 'pi' });
  await runGate(root, sessionKey(root, 'pi', 'never-started'));
  const retro = await retroEvents(root, 'orphan');
  assert.equal(retro.source, 'log');
  assert.equal(retro.unattributed.gatePasses, 1);
  assert.equal(retro.events.pi!.gatePasses, 0);
});
