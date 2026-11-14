import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
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
import { join, resolve } from 'node:path';
import test from 'node:test';

const script = resolve(import.meta.dirname, '../scripts/install-herdr.sh');
const source = resolve(import.meta.dirname, '../herdr-app');
// The npm package ships the tests but not herdr-app/ or this installer.
const skip = existsSync(script) ? false : 'herdr-app/ and its installer are not packaged';

// A Herdr App home and a herdr-app stand-in that logs its arguments; home: false leaves
// the home folder out, and homeValue turns the home's path into HERDR_APP_HOME, run from dir.
function setup(
  t: TestContext,
  { home = true, herdr = true, homeValue = (app: string) => app } = {},
) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'install-herdr-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = join(dir, 'herdr-app-home');
  if (home) mkdirSync(app);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  if (herdr) {
    writeFileSync(join(bin, 'herdr-app'), `#!/bin/sh\necho "herdr-app $*" >> '${log}'\n`);
    chmodSync(join(bin, 'herdr-app'), 0o755);
  }
  const run = (...args: string[]) => {
    const result = spawnSync('sh', [script, ...args], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 10000,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, HERDR_APP_HOME: homeValue(app) },
    });
    return { ...result, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
  };
  return { dir, app, run };
}

const installed = [
  'layouts/halvard.json',
  'layouts/halvard.svg',
  'themes/halvard.json',
  'mods/halvard-watch/main.js',
  'mods/halvard-watch/log.js',
  'mods/halvard-watch/task.js',
  'mods/halvard-watch/summon.js',
  'mods/halvard-watch/mod.json',
  'mods/halvard-session/main.js',
  'mods/halvard-session/mod.json',
];

test('install-herdr copies the layout, theme and mods and checks each mod', { skip }, (t) => {
  const { app, run } = setup(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  for (const file of installed) {
    assert.equal(readFileSync(join(app, file), 'utf8'), readFileSync(join(source, file), 'utf8'));
  }
  assert.equal(existsSync(join(app, 'RECIPE.md')), false);
  assert.equal(existsSync(join(app, 'preview.png')), false);
  assert.deepEqual(result.calls, [
    `herdr-app check ${app}/mods/halvard-watch`,
    `herdr-app check ${app}/mods/halvard-session`,
  ]);
  assert.match(result.stdout, /Copied 10 of 10 files/);
  assert.match(result.stdout, /layout\.switch --name halvard/);
});

test('install-herdr run again copies nothing that is already the same', { skip }, (t) => {
  const { run } = setup(t);
  assert.equal(run().status, 0);
  const again = run();
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /Copied 0 of 10 files/);
});

test(
  'install-herdr stops before copying when a file there differs, and --force replaces it',
  { skip },
  (t) => {
    const { app, run } = setup(t);
    mkdirSync(join(app, 'themes'));
    writeFileSync(join(app, 'themes/halvard.json'), '{"someone":"else"}\n');
    const refused = run();
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /themes\/halvard\.json/);
    assert.match(refused.stderr, /--force/);
    assert.equal(existsSync(join(app, 'layouts/halvard.json')), false);
    assert.deepEqual(refused.calls, []);
    const forced = run('--force');
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(
      readFileSync(join(app, 'themes/halvard.json'), 'utf8'),
      readFileSync(join(source, 'themes/halvard.json'), 'utf8'),
    );
  },
);

test(
  'install-herdr refuses a directory or link where a file goes, even with --force',
  { skip },
  (t) => {
    const { app, run } = setup(t);
    mkdirSync(join(app, 'layouts/halvard.json'), { recursive: true });
    const directory = run('--force');
    assert.equal(directory.status, 1);
    assert.match(directory.stderr, /Something other than a file is in the way/);
    assert.match(directory.stderr, /layouts\/halvard\.json/);
    assert.equal(existsSync(join(app, 'themes/halvard.json')), false);
    assert.equal(existsSync(join(app, 'layouts/halvard.json/halvard.json')), false);
    assert.deepEqual(directory.calls, []);

    const other = setup(t);
    mkdirSync(join(other.app, 'themes'));
    writeFileSync(join(other.app, 'elsewhere.json'), 'theirs\n');
    symlinkSync(join(other.app, 'elsewhere.json'), join(other.app, 'themes/halvard.json'));
    const link = other.run('--force');
    assert.equal(link.status, 1);
    assert.equal(readFileSync(join(other.app, 'elsewhere.json'), 'utf8'), 'theirs\n');

    const parent = setup(t);
    writeFileSync(join(parent.app, 'mods'), 'a file named mods\n');
    const folder = parent.run();
    assert.equal(folder.status, 1);
    assert.match(folder.stderr, /mods\/halvard-watch/);
    assert.equal(existsSync(join(parent.app, 'layouts')), false);
  },
);

test('install-herdr refuses a linked folder, live or dangling, before copying', { skip }, (t) => {
  for (const dangling of [false, true]) {
    const { dir, app, run } = setup(t);
    const outside = join(dir, 'outside');
    if (!dangling) mkdirSync(outside);
    symlinkSync(outside, join(app, 'layouts'));
    const result = run('--force');
    assert.equal(result.status, 1, `dangling ${dangling}`);
    assert.match(result.stderr, /layouts\/halvard\.json/);
    assert.equal(existsSync(join(outside, 'halvard.json')), false);
    assert.equal(existsSync(join(app, 'themes')), false);
  }
});

test('install-herdr takes a home with a trailing slash or a relative path', { skip }, (t) => {
  for (const homeValue of [
    (app: string) => `${app}/`,
    () => 'herdr-app-home/',
    () => './herdr-app-home',
  ]) {
    const { app, run } = setup(t, { homeValue });
    const result = run();
    assert.equal(result.status, 0, `${homeValue(app)}: ${result.stderr}`);
    assert.equal(existsSync(join(app, 'layouts/halvard.json')), true);
    assert.match(result.stdout, /Copied 10 of 10 files/);
  }
});

test('install-herdr needs the Herdr App home and accepts only --force', { skip }, (t) => {
  const missing = setup(t, { home: false }).run();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No Herdr App home/);
  const usage = setup(t).run('--switch');
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage: install-herdr\.sh \[--force\]/);
});

test(
  'install-herdr installs without herdr-app on PATH and says the mods were not checked',
  { skip },
  (t) => {
    const result = setup(t, { herdr: false }).run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /herdr-app is not on PATH; the mods were not checked/);
  },
);
