import type { TestContext } from 'node:test';
import type { PackageMetadata } from '../core/types.ts';
import './environment.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { install, installPlan } from '../core/install/install.ts';
import { installPersonal, personalInstallPlan } from '../core/install/personal.ts';

function home(t: TestContext) {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'workflow-install-transaction-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

for (const personal of [false, true]) {
  test(`${personal ? 'personal' : 'project'} installation compares non-UTF-8 settings as exact bytes`, (t) => {
    const dir = home(t);
    const settings = join(dir, '.codex/config.toml');
    if (!personal) execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: dir });
    fs.mkdirSync(join(dir, '.codex'));
    const original = Buffer.from([0x23, 0x20, 0xff, 0x0a]);
    fs.writeFileSync(settings, original);
    const destination = join(dir, '.config/halvard');
    const plan = personal ? personalInstallPlan(dir, destination) : installPlan(dir);
    const write = plan.writes.find((write) => write.path.endsWith('.codex/config.toml'));
    assert.ok(Buffer.isBuffer(write!.before));
    assert.deepEqual(write!.before, original);
    assert.doesNotThrow(() => (personal ? installPersonal(dir, destination) : install(dir)));
    // Only the concurrency comparison is byte-exact; TOML output is decoded as UTF-8.
    assert.match(fs.readFileSync(settings, 'utf8'), /\uFFFD/);
    assert.match(fs.readFileSync(settings, 'utf8'), /enabled = true/);
  });
}

test('a later settings-swap failure restores the old package and all earlier settings', (t) => {
  const dir = home(t);
  const destination = join(dir, '.config/halvard');
  const target = join(destination, 'package');
  fs.mkdirSync(target, { recursive: true });
  const oldPackage = '{"name":"halvard","version":"0.0.0"}\n';
  fs.writeFileSync(join(target, 'package.json'), oldPackage);
  fs.mkdirSync(join(dir, '.pi/agent'), { recursive: true });
  fs.writeFileSync(join(dir, '.pi/agent/settings.json'), '{"custom":true}\n');
  const before = fs.readFileSync(join(dir, '.pi/agent/settings.json'));
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source: fs.PathLike, dest: fs.PathLike) => {
    if (String(dest).endsWith('/.claude/settings.json') && String(source).endsWith('/next')) {
      throw new Error('settings swap failed');
    }
    return rename(source, dest);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => installPersonal(dir, destination), /settings swap failed/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(fs.readFileSync(join(target, 'package.json'), 'utf8'), oldPackage);
  assert.deepEqual(fs.readFileSync(join(dir, '.pi/agent/settings.json')), before);
  assert.equal(fs.existsSync(join(dir, '.claude/settings.json')), false);
  assert.deepEqual(fs.readdirSync(destination), ['package']);
  assert.ok(personalInstallPlan(dir, destination).copy);
});

test('a vendored copy failure leaves no partial package and the same install can be retried', (t) => {
  const dir = home(t);
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: dir });
  const copy = fs.cpSync;
  let count = 0;
  t.mock.method(fs, 'cpSync', (...args: Parameters<typeof fs.cpSync>) => {
    if (++count === 2) throw new Error('copy failed');
    return copy(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => install(dir), /copy failed/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(fs.existsSync(join(dir, 'plugins/halvard')), false);
  assert.ok(installPlan(dir).copy);
  install(dir);
  assert.equal(installPlan(dir).drift!.matches, true);
});

test('same-version repair is explicit for both installation types and refreshes native registration', (t) => {
  const dir = home(t);
  const destination = join(dir, '.config/halvard');
  installPersonal(dir, destination);
  const target = join(destination, 'package');
  fs.writeFileSync(join(target, 'README.md'), 'local change');
  const plan = personalInstallPlan(dir, destination, { repair: true });
  assert.equal(plan.repair, true);
  assert.ok(plan.commands.some((args) => args[0] === 'codex' && args[2] === 'remove'));
  assert.throws(() => installPersonal(dir, destination), /--repair/);
  installPersonal(dir, destination, { repair: true });
  assert.equal(personalInstallPlan(dir, destination).drift!.matches, true);
  assert.equal(personalInstallPlan(dir, destination, { repair: true }).copy, null);
  const repo = join(dir, 'app');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: repo });
  install(repo);
  fs.writeFileSync(join(repo, 'plugins/halvard/README.md'), 'local change');
  assert.throws(() => install(repo), /content differs/);
  assert.equal(installPlan(repo, { repair: true }).replace, true);
  install(repo, { repair: true });
  assert.equal(installPlan(repo).drift!.matches, true);
});

test('repair refuses a different version in both installation types', (t) => {
  const dir = home(t);
  const destination = join(dir, '.config/halvard');
  installPersonal(dir, destination);
  const metadata = join(destination, 'package/package.json');
  const pkg = JSON.parse(fs.readFileSync(metadata).toString('utf8')) as PackageMetadata;
  pkg.version = '9.9.9';
  fs.writeFileSync(metadata, JSON.stringify(pkg));
  assert.throws(() => personalInstallPlan(dir, destination, { repair: true }), /same version/);
  const repo = join(dir, 'app');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  install(repo);
  fs.writeFileSync(join(repo, 'plugins/halvard/package.json'), JSON.stringify(pkg));
  assert.throws(() => installPlan(repo, { repair: true }), /same version/);
});

test('settings edited during package staging are preserved and installation aborts', (t) => {
  const dir = home(t);
  const destination = join(dir, '.config/halvard');
  const settings = join(dir, '.claude/settings.json');
  fs.mkdirSync(join(dir, '.claude'));
  fs.writeFileSync(settings, '{}');
  const copy = fs.cpSync;
  let changed = false;
  t.mock.method(fs, 'cpSync', (...args: Parameters<typeof fs.cpSync>) => {
    if (!changed) {
      changed = true;
      fs.writeFileSync(settings, '{"concurrent":true}');
    }
    return copy(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => installPersonal(dir, destination), /settings changed/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(fs.readFileSync(settings, 'utf8'), '{"concurrent":true}');
  assert.equal(fs.existsSync(join(destination, 'package')), false);
});

test('post-commit cleanup failure warns and keeps the successful installation', (t) => {
  const dir = home(t);
  const destination = join(dir, '.config/halvard');
  const remove = fs.rmSync;
  t.mock.method(fs, 'rmSync', (path: fs.PathLike, ...args: [fs.RmOptions?]) => {
    if (String(path).includes('.settings.json.workflow-')) throw new Error('cleanup fixture');
    return remove(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.doesNotThrow(() => installPersonal(dir, destination));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(personalInstallPlan(dir, destination).drift!.matches, true);
});
