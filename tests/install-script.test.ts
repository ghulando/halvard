import type { TestContext } from 'node:test';
import type { Fixtures } from './script-stubs.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { lists, runScript } from './script-stubs.ts';

// The earlier agent-workflow name, under the current and the older marketplace.
const oldLocal = 'agent-workflow@agent-workflow-local';
const oldGhulando = 'agent-workflow@ghulando';
const oldPi = 'git:github.com/ghulando/agent-workflow';
const plugin = 'halvard@ghulando';
const pi = 'git:github.com/ghulando/halvard';

const run = (t: TestContext, fixtures: Fixtures) => runScript(t, 'install.sh', fixtures);

test('install script installs every harness on a fresh machine', (t) => {
  const result = run(t, lists([], [], [], [], 'User packages:\n'));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [
    'claude plugin marketplace add ghulando/halvard',
    `claude plugin install ${plugin}`,
    'codex plugin marketplace add ghulando/halvard',
    `codex plugin add ${plugin}`,
    `pi install ${pi}`,
  ]);
});

test('install script removes the earlier agent-workflow install and names project installs', (t) => {
  const result = run(
    t,
    lists(
      [{ name: 'agent-workflow-local' }, { name: 'ghulando' }],
      [
        { id: oldLocal, scope: 'project' },
        { id: oldLocal, scope: 'user' },
        { id: oldGhulando, scope: 'user' },
      ],
      [{ name: 'agent-workflow-local' }, { name: 'ghulando' }],
      [{ pluginId: oldLocal }, { pluginId: oldGhulando }],
      `User packages:\n  ${oldPi}\n    /home/.pi/agent/git/github.com/ghulando/agent-workflow\n`,
    ),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [
    `claude plugin uninstall ${oldGhulando}`,
    `claude plugin uninstall ${oldLocal}`,
    'claude plugin marketplace remove agent-workflow-local',
    'claude plugin marketplace update ghulando',
    `claude plugin install ${plugin}`,
    `codex plugin remove ${oldGhulando}`,
    `codex plugin remove ${oldLocal}`,
    'codex plugin marketplace remove agent-workflow-local',
    'codex plugin marketplace upgrade ghulando',
    `codex plugin add ${plugin}`,
    `pi remove ${oldPi}`,
    `pi install ${pi}`,
  ]);
  assert.match(
    result.stdout,
    /claude plugin uninstall agent-workflow@agent-workflow-local --scope project/,
  );
});

test('install script refreshes and reinstalls an existing install', (t) => {
  const result = run(
    t,
    lists(
      [{ name: 'ghulando' }],
      [{ id: plugin, scope: 'user' }],
      [{ name: 'ghulando' }],
      [{ pluginId: plugin }],
      `User packages:\n  ${pi}\n`,
    ),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [
    'claude plugin marketplace update ghulando',
    `claude plugin uninstall ${plugin}`,
    `claude plugin install ${plugin}`,
    'codex plugin marketplace upgrade ghulando',
    `codex plugin remove ${plugin}`,
    `codex plugin add ${plugin}`,
    `pi update ${pi}`,
  ]);
});

test('install script stops before changes when a harness reports unexpected output', (t) => {
  const result = run(t, { ...lists([], [], [], [], ''), 'claude-plugin-list---json': 'not json' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.calls, []);
  assert.match(result.stderr, /Unexpected output from claude plugin list/);
});

test('install script stops before changes when a Claude plugin has no scope', (t) => {
  const result = run(t, lists([{ name: 'agent-workflow-local' }], [{ id: oldLocal }], [], [], ''));
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.calls, []);
  assert.match(result.stderr, /Unexpected output from claude plugin list/);
});

test('install script stops when a listing command fails', (t) => {
  const result = run(t, { ...lists([], [], [], [], ''), 'pi-list.fail': '' });
  assert.notEqual(result.status, 0);
  assert.ok(!result.calls.some((call) => call.startsWith('pi ')));
});

const empty = lists([], [], [], [], 'User packages:\n');

