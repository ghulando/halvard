import type { TestContext } from 'node:test';
import type { Fixtures } from './script-stubs.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { lists, runScript } from './script-stubs.ts';

// The earlier agent-workflow name, under the current and the older marketplace.
const old = 'agent-workflow@agent-workflow-local';
const oldGhulando = 'agent-workflow@ghulando';
const oldPi = 'git:github.com/ghulando/agent-workflow';
const plugin = 'halvard@ghulando';
const pi = 'git:github.com/ghulando/halvard';
const uid = process.getuid!();

const installed = lists(
  [{ name: 'ghulando' }, { name: 'agent-workflow-local' }, { name: 'other' }],
  [
    { id: plugin, scope: 'user' },
    { id: oldGhulando, scope: 'user' },
    { id: old, scope: 'user' },
    { id: old, scope: 'project', projectPath: '/work/app' },
    { id: 'kept@other', scope: 'user' },
  ],
  [{ name: 'ghulando' }, { name: 'agent-workflow-local' }],
  [{ pluginId: plugin }, { pluginId: oldGhulando }, { pluginId: old }],
  `User packages:\n  npm:other\n  ${pi}\n    /home/.pi/agent/git/github.com/ghulando/halvard\n  ${oldPi}\n`,
);

// A home holding the Halvard and earlier agent-workflow installs, unrelated settings, caches and workflow data.
function prepare(home: string, tmp: string) {
  const workspace = join(home, '.halvard');
  mkdirSync(join(home, '.claude'));
  writeFileSync(
    join(home, '.claude/settings.json'),
    JSON.stringify({
      model: 'opus',
      permissions: { additionalDirectories: [workspace, '/other'] },
      enabledPlugins: { [plugin]: true, [oldGhulando]: true, [old]: true, 'kept@other': true },
      extraKnownMarketplaces: { ghulando: {}, 'agent-workflow-local': {}, other: {} },
    }),
  );
  mkdirSync(join(home, '.codex'));
  writeFileSync(
    join(home, '.codex/config.toml'),
    [
      'model = "gpt"',
      '',
      '[hooks.state."other@market:hooks.json:pre_tool_use:0:0"]',
      'trusted_hash = "sha256:keep"',
      '',
      `[hooks.state."${old}:hooks/codex.json:pre_tool_use:0:0"]`,
      'trusted_hash = "sha256:old"',
      '',
      `[hooks.state."${plugin}:hooks/codex.json:session_start:0:0"]`,
      'trusted_hash = "sha256:new"',
      '',
      '[sandbox_workspace_write]',
      'writable_roots = [',
      `  '${workspace}', # task workspace`,
      '  "/other",',
      ']',
      '',
      '[marketplaces.agent-workflow-local]',
      'source_type = "git"',
      '  [profiles.dev]',
      '  model = "kept"',
      '',
      `[plugins.'${plugin}'] # added by codex`,
      'enabled = true',
      '',
      `[plugins."${old}"]`,
      'enabled = true',
      '',
      `[plugins."${oldGhulando}"]`,
      'enabled = true',
      '',
    ].join('\n'),
  );
  for (const path of [
    '.claude/plugins/cache/ghulando/halvard/0.0.1',
    '.claude/plugins/cache/ghulando/agent-workflow/0.0.1',
    '.claude/plugins/cache/agent-workflow-local/agent-workflow/0.0.1',
    '.claude/plugins/cache/other/kept/1.0.0',
    '.claude/plugins/data/halvard-ghulando',
    '.claude/plugins/data/agent-workflow-ghulando',
    '.codex/plugins/cache/agent-workflow-local/agent-workflow',
    '.codex/.tmp/marketplaces/agent-workflow-local',
    '.pi/agent/git/github.com/ghulando/halvard',
    '.pi/agent/git/github.com/ghulando/agent-workflow',
    '.config/halvard/package',
    '.config/agent-workflow/package',
    '.halvard/app/task',
  ]) {
    mkdirSync(join(home, path), { recursive: true });
  }
  writeFileSync(join(home, '.config/halvard/personal.json'), '{}\n');
  writeFileSync(join(home, '.config/agent-workflow/personal.json'), '{}\n');
  mkdirSync(join(tmp, `halvard-${uid}`));
  mkdirSync(join(tmp, `agent-workflow-${uid}`));
}

function run(t: TestContext, fixtures: Fixtures, args: string[] = []) {
  return runScript(t, 'uninstall.sh', fixtures, { args, prepare });
}

