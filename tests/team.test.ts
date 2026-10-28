import type { TestContext } from 'node:test';
import './environment.ts';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { teamConfig } from '../core/config/team.ts';
import { loadProject } from '../core/project.ts';
import { handle } from '../core/runtime.ts';

const runner = fileURLToPath(new URL('../bin/halvard.ts', import.meta.url));

function repo(t: TestContext, config: unknown = { version: 1, gate: ['true'] }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-team-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root });
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(root, '.halvard.json'), JSON.stringify(config, null, 2) + '\n');
  git('add', '.');
  git('commit', '-q', '-m', 'initial');
  git('checkout', '-q', '-b', 'feature/team');
  return root;
}

const halvard = (root: string, ...args: string[]) =>
  spawnSync(process.execPath, [runner, ...args], { cwd: root, encoding: 'utf8' });

test('a team names three different-enough harnesses and an optional investigator', () => {
  assert.deepEqual(teamConfig({ lead: 'claude', dev: 'cursor', reviewer: 'grok' }), {
    lead: 'claude',
    dev: 'cursor',
    reviewer: 'grok',
    investigator: null,
    monitor: { watch: true, nudge: true, approve: 'reads-edits-gate' },
  });
  // The lead may review: it did not write the change.
  assert.equal(teamConfig({ lead: 'pi', dev: 'codex', reviewer: 'pi' }).reviewer, 'pi');
  for (const [team, message] of [
    [{ lead: 'claude', dev: 'claude', reviewer: 'pi' }, /lead and dev must be different/],
    [{ lead: 'claude', dev: 'codex', reviewer: 'codex' }, /reviewer must not be the dev/],
    [{ lead: 'claude', dev: 'codex', reviewer: 'ollama' }, /team reviewer must be/],
    [{ lead: 'claude', dev: 'codex' }, /team reviewer must be/],
    [{ lead: 'claude', dev: 'codex', reviewer: 'pi', investigator: 'gpt' }, /investigator/],
    [{ lead: 'claude', dev: 'codex', reviewer: 'pi', size: 3 }, /unknown team option: size/],
    [{ lead: 'claude', dev: 'codex', reviewer: 'pi', monitor: 'on' }, /monitor must be an object/],
    [
      { lead: 'claude', dev: 'codex', reviewer: 'pi', monitor: { approve: 'all' } },
      /reads-edits-gate or none/,
    ],
  ] as const) {
    assert.throws(() => teamConfig(team), message);
  }
});

test('team set saves the team, keeps other settings and is shown back', (t) => {
  const root = repo(t);
  assert.deepEqual(JSON.parse(halvard(root, 'team', 'show').stdout), { root, team: null });
  const set = halvard(
    root,
    'team',
    'set',
    '--lead',
    'claude',
    '--dev',
    'codex',
    '--reviewer',
    'grok',
    '--investigator',
    'pi',
    '--nudge',
    'off',
  );
  assert.equal(set.status, 0, set.stderr);
  const saved = JSON.parse(readFileSync(join(root, '.halvard.json'), 'utf8')) as {
    gate: string[];
    team: unknown;
  };
  assert.deepEqual(saved.gate, ['true']);
  assert.deepEqual(saved.team, {
    lead: 'claude',
    dev: 'codex',
    reviewer: 'grok',
    investigator: 'pi',
    monitor: { watch: true, nudge: false, approve: 'reads-edits-gate' },
  });
  // A later change names only what changes.
  const swap = halvard(root, 'team', 'set', '--dev', 'cursor', '--investigator', 'none');
  assert.equal(swap.status, 0, swap.stderr);
  assert.deepEqual(loadProject(root).config.team, {
    lead: 'claude',
    dev: 'cursor',
    reviewer: 'grok',
    investigator: null,
    monitor: { watch: true, nudge: false, approve: 'reads-edits-gate' },
  });
  const invalid = halvard(root, 'team', 'set', '--reviewer', 'cursor');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /reviewer must not be the dev/);
  assert.equal(loadProject(root).config.team!.reviewer, 'grok');
});

test('an invalid saved team stops the configuration from loading', (t) => {
  const root = repo(t, { version: 1, team: { lead: 'claude', dev: 'claude', reviewer: 'pi' } });
  assert.throws(() => loadProject(root), /lead and dev must be different/);
});

test('the guard reads team show freely and asks before team set', async (t) => {
  const root = repo(t);
  const call = (command: string) =>
    handle('claude', {
      cwd: root,
      session_id: 'team-guard',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
    });
  assert.deepEqual(await call(`node ${runner} team show`), {});
  const set = await call(`node ${runner} team set --lead claude --dev codex --reviewer pi`);
  assert.equal(set.decision, 'ask');
  assert.match(set.reason!, /changes the team/);
});