test('install script registers Grok and leaves hook trust to the user', (t) => {
  const fresh = runScript(
    t,
    'install.sh',
    { ...empty, 'grok-plugin-list---json': '[]' },
    {
      extra: ['grok'],
    },
  );
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.deepEqual(
    fresh.calls.filter((call) => call.startsWith('grok')),
    [],
  );
  // The plugin itself is installed only by the user, because it grants hook trust.
  assert.match(fresh.stdout, /grok plugin install ghulando\/halvard --trust/);
  const update = runScript(
    t,
    'install.sh',
    {
      ...empty,
      'grok-plugin-list---json': JSON.stringify({ plugins: [{ name: 'halvard' }] }),
    },
    { extra: ['grok'] },
  );
  assert.equal(update.status, 0, update.stderr);
  assert.deepEqual(
    update.calls.filter((call) => call.startsWith('grok')),
    ['grok plugin update halvard'],
  );
  assert.doesNotMatch(update.stdout, /--trust/);
});

test('install script stops before Grok changes on unexpected output', (t) => {
  const result = runScript(
    t,
    'install.sh',
    { ...empty, 'grok-plugin-list---json': '{}' },
    {
      extra: ['grok'],
    },
  );
  assert.notEqual(result.status, 0);
  assert.ok(!result.calls.some((call) => call.startsWith('grok')));
  assert.match(result.stderr, /Unexpected output from grok plugin list/);
});