test('uninstall script removes Halvard and the earlier install and keeps unrelated settings', (t) => {
  const result = run(t, installed);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [
    `claude plugin uninstall ${plugin}`,
    `claude plugin uninstall ${oldGhulando}`,
    `claude plugin uninstall ${old}`,
    'claude plugin marketplace remove ghulando',
    'claude plugin marketplace remove agent-workflow-local',
    `codex plugin remove ${plugin}`,
    `codex plugin remove ${oldGhulando}`,
    `codex plugin remove ${old}`,
    'codex plugin marketplace remove ghulando',
    'codex plugin marketplace remove agent-workflow-local',
    `pi remove ${pi}`,
    `pi remove ${oldPi}`,
  ]);
  assert.match(
    result.stdout,
    /\/work\/app still enables agent-workflow@agent-workflow-local; there run: claude plugin uninstall agent-workflow@agent-workflow-local --scope project/,
  );

  const { home, tmp } = result;
  const workspace = join(home, '.halvard');
  const claude = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(claude, {
    model: 'opus',
    permissions: { additionalDirectories: [workspace, '/other'] },
    enabledPlugins: { 'kept@other': true },
    extraKnownMarketplaces: { other: {} },
  });
  assert.match(
    readFileSync(join(home, '.claude/settings.json.halvard.bak'), 'utf8'),
    /agent-workflow-local/,
  );
  const codex = readFileSync(join(home, '.codex/config.toml'), 'utf8');
  assert.match(codex, /other@market/);
  assert.match(codex, /^ {2}\[profiles\.dev\]\n {2}model = "kept"$/m);
  assert.ok(codex.includes(`'${workspace}', # task workspace`));
  assert.doesNotMatch(codex, /halvard@|agent-workflow@|marketplaces\.agent-workflow-local/);

  for (const path of [
    '.claude/plugins/cache/ghulando',
    '.claude/plugins/cache/agent-workflow-local',
    '.claude/plugins/data/halvard-ghulando',
    '.claude/plugins/data/agent-workflow-ghulando',
    '.codex/plugins/cache/agent-workflow-local',
    '.codex/.tmp/marketplaces/agent-workflow-local',
    '.pi/agent/git/github.com/ghulando/halvard',
    '.pi/agent/git/github.com/ghulando/agent-workflow',
    '.config/halvard/package',
    '.config/agent-workflow/package',
  ]) {
    assert.ok(!existsSync(join(home, path)), `${path} should be removed`);
  }
  assert.ok(!existsSync(join(tmp, `halvard-${uid}`)));
  assert.ok(!existsSync(join(tmp, `agent-workflow-${uid}`)));
  assert.ok(existsSync(join(home, '.config/agent-workflow/personal.json')));
  assert.ok(existsSync(join(home, '.claude/plugins/cache/other/kept/1.0.0')));
  assert.ok(existsSync(join(home, '.config/halvard/personal.json')));
  assert.ok(existsSync(join(home, '.halvard/app/task')));
});

test('uninstall script with --purge also removes personal data and workspace permissions', (t) => {
  const result = run(t, installed, ['--purge']);
  assert.equal(result.status, 0, result.stderr);
  const { home } = result;
  assert.ok(!existsSync(join(home, '.config/halvard')));
  assert.ok(!existsSync(join(home, '.halvard')));
  const claude = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(claude.permissions, { additionalDirectories: ['/other'] });
  const codex = readFileSync(join(home, '.codex/config.toml'), 'utf8');
  assert.match(codex, /^writable_roots = \[\n  \n  "\/other",\n\]$/m);
  assert.ok(!codex.includes(join(home, '.halvard')));
});

test('uninstall script backs up settings before a harness CLI edits them', (t) => {
  const result = run(t, {
    ...installed,
    [`claude-plugin-uninstall-${plugin}.sh`]: 'echo "{}" > "$HOME/.claude/settings.json"\n',
  });
  assert.equal(result.status, 0, result.stderr);
  const backup = readFileSync(join(result.home, '.claude/settings.json.halvard.bak'), 'utf8');
  assert.match(backup, /"model":"opus"/);
});

