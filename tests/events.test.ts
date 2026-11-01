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
import { logRoot } from '../core/config/paths.ts';
import { eventFile, readEvents, repoLogDirectory, writeEvent } from '../core/events.ts';
import { startTask } from '../core/workflow/tasks.ts';
import { runGate } from '../core/workflow/gate.ts';
import { retroEvents } from '../core/workflow/retro.ts';
import { sessionKey } from '../core/state.ts';

function fixture(t: TestContext, gate = 'process.exit(0)', workflow = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-events-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: root });
  writeFileSync(
    join(root, '.halvard.json'),
    JSON.stringify({
      gate: [process.execPath, '-e', gate],
      workflow: { reviewers: { claude: {}, codex: {}, grok: {}, cursor: {} }, ...workflow },
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

test('a task run logs its start, mode, gate and denials in the task log', async (t) => {
  const root = fixture(t);
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
