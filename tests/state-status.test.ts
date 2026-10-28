import type { TestContext } from 'node:test';
import type { Action } from '../core/types.ts';
import './environment.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fingerprint, sessionKey } from '../core/state.ts';
import { handle } from '../core/runtime.ts';
import { runGate } from '../core/workflow/gate.ts';
import { claimsDone } from '../core/workflow/status.ts';

function repo(t: TestContext, config = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-state-status-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '--initial-branch=feature/test'], { cwd: root });
  writeFileSync(
    join(root, '.halvard.json'),
    JSON.stringify({ version: 1, gate: [process.execPath, '-e', 'process.exit(0)'], ...config }),
  );
  return root;
}

const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root });

test('custom completion text in progress notes is not a completion claim', () => {
  const config = { doneMarker: 'complete.', taskFiles: ['docs/tasks/**'] };
  const action = (after: string): Action => ({
    kind: 'files',
    files: [{ path: 'docs/tasks/task.md', before: '**Status:** open.\n', after }],
  });
  assert.equal(claimsDone(action('**Status:** open.\nSlice 1 complete.\n'), config), false);
  assert.equal(claimsDone(action('**Status:** complete.\n'), config), true);
  assert.equal(claimsDone(action('Note: **Status:** complete.\n'), config), true);
});