test('uninstall script stops before changes when a harness reports unexpected output', (t) => {
  const result = run(t, { ...installed, 'claude-plugin-list---json': 'not json' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.calls, []);
  assert.match(result.stderr, /Unexpected output from claude plugin list/);
  assert.ok(existsSync(join(result.home, '.claude/plugins/cache/ghulando/halvard')));
});

test('uninstall script rejects unknown or extra arguments', (t) => {
  for (const args of [['--force'], ['--purge', '--force'], ['--purge', '--purge']]) {
    const result = run(t, installed, args);
    assert.equal(result.status, 2, args.join(' '));
    assert.deepEqual(result.calls, []);
    assert.ok(!existsSync(join(result.home, '.claude/settings.json.halvard.bak')));
  }
});

test('uninstall script removes Halvard from Grok and Cursor and keeps the rest', (t) => {
  const ownHook = { command: 'audit.sh' };
  const result = runScript(
    t,
    'uninstall.sh',
    {
      ...installed,
      'grok-plugin-list---json': JSON.stringify([{ name: 'halvard' }, { name: 'other' }]),
    },
    {
      extra: ['grok'],
      prepare: (home, tmp) => {
        prepare(home, tmp);
        const root = join(home, '.config/halvard/cursor');
        mkdirSync(join(root, 'skills/halvard'), { recursive: true });
        mkdirSync(join(home, '.cursor/skills/mine'), { recursive: true });
        symlinkSync(join(root, 'skills/halvard'), join(home, '.cursor/skills/halvard'));
        writeFileSync(
          join(home, '.cursor/hooks.json'),
          JSON.stringify({
            version: 1,
            hooks: {
              preToolUse: [ownHook, { command: `f="${root}/bin/hook.ts"; node "$f" cursor` }],
              sessionStart: [{ command: `f="${root}/bin/hook.ts"; node "$f" cursor` }],
            },
          }),
        );
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const grok = result.calls.filter((call) => call.startsWith('grok'));
  assert.deepEqual(grok, [
    'grok plugin uninstall halvard --confirm',
    'grok plugin marketplace remove ghulando',
  ]);
  const { home } = result;
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.cursor/hooks.json'), 'utf8')), {
    version: 1,
    hooks: { preToolUse: [ownHook] },
  });
  assert.ok(existsSync(join(home, '.cursor/hooks.json.halvard.bak')));
  assert.ok(!existsSync(join(home, '.cursor/skills/halvard')));
  assert.ok(existsSync(join(home, '.cursor/skills/mine')));
  assert.ok(!existsSync(join(home, '.config/halvard/cursor')));
});

test('uninstall script treats a Grok marketplace that is already gone as removed', (t) => {
  const missing =
    'Error: Marketplace source "ghulando" not found. Configured sources: xAI Official\n';
  const result = runScript(
    t,
    'uninstall.sh',
    {
      ...installed,
      'grok-plugin-list---json': '[]',
      'grok-plugin-marketplace-remove-ghulando': missing,
      'grok-plugin-marketplace-remove-ghulando.fail': '',
      'grok-plugin-marketplace-remove-ghulando_halvard': missing,
      'grok-plugin-marketplace-remove-ghulando_halvard.fail': '',
    },
    { extra: ['grok'], prepare },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /■ Grok\n {2}- no Halvard install found\n/);
  assert.doesNotMatch(result.stdout + result.stderr, /Error:/);
});

test('uninstall script removes the Grok marketplace by repository when Grok wants that', (t) => {
  const result = runScript(
    t,
    'uninstall.sh',
    {
      ...installed,
      'grok-plugin-list---json': '[]',
      'grok-plugin-marketplace-remove-ghulando': 'Error: expected owner/repo\n',
      'grok-plugin-marketplace-remove-ghulando.fail': '',
    },
    { extra: ['grok'], prepare },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.calls.filter((call) => call.startsWith('grok')),
    ['grok plugin marketplace remove ghulando', 'grok plugin marketplace remove ghulando/halvard'],
  );
  assert.match(result.stdout, /■ Grok\n {2}✓ removed the ghulando marketplace\n/);
});

test('uninstall script reports one line per step and hides harness output', (t) => {
  const result = run(t, {
    ...installed,
    'pi-remove-git:github.com_ghulando_halvard': 'Removing...\n',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /■ Claude Code\n {2}✓ uninstalled halvard@ghulando\n/);
  assert.match(result.stdout, /■ Pi\n {2}✓ removed git:github\.com\/ghulando\/halvard\n/);
  assert.match(result.stdout, /■ Grok\n {2}- not on PATH, skipped\n/);
  assert.doesNotMatch(result.stdout, /Removing\.\.\./);
  const verbose = run(t, installed, ['--verbose', '--purge']);
  assert.equal(verbose.status, 0, verbose.stderr);
  assert.match(verbose.stdout, /\$ pi remove git:github\.com\/ghulando\/halvard/);
});