// A Cursor clone from an earlier install; the git stub stands in for the pull.
function cursorClone(home: string) {
  const root = join(home, '.config/halvard/cursor');
  for (const dir of ['.git', 'hooks', 'skills/halvard', 'skills/halvard-spec']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(
    join(root, 'hooks/cursor.json'),
    readFileSync(new URL('../hooks/cursor.json', import.meta.url), 'utf8'),
  );
  return root;
}

test('install script merges Cursor hooks, keeps other entries and links the skills', (t) => {
  let root = '';
  const result = runScript(t, 'install.sh', empty, {
    extra: ['cursor-agent', 'git'],
    prepare: (home) => {
      root = cursorClone(home);
      mkdirSync(join(home, '.cursor/skills/halvard-spec'), { recursive: true });
      writeFileSync(
        join(home, '.cursor/hooks.json'),
        JSON.stringify({
          version: 1,
          hooks: {
            preToolUse: [
              { command: 'audit.sh' },
              { command: 'f="/old/bin/hook.ts"; node "$f" cursor', failClosed: true },
            ],
          },
        }),
      );
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.at(-1), `git -C ${root} pull --ff-only --quiet`);
  const cursorDir = join(result.home, '.cursor');
  const hooks = JSON.parse(readFileSync(join(cursorDir, 'hooks.json'), 'utf8')) as {
    hooks: Record<string, { command: string; failClosed?: boolean }[]>;
  };
  // The user's own entry stays; the earlier Halvard entry is replaced by the current one.
  assert.equal(hooks.hooks.preToolUse!.length, 2);
  assert.equal(hooks.hooks.preToolUse![0]!.command, 'audit.sh');
  assert.ok(hooks.hooks.preToolUse![1]!.command.startsWith(`f="${root}/bin/hook.ts"`));
  assert.equal(hooks.hooks.preToolUse![1]!.failClosed, true);
  assert.deepEqual(Object.keys(hooks.hooks).sort(), [
    'afterShellExecution',
    'beforeShellExecution',
    'beforeSubmitPrompt',
    'postToolUse',
    'preToolUse',
    'sessionStart',
  ]);
  assert.ok(existsSync(join(cursorDir, 'hooks.json.halvard.bak')));
  assert.equal(readlinkSync(join(cursorDir, 'skills/halvard')), join(root, 'skills/halvard'));
  // A skill directory of the user's own is kept.
  assert.equal(lstatSync(join(cursorDir, 'skills/halvard-spec')).isDirectory(), true);
  assert.match(result.stdout, /kept your own .*halvard-spec/);
});

// util-linux script supplies the terminal the Grok question needs; other systems skip.
const terminal = spawnSync('script', ['--version'], { encoding: 'utf8' }).stdout?.includes(
  'util-linux',
)
  ? false
  : 'needs util-linux script';
const grokFresh = { ...empty, 'grok-plugin-list---json': '[]' };
test('install script installs Grok from GitHub on a yes', { skip: terminal }, (t) => {
  const result = runScript(t, 'install.sh', grokFresh, {
    extra: ['grok'],
    terminal: 'y\n',
    env: { NO_COLOR: '1' },
  });
  assert.equal(result.status, 0, result.stdout);
  // The ghulando marketplace is Claude Code's, which Grok does not install from.
  assert.deepEqual(
    result.calls.filter((call) => call.startsWith('grok')),
    ['grok plugin install ghulando/halvard --trust'],
  );
  assert.match(
    result.stdout,
    /\[y\/N\] \S*\s*✓ installed halvard from github\.com\/ghulando\/halvard, hooks trusted/,
  );
  const grok = result.stdout.slice(
    result.stdout.indexOf('■ Grok'),
    result.stdout.indexOf('■ Cursor'),
  );
  assert.doesNotMatch(grok, /marketplace|refused/);
  assert.match(result.stdout, /Grok\s+installed/);
});

test(
  'install script installs Grok from a local clone when GitHub refuses too',
  { skip: terminal },
  (t) => {
    const result = runScript(
      t,
      'install.sh',
      {
        ...grokFresh,
        'grok-plugin-install-ghulando_halvard---trust': 'Error: unsupported source\n',
        'grok-plugin-install-ghulando_halvard---trust.fail': '',
      },
      { extra: ['grok', 'git'], terminal: 'yes\n', env: { NO_COLOR: '1' } },
    );
    assert.equal(result.status, 0, result.stdout);
    const root = join(result.home, '.config/halvard/grok');
    assert.deepEqual(result.calls.slice(-2), [
      `git clone --quiet --depth 1 https://github.com/ghulando/halvard.git ${root}`,
      `grok plugin install ${root} --trust`,
    ]);
    assert.match(
      result.stdout,
      /Grok refused github\.com\/ghulando\/halvard: Error: unsupported source/,
    );
    assert.match(result.stdout, /installed halvard from ~\/\.config\/halvard\/grok, hooks trusted/);
  },
);

test('install script leaves Grok alone when the user answers no', { skip: terminal }, (t) => {
  const result = runScript(t, 'install.sh', grokFresh, {
    extra: ['grok'],
    terminal: '\n',
    env: { NO_COLOR: '1' },
  });
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(
    result.calls.filter((call) => call.startsWith('grok')),
    [],
  );
  assert.match(result.stdout, /Grok\s+not installed: waiting for your yes/);
});

test('install script reports each harness on its own and skips the missing ones', (t) => {
  const result = run(t, lists([], [], [], [], 'User packages:\n'));
  assert.equal(result.status, 0, result.stderr);
  // No terminal, so no colors and no questions.
  assert.doesNotMatch(result.stdout, /\x1b\[/);
  assert.match(
    result.stdout,
    /■ Claude Code\n {2}✓ added the ghulando marketplace from github\.com\/ghulando\/halvard\n {2}✓ installed halvard@ghulando for your user\n/,
  );
  assert.match(result.stdout, /■ Grok\n {2}- not on PATH, skipped\n/);
  assert.match(
    result.stdout,
    /Summary\n {2}Claude Code +installed\n {2}Codex +installed\n {2}Pi +installed\n {2}Grok +skipped, not on PATH\n {2}Cursor +skipped, not on PATH\n/,
  );
  // The harness CLIs' own output stays hidden while the steps succeed.
  assert.doesNotMatch(result.stdout, /\$ claude/);
});

test('install script shows the output of a failing step and stops there', (t) => {
  const result = run(t, {
    ...lists([], [], [], [], 'User packages:\n'),
    'codex-plugin-add-halvard@ghulando': 'error: plugin manifest is invalid\n',
    'codex-plugin-add-halvard@ghulando.fail': '',
  });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /✗ installed halvard@ghulando: failed \(codex plugin add halvard@ghulando\)\n {6}error: plugin manifest is invalid/,
  );
  assert.match(result.stderr, /Stopped\. Harnesses above this one are done/);
  assert.ok(!result.calls.some((call) => call.startsWith('pi ')));
});

test('install script prints each command and its output with --verbose', (t) => {
  const result = runScript(
    t,
    'install.sh',
    {
      ...lists([], [], [], [], 'User packages:\n'),
      'pi-install-git:github.com_ghulando_halvard': 'Cloning into halvard...\n',
    },
    { args: ['--verbose'] },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\$ claude plugin marketplace add ghulando\/halvard/);
  assert.match(
    result.stdout,
    /\$ pi install git:github\.com\/ghulando\/halvard\n {6}Cloning into halvard\.\.\./,
  );
  const bad = runScript(t, 'install.sh', empty, { args: ['--force'] });
  assert.equal(bad.status, 2);
  assert.deepEqual(bad.calls, []);
});
