import type { HarnessSettings, PackageMetadata } from '../core/install/types.ts';
import './environment.ts';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installPersonal, personalInstallPlan } from '../core/install/personal.ts';

test('personal install preview preserves unrelated plugins and permissions without writing files', (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-user-install-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.claude'));
  writeFileSync(
    join(home, '.claude/settings.json'),
    JSON.stringify({
      enabledPlugins: { 'example-plugin@example-marketplace': true },
      permissions: { deny: ['Read(.env)'] },
    }),
  );
  const plan = personalInstallPlan(home, join(home, '.config/halvard'));
  const settings = JSON.parse(
    plan.writes.find((w) => w.path.endsWith('.claude/settings.json'))!.content,
  ) as HarnessSettings & { permissions?: unknown };
  assert.equal(settings.enabledPlugins!['example-plugin@example-marketplace'], true);
  assert.deepEqual(settings.permissions, { deny: ['Read(.env)'] });
  assert.equal(settings.enabledPlugins!['halvard@ghulando'], true);
  assert.equal(existsSync(join(home, '.pi')), false);
  assert.equal(existsSync(plan.copy!.destination), false);
});

test('personal install commands register Claude for fresh and existing installations', (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-claude-install-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const destination = join(home, '.config/halvard');
  const source = join(destination, 'package');
  const expected = [
    ['claude', 'plugin', 'marketplace', 'add', source],
    ['claude', 'plugin', 'install', 'halvard@ghulando'],
  ];
  assert.deepEqual(
    personalInstallPlan(home, destination).commands.filter((command) => command[0] === 'claude'),
    expected,
  );
  installPersonal(home, destination);
  assert.deepEqual(
    personalInstallPlan(home, destination).commands.filter((command) => command[0] === 'claude'),
    expected,
  );
});

test('personal upgrades stage a replacement and preserve preferences; same versions skip copying', (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-upgrade-')));
  const destination = join(home, '.config/halvard');
  const target = join(destination, 'package');
  const previous = process.env.HALVARD_HOME;
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  process.env.HALVARD_HOME = destination;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.HALVARD_HOME;
    } else {
      process.env.HALVARD_HOME = previous;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
  });
  mkdirSync(target, { recursive: true });
  writeFileSync(
    join(target, 'package.json'),
    JSON.stringify({ name: 'halvard', version: '0.2.2' }),
  );
  writeFileSync(join(target, 'obsolete.txt'), 'old package');
  const personal = '{"reviewTimeout":120,"readCommands":[["inspect"]]}\n';
  writeFileSync(join(destination, 'personal.json'), personal);
  const plan = personalInstallPlan(home, destination);
  assert.deepEqual(plan.upgrade, { from: '0.2.2', to: '0.0.1' });
  assert.equal(readFileSync(join(target, 'obsolete.txt'), 'utf8'), 'old package');
  assert.ok(plan.copy);
  assert.deepEqual(plan.commands, [
    ['claude', 'plugin', 'marketplace', 'add', target],
    ['claude', 'plugin', 'install', 'halvard@ghulando'],
    ['codex', 'plugin', 'marketplace', 'add', destination],
    ['codex', 'plugin', 'remove', 'halvard@ghulando'],
    ['codex', 'plugin', 'add', 'halvard@ghulando'],
  ]);
  installPersonal();
  assert.equal(
    (JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')) as PackageMetadata).version,
    '0.0.1',
  );
  for (const manifest of [
    '.claude-plugin/plugin.json',
    '.codex-plugin/plugin.json',
    '.grok-plugin/plugin.json',
  ]) {
    assert.equal(
      (JSON.parse(readFileSync(join(target, manifest), 'utf8')) as PackageMetadata).version,
      '0.0.1',
    );
  }
  assert.equal(existsSync(join(target, 'core/guard/shell.ts')), true);
  assert.equal(existsSync(join(target, 'obsolete.txt')), false);
  assert.equal(readFileSync(join(destination, 'personal.json'), 'utf8'), personal);
  assert.equal(personalInstallPlan(home, destination).copy, null);
  writeFileSync(join(target, 'README.md'), 'same-version sentinel');
  t.mock.method(fs, 'cpSync', () => {
    throw new Error('must not copy');
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => installPersonal(home, destination), /--repair/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(join(target, 'README.md'), 'utf8'), 'same-version sentinel');
  assert.equal(personalInstallPlan(home, destination).drift!.matches, false);
  assert.ok(personalInstallPlan(home, destination, { repair: true }).copy);
  installPersonal(home, destination, { repair: true });
  assert.equal(personalInstallPlan(home, destination).drift!.matches, true);
  writeFileSync(
    join(target, 'package.json'),
    JSON.stringify({ name: 'another-package', version: '0.2.2' }),
  );
  assert.throws(() => personalInstallPlan(home, destination), /another package|package name/);
});

