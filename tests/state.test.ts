import './environment.ts';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pluginRoot } from '../core/shared/plugin.ts';
import { sessionKey, fingerprint, stateDirectory, withState } from '../core/state.ts';
import { fixture } from './hook-fixture.ts';

test('worktree fingerprint includes untracked files, executable mode, index and branch', (t) => {
  const root = fixture(t);
  const initial = fingerprint(root);
  chmodSync(join(root, 'source.txt'), 0o755);
  assert.notEqual(fingerprint(root), initial);
  const beforeIndex = fingerprint(root);
  execFileSync('git', ['add', 'source.txt'], { cwd: root });
  assert.notEqual(fingerprint(root), beforeIndex);
  const beforeBranch = fingerprint(root);
  execFileSync('git', ['checkout', '-q', '-b', 'feature/other'], { cwd: root });
  assert.notEqual(fingerprint(root), beforeBranch);
});

test('concurrent state updates are serialized, and hostile session IDs do not collide', async (t) => {
  const root = fixture(t);
  const key = sessionKey(root, 'pi', 'a/b');
  assert.notEqual(key, sessionKey(root, 'pi', 'ab'));
  await Promise.all(
    Array.from({ length: 20 }, () =>
      withState(root, key, (state) => {
        state.revision++;
      }),
    ),
  );
  assert.equal(await withState(root, key, (state) => state.revision), 20);
});

test('a state lock left by a dead process is reclaimed and a live owner still blocks', async (t) => {
  const root = fixture(t);
  const key = sessionKey(root, 'claude', 'lock-test');
  const lock = join(stateDirectory(root), `${key}.lock`);
  const dead = String(spawnSync(process.execPath, ['-e', '']).pid);
  writeFileSync(lock, dead);
  assert.equal(await withState(root, key, (state) => state.revision), 0);
  writeFileSync(lock, String(process.pid));
  await assert.rejects(
    withState(root, key, () => {}),
    /busy/,
  );
  rmSync(lock);
  // Racing processes reclaim the stale lock once and never overlap: no update is lost.
  writeFileSync(lock, dead);
  const script = `import { withState } from ${JSON.stringify(resolve(pluginRoot, 'core/state.ts'))};
for (let i = 0; i < 10; i++) await withState(${JSON.stringify(root)}, '${key}', async state => { const seen = state.revision; await new Promise(r => setTimeout(r, 1)); state.revision = seen + 1; });`;
  const runs = Array.from(
    { length: 5 },
    () =>
      new Promise<void>((done, fail) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let errors = '';
        child.stderr.on('data', (data) => {
          errors += data;
        });
        child.on('close', (code) => (code === 0 ? done() : fail(new Error(errors))));
      }),
  );
  await Promise.all(runs);
  assert.equal(await withState(root, key, (state) => state.revision), 50);
});

test('a fingerprint past its deadline fails instead of returning a partial hash', (t) => {
  const root = fixture(t);
  assert.throws(() => fingerprint(root, undefined, Date.now() - 1), /too large to verify/);
  assert.equal(fingerprint(root, undefined, Date.now() + 60000), fingerprint(root));
});
