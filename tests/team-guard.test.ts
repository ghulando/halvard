import type { TestContext } from 'node:test';
import './environment.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handle } from '../core/runtime.ts';
import { repoLogDirectory, teamMarkerFile, teamOnBranch } from '../core/events.ts';
import { startTask } from '../core/workflow/tasks.ts';
import { runGate } from '../core/workflow/gate.ts';
import { sessionKey } from '../core/state.ts';

function fixture(t: TestContext, team: object | null = defaultTeam) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-team-guard-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: root });
  writeFileSync(
    join(root, '.halvard.json'),
    JSON.stringify({
      gate: [process.execPath, '-e', 'process.exit(0)'],
      workflow: { reviewers: { claude: {}, codex: {}, grok: {} } },
      ...(team ? { team } : {}),
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

const defaultTeam = { lead: 'claude', dev: 'codex', reviewer: 'grok', investigator: 'pi' };

const write = (root: string, harness: string, file: string, content = 'x') =>
  handle(harness, {
    cwd: root,
    session_id: `${harness}-session`,
    hook_event_name: 'PreToolUse',
    tool_name: harness === 'pi' ? 'write' : harness === 'codex' ? 'apply_patch' : 'Write',
    tool_input:
      harness === 'pi'
        ? { path: file, content }
        : harness === 'codex'
          ? { command: `*** Begin Patch\n*** Add File: ${file}\n+${content}\n*** End Patch` }
          : { file_path: file, content },
  });

test('in a team task only the dev changes repository files', async (t) => {
  const root = fixture(t);
  startTask(root, { id: 'feature', title: 'Feature', author: 'codex', team: true });
  assert.equal((await write(root, 'codex', 'src/a.ts')).decision, undefined);
  for (const [harness, role] of [
    ['claude', 'lead'],
    ['grok', 'reviewer'],
    ['pi', 'investigator'],
  ]) {
    const result = await write(root, harness!, 'src/a.ts');
    assert.equal(result.decision, 'deny', harness);
    assert.match(result.reason!, new RegExp(`${harness} is the ${role}; only the dev \\(codex\\)`));
  }
});

test('the lead edits task notes; the reviewer and investigator do not', async (t) => {
  const root = fixture(t);
  startTask(root, { id: 'notes', title: 'Notes', author: 'codex', team: true });
  const task = 'docs/tasks/notes.md';
  const content = readFileSync(join(root, task), 'utf8').replace('None yet.', 'A decision.');
  assert.equal((await write(root, 'claude', task, content)).decision, undefined);
  assert.equal((await write(root, 'grok', task, content)).decision, 'deny');
  assert.equal((await write(root, 'pi', task, content)).decision, 'deny');
});

test('a solo task with the same harnesses is unaffected', async (t) => {
  const root = fixture(t);
  startTask(root, { id: 'solo', title: 'Solo', author: 'codex' });
  assert.equal(teamOnBranch(root, 'feature/solo'), null);
  assert.equal((await write(root, 'claude', 'src/a.ts')).decision, undefined);
});

test('editing the mode in the task file does not lift the rule', async (t) => {
  const root = fixture(t);
  startTask(root, { id: 'sneaky', title: 'Sneaky', author: 'codex', team: true });
  const file = join(root, 'docs/tasks/sneaky.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace('"mode":"team"', '"mode":"solo"'));
  assert.equal((await write(root, 'claude', 'src/a.ts')).decision, 'deny');
});

test('agents cannot edit the team marker', async (t) => {
  const root = fixture(t);
  startTask(root, { id: 'marker', title: 'Marker', author: 'codex', team: true });
  const marker = teamMarkerFile(repoLogDirectory(root), 'marker');
  const result = await handle('codex', {
    cwd: root,
    session_id: 'codex-session',
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: marker, content: '{}' },
  });
  assert.equal(result.decision, 'deny');
  assert.match(result.reason!, /Halvard's own data/);
});

test('an investigator who is also the dev is not restricted', async (t) => {
  const root = fixture(t, {
    lead: 'claude',
    dev: 'codex',
    reviewer: 'grok',
    investigator: 'codex',
  });
  startTask(root, { id: 'both', title: 'Both', author: 'codex', team: true });
  assert.equal((await write(root, 'codex', 'src/a.ts')).decision, undefined);
});

test('a team task needs a saved team', (t) => {
  const root = fixture(t, null);
  assert.throws(
    () => startTask(root, { id: 'none', title: 'None', author: 'codex', team: true }),
    /needs a team in \.halvard\.json/,
  );
  // Nothing was started: still on main, no task file.
  assert.equal(
    execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim(),
    'main',
  );
});

test('task files cannot switch the rule off', async (t) => {
  const root = fixture(t);
  startTask(root, { id: 'guarded', title: 'Guarded', author: 'codex', team: true });
  const file = join(root, 'docs/tasks/guarded.md');
  const original = readFileSync(file, 'utf8');
  // A newer task file on the branch, as a hand-made follow-up would be.
  writeFileSync(join(root, 'docs/tasks/zz.md'), original.replace('# Guarded', '# Follow-up'));
  assert.equal((await write(root, 'claude', 'src/a.ts')).decision, 'deny');
  // The task file no longer naming the branch.
  writeFileSync(file, original.replace('"branch":"feature/guarded"', '"branch":"feature/other"'));
  assert.equal((await write(root, 'claude', 'src/a.ts')).decision, 'deny');
  // The denial's first line is the same for every file, so the run log groups it.
  assert.equal(
    (await write(root, 'claude', 'src/b.ts')).reason!.split('\n')[0],
    'Team role: only the dev changes repository files.',
  );
});

test('a solo task reusing a team task id is solo', async (t) => {
  const root = fixture(t);
  startTask(root, { id: 'reuse', title: 'Reuse', author: 'codex', team: true });
  // The team task's branch and file go away, and the id is started again without --team.
  rmSync(join(root, 'docs/tasks/reuse.md'));
  execFileSync('git', ['switch', '-q', 'main'], { cwd: root });
  execFileSync('git', ['branch', '-q', '-D', 'feature/reuse'], { cwd: root });
  startTask(root, { id: 'reuse', title: 'Reuse', author: 'codex' });
  assert.equal(teamOnBranch(root, 'feature/reuse'), null);
  assert.equal((await write(root, 'claude', 'src/a.ts')).decision, undefined);
});

test('a task id whose branch exists is refused before any marker changes', (t) => {
  const root = fixture(t);
  startTask(root, { id: 'kept', title: 'Kept', author: 'codex', team: true });
  rmSync(join(root, 'docs/tasks/kept.md'));
  execFileSync('git', ['switch', '-q', 'main'], { cwd: root });
  assert.throws(
    () => startTask(root, { id: 'kept', title: 'Kept', author: 'codex' }),
    /branch feature\/kept already exists/,
  );
  assert.equal(teamOnBranch(root, 'feature/kept')?.dev, 'codex');
});

test('a marker that does not read stops the hook', async (t) => {
  const root = fixture(t);
  startTask(root, { id: 'broken', title: 'Broken', author: 'codex', team: true });
  writeFileSync(teamMarkerFile(repoLogDirectory(root), 'broken'), 'not json');
  await assert.rejects(write(root, 'codex', 'src/a.ts'), /does not read; fix or remove it/);
});

test('a broken marker of another task does not stop work elsewhere', async (t) => {
  const root = fixture(t);
  startTask(root, { id: 'old', title: 'Old', author: 'codex', team: true });
  writeFileSync(teamMarkerFile(repoLogDirectory(root), 'old'), 'not json');
  rmSync(join(root, 'docs/tasks/old.md'));
  execFileSync('git', ['switch', '-q', 'main'], { cwd: root });
  startTask(root, { id: 'fresh', title: 'Fresh', author: 'codex' });
  assert.equal((await write(root, 'claude', 'src/a.ts')).decision, undefined);
});

test('marking a team task done removes its marker', async (t) => {
  const root = fixture(t);
  writeFileSync(
    join(root, '.halvard.json'),
    JSON.stringify({
      ...JSON.parse(readFileSync(join(root, '.halvard.json'), 'utf8')),
      workflow: { reviewers: { claude: {}, codex: {}, grok: {} }, requireReview: false },
    }),
  );
  execFileSync('git', ['commit', '-qam', 'no review', '--author', 'F <f@example.invalid>'], {
    cwd: root,
    env: { ...process.env, GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.invalid' },
  });
  startTask(root, { id: 'finish', title: 'Finish', author: 'codex', team: true });
  await runGate(root, sessionKey(root, 'claude', 'claude-session'));
  const task = 'docs/tasks/finish.md';
  const done = readFileSync(join(root, task), 'utf8').replace(
    '**Status:** open.',
    '**Status:** done.',
  );
  assert.equal((await write(root, 'claude', task, done)).decision, undefined);
  assert.equal(teamOnBranch(root, 'feature/finish'), null);
});