test('a failed staged personal upgrade leaves the installed package and settings intact', (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-upgrade-failure-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const destination = join(home, '.config/halvard');
  const target = join(destination, 'package');
  mkdirSync(target, { recursive: true });
  const old = '{"name":"halvard","version":"0.2.2"}\n';
  writeFileSync(join(target, 'package.json'), old);
  writeFileSync(join(target, 'working.txt'), 'still working');
  writeFileSync(join(destination, 'personal.json'), '{}\n');
  const copy = fs.cpSync;
  let copies = 0;
  t.mock.method(fs, 'cpSync', (...args: Parameters<typeof fs.cpSync>) => {
    if (++copies === 2) throw new Error('copy failed');
    return copy(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => installPersonal(home, destination), /copy failed/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(copies, 2);
  assert.equal(readFileSync(join(target, 'package.json'), 'utf8'), old);
  assert.equal(readFileSync(join(target, 'working.txt'), 'utf8'), 'still working');
  assert.equal(readFileSync(join(destination, 'personal.json'), 'utf8'), '{}\n');
  assert.equal(existsSync(join(home, '.claude/settings.json')), false);
  assert.deepEqual(fs.readdirSync(destination).sort(), ['package', 'personal.json']);
});

test('a failed personal package swap restores the previous directory', (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-upgrade-swap-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const destination = join(home, '.config/halvard');
  const target = join(destination, 'package');
  mkdirSync(target, { recursive: true });
  const old = '{"name":"halvard","version":"0.2.2"}\n';
  writeFileSync(join(target, 'package.json'), old);
  const rename = fs.renameSync;
  let renames = 0;
  t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
    if (++renames === 2) throw new Error('swap failed');
    return rename(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => installPersonal(home, destination), /swap failed/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(renames, 3);
  assert.equal(readFileSync(join(target, 'package.json'), 'utf8'), old);
  assert.deepEqual(fs.readdirSync(destination), ['package']);
});

test('personal installation recognizes an equivalent single-quoted Codex plugin table', (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-user-toml-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.codex'));
  const toml = "[plugins.'halvard@ghulando']\nenabled = true\n";
  writeFileSync(join(home, '.codex/config.toml'), toml);
  const plan = personalInstallPlan(home, join(home, '.config/halvard'));
  assert.equal(
    plan.writes.some((write) => write.path.endsWith('.codex/config.toml')),
    false,
  );
  writeFileSync(join(home, '.codex/config.toml'), toml.replace('true', 'false'));
  assert.throws(() => personalInstallPlan(home, join(home, '.config/halvard')), /disabled/);
});

test('personal install names the workspace settings and the session restart without changing permissions', (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-user-workspace-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const plan = personalInstallPlan(home, join(home, '.config/halvard'));
  assert.equal(plan.workspace.path, process.env.HALVARD_WORKSPACE);
  assert.match(plan.workspace.claude, /permissions\.additionalDirectories/);
  assert.match(plan.workspace.codex, /\[sandbox_workspace_write\]/);
  assert.match(plan.instruction, /restart every open Claude Code and Codex session/);
  const settings = JSON.parse(
    plan.writes.find((w) => w.path.endsWith('.claude/settings.json'))!.content,
  ) as HarnessSettings;
  assert.equal(settings.permissions, undefined);
});