for (const shape of ['file', 'directory']) {
  test(`broken untracked nested Git ${shape} remains fingerprintable`, async (t) => {
    const root = repo(t);
    const child = join(root, 'nested');
    mkdirSync(child);
    writeFileSync(join(child, 'source'), 'fixture');
    // Break metadata after Git enumerates nested/, before fingerprint recurses.
    const snapshot = (brokenShape: string) => {
      rmSync(join(child, '.git'), { recursive: true, force: true });
      git(child, 'init', '-q');
      const stat = fs.lstatSync;
      let broken = false;
      t.mock.method(fs, 'lstatSync', (path: fs.PathLike, ...args: [fs.StatOptions?]) => {
        if (path === child && !broken) {
          broken = true;
          rmSync(join(child, '.git'), { recursive: true });
          if (brokenShape === 'file') {
            writeFileSync(join(child, '.git'), 'gitdir: /missing/worktree-metadata\n');
          } else {
            mkdirSync(join(child, '.git'));
          }
        }
        return stat(path, ...args);
      });
      syncBuiltinESMExports();
      try {
        return fingerprint(root);
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    };
    const before = snapshot(shape);
    assert.equal(snapshot(shape === 'file' ? 'directory' : 'file'), before);
    const stable = fingerprint(root);
    assert.equal(fingerprint(root), stable);
    await runGate(root, sessionKey(root, 'codex', `broken-${shape}`));
    rmSync(join(child, '.git'), { recursive: true });
    git(child, 'init', '-q');
    assert.notEqual(fingerprint(root), before);
    assert.notEqual(fingerprint(root), stable);
  });
}

test('changing a dangling symlink target invalidates the tree fingerprint', (t) => {
  const root = repo(t);
  const path = join(root, 'broken');
  symlinkSync('missing-one', path);
  git(root, 'add', 'broken');
  const before = fingerprint(root);
  unlinkSync(path);
  symlinkSync('missing-two', path);
  assert.notEqual(fingerprint(root), before);
});

test('unreadable content in a valid nested repository still fails fingerprinting', (t) => {
  const root = repo(t);
  const child = join(root, 'nested');
  const source = join(child, 'source');
  mkdirSync(child);
  git(child, 'init', '-q');
  writeFileSync(source, 'fixture');
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (path: fs.PathLike, ...args: [fs.OpenMode, fs.Mode?]) => {
    if (path === source) {
      throw Object.assign(new Error('nested source unreadable'), { code: 'EACCES' });
    }
    return open(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => fingerprint(root), /nested source unreadable/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('nested Git checkout content and branch changes invalidate the parent fingerprint', (t) => {
  const root = repo(t);
  const child = join(root, 'dependency');
  mkdirSync(child);
  git(child, 'init', '-q', '--initial-branch=main');
  writeFileSync(join(child, 'source.txt'), 'first');
  git(
    root,
    'update-index',
    '--add',
    '--cacheinfo',
    '160000,1111111111111111111111111111111111111111,dependency',
  );
  const before = fingerprint(root);
  writeFileSync(join(child, 'source.txt'), 'second');
  assert.notEqual(fingerprint(root), before);
  const changed = fingerprint(root);
  git(child, 'symbolic-ref', 'HEAD', 'refs/heads/other');
  assert.notEqual(fingerprint(root), changed);
});

for (const harness of ['pi', 'claude', 'codex']) {
  test(`${harness}: custom completion text accepts a managed status-only edit`, async (t) => {
    const root = repo(t, { doneMarker: 'complete.', workflow: { requireReview: true } });
    mkdirSync(join(root, 'docs/tasks'), { recursive: true });
    writeFileSync(join(root, 'docs/tasks/task.md'), '**Status:** open.\n');
    await runGate(root, sessionKey(root, harness, 'status-test'));
    // The absent metadata must fail at review identity, after accepting the status-only edit.
    await assert.rejects(
      handle(harness, {
        cwd: root,
        session_id: 'status-test',
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: 'docs/tasks/task.md',
          old_string: '**Status:** open.',
          new_string: '**Status:** complete.',
        },
      }),
      /task has no workflow metadata/,
    );
  });
}

for (const beforeStatus of ['incomplete.', 'not complete.', 'open.']) {
  test(`completion from ${beforeStatus} requires fresh verification`, async (t) => {
    const root = repo(t, { doneMarker: 'complete.' });
    mkdirSync(join(root, 'docs/tasks'), { recursive: true });
    writeFileSync(join(root, 'docs/tasks/task.md'), `**Status:** ${beforeStatus}\n`);
    const result = await handle('codex', {
      cwd: root,
      session_id: 'substring',
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: {
        file_path: 'docs/tasks/task.md',
        old_string: `**Status:** ${beforeStatus}`,
        new_string: '**Status:** complete.',
      },
    });
    assert.equal(result.decision, 'deny');
    assert.match(result.reason!, /gate/i);
  });
}

test('uninitialized gitlinks remain fingerprintable and initialization invalidates them', (t) => {
  const root = repo(t);
  const child = join(root, 'dependency');
  mkdirSync(child);
  git(
    root,
    'update-index',
    '--add',
    '--cacheinfo',
    '160000,1111111111111111111111111111111111111111,dependency',
  );
  const before = fingerprint(root);
  git(child, 'init', '-q');
  assert.notEqual(fingerprint(root), before);
});

for (const worktree of [false, true]) {
  test(`untracked nested repository (${worktree ? 'git file' : 'git directory'}) invalidates fingerprint`, (t) => {
    const root = repo(t);
    const child = join(root, 'nested');
    if (worktree) {
      git(root, 'add', '.');
      git(
        root,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'fixture',
      );
      git(root, 'worktree', 'add', '-q', '-b', 'nested', child);
    } else {
      mkdirSync(child);
      git(child, 'init', '-q');
    }
    writeFileSync(join(child, 'source'), 'first');
    const before = fingerprint(root);
    writeFileSync(join(child, 'source'), 'second');
    assert.notEqual(fingerprint(root), before);
  });
}

for (const harness of ['pi', 'claude', 'codex']) {
  test(`${harness}: dollar completion markers render literally`, async (t) => {
    const root = repo(t, { doneMarker: '$& complete.', workflow: { requireReview: true } });
    mkdirSync(join(root, 'docs/tasks'), { recursive: true });
    writeFileSync(join(root, 'docs/tasks/task.md'), '**Status:** open.\n');
    await runGate(root, sessionKey(root, harness, 'dollar'));
    await assert.rejects(
      handle(harness, {
        cwd: root,
        session_id: 'dollar',
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: 'docs/tasks/task.md',
          old_string: '**Status:** open.',
          new_string: '**Status:** $& complete.',
        },
      }),
      /task has no workflow metadata/,
    );
  });
}

test('bare custom completion text does not claim managed completion', async (t) => {
  const root = repo(t, { doneMarker: 'complete.' });
  mkdirSync(join(root, 'docs/tasks'), { recursive: true });
  writeFileSync(join(root, 'docs/tasks/task.md'), '**Status:** open.\n');
  const result = await handle('codex', {
    cwd: root,
    session_id: 'prefix',
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: {
      file_path: 'docs/tasks/task.md',
      old_string: '**Status:** open.',
      new_string: 'complete.',
    },
  });
  assert.equal(result.decision, undefined);
});
