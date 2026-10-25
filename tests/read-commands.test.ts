import './environment.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { shellKind } from '../core/guard/shell.ts';
import { handle, runGate } from '../core/runtime.ts';
import { sessionKey, withState } from '../core/state.ts';

const reads = [
  'ps -axo pid,ppid,etime,command',
  'cat README.md && echo "---EXAMPLES---" && ls -la examples/ && cat examples/*.json 2>/dev/null',
  'du -sh src',
  'df -h',
  'command -v node',
  'uniq -c source.txt',
  'uniq -- source.txt',
  'git --no-pager diff --stat',
  "jq --arg name workflow '.[$name]' config.json",
  "jq --argjson count 3 '.count == $count' config.json",
  "sed -n '$p' source.txt",
  'rg -n TODO src/*.mjs',
  'rg -n TODO -- *.mjs',
  'find src/*.mjs -type f',
  'git diff -- src/*.mjs',
  'sort -- src/*.txt',
  'ls src/*.mjs | head -20',
];

const denied = [
  'uniq src/*.txt',
  'printf src/*.txt',
  'for d in skills/*/; do echo "$d"; done',
  'inspect read src/*',
  'uniq input output',
  'uniq -c input output',
  'sort -o output src/*.txt',
  'rg --pre sh src/*.txt',
  'find src/*.mjs -delete',
  'find src/*.mjs -exec sh {} +',
  'git -C src reset --hard',
  'git -c diff.external=sh diff',
  'git -C src diff --output=file',
  'git --no-pager diff --ext-diff',
  'command node script.mjs',
  'rg TODO *.mjs',
  'sort *.txt',
  'git diff *.txt',
  'jq --arg name value --run-tests file',
  "jq --arg name '.name'",
  "sed -n '$p' -i source.txt",
  'ps -axo pid > output',
  'cat "$FILE"',
];

test('common read commands are accepted while option/glob/execute lookalikes stay guarded', () => {
  for (const command of reads) assert.equal(shellKind(command, []), 'read', command);
  for (const command of denied) {
    assert.notEqual(
      shellKind(command, [
        { prefix: ['inspect', 'read'], options: {}, positionals: { min: 1, max: 1 } },
      ]),
      'read',
      command,
    );
  }
});

test('branch classification requires a branch operation', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-branch-containment-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nested = join(root, 'vendor');
  execFileSync('git', ['init', '-q', nested]);
  for (const command of ['git status', 'git log']) {
    assert.equal(shellKind(command, [], root, nested), 'mutation', command);
  }
  for (const command of [
    'git switch feature/y',
    'git checkout -b fix/x',
    'git switch -c fix/x && git status',
  ]) {
    assert.equal(shellKind(command, [], root, nested), 'branch', command);
  }
  assert.equal(shellKind('cd vendor && git status', [], root, root), 'mutation');
  for (const command of [
    'git switch -c fix/x',
    'git checkout feature/y',
    'git status && git switch -c fix/x && git log',
  ]) {
    assert.equal(shellKind(command, [], root, root), 'branch', command);
  }
  for (const command of ['git status', 'git log', 'cd vendor && ls']) {
    assert.equal(shellKind(command, [], root, root), 'read', command);
  }
  assert.equal(shellKind('git switch -c fix/x && touch source.txt', [], root, root), 'mutation');
});

test('only work on the project tree counts against a protected branch', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-scope-root-')));
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-scope-other-')));
  const home = process.env.HOME;
  t.after(() => {
    process.env.HOME = home;
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });
  process.env.HOME = other;
  const inspect = [{ prefix: ['inspect', 'read'], options: {}, positionals: { min: 1, max: 1 } }];
  for (const command of [
    `cd ${other} && cat skills/halvard/SKILL.md`,
    `cd ${other} && ls && cd ${root} && git status`,
    'cd ~ && cat MEMORY.md',
    `cd ${other} && cat skills/*/SKILL.md`,
  ]) {
    assert.equal(shellKind(command, inspect, root, root), 'read', command);
  }
  for (const command of [
    `echo note >> ${other}/MEMORY.md`,
    "echo '- [Note](note.md) - hook' >> ~/MEMORY.md",
  ]) {
    assert.equal(shellKind(command, inspect, root, root), 'outside', command);
  }
  for (const command of [
    `cd ${root} && git switch -c fix/x`,
    `cd ${root} && git status && git checkout -b feature/y`,
  ]) {
    assert.equal(shellKind(command, inspect, root, root), 'branch', command);
  }
  // Git and configured commands load configuration from the directory they run in.
  for (const command of [
    `cd ${other} && git status`,
    `cd ${other} && inspect read x`,
    `cd ${other} && git switch -c fix/x`,
    `cd ${root} && cd ${other} && git status && cd ${root} && git switch -c fix/x`,
    'echo note >> notes.md',
    `echo note > ${root}/notes.md`,
    `cd ${other} && echo note > ${root}/notes.md`,
    `uv run pytest -q > ${other}/log`,
    `git switch -c fix/x > ${other}/log`,
    `cd ${other} && touch notes.md`,
    // A relative target depends on a directory guess, so it never counts as outside.
    `cd ${other} && printf x > notes.md`,
  ]) {
    assert.equal(shellKind(command, inspect, root, root), 'mutation', command);
  }
  for (const command of [
    `echo note >| ${other}/MEMORY.md`,
    `echo note > "$HOME/MEMORY.md"`,
    `echo note > ${other}/*.md`,
  ]) {
    assert.equal(shellKind(command, inspect, root, root), 'opaque', command);
  }
  assert.equal(shellKind(`echo note >> ${other}/MEMORY.md`, []), 'mutation');
});

test('a write counts as outside only where the shell surely runs it outside the project', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-scope-root-')));
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-scope-other-')));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });
  writeFileSync(join(other, 'plain.txt'), 'x\n');
  mkdirSync(join(root, '~'));
  symlinkSync(root, join(other, 'into'));
  symlinkSync(join(root, 'created.md'), join(other, 'dangling'));
  mkdirSync(join(other, 'outside'));
  mkdirSync(join(root, 'sub'));
  mkdirSync(join(other, 'a'));
  symlinkSync(join(other, 'outside'), join(root, 'link'));
  symlinkSync(join(root, 'sub'), join(other, 'a/link'));
  execFileSync('git', ['init', '-q', join(root, 'vendor')]);
  const workspace = realpathSync(process.env.HALVARD_WORKSPACE!);
  const inspect = [{ prefix: ['inspect', 'read'], options: {}, positionals: { min: 1, max: 1 } }];
  for (const command of [
    // A cd in a pipeline or background job, or one that may fail or be skipped,
    // leaves the next segment in the project.
    `cd ${other} | echo note > notes.md`,
    `cd ${other} & echo note > notes.md`,
    `cd ${other} ; echo note > notes.md`,
    `cd ${other}/plain.txt && echo note > notes.md`,
    `cd ${other} && ls || echo note > notes.md`,
    `true || cd ${other} && echo note > notes.md`,
    "cd '~' && echo note > notes.md",
    'cd "~" && echo note > notes.md',
    // Symlinks and the team workspace.
    `echo note > ${other}/into/notes.md`,
    `echo note > ${other}/dangling`,
    `echo note > ${other}/a/link/../source.txt`,
    `echo note > ${workspace}/task/claude-notes.md`,
    // Configured commands load the nested repository's configuration.
    'cd vendor && inspect read x',
  ]) {
    assert.equal(shellKind(command, inspect, root, root), 'mutation', command);
  }
  for (const command of [
    // A background list, a skipped cd or a logical .. leaves git where the model cannot follow.
    `cd ${other} ; false && cd ${root} && true ; git status`,
    `cd ${other} && true & git status`,
    `false && cd ${other} && true ; git status`,
    `cd ${other}/a/link && cd .. && git status`,
    `cd ../${basename(root)} && git status`,
    `cd sub && cd ../../${basename(root)} && git status`,
    // Configured commands beside a branch switch keep their directory limit.
    `cd vendor && inspect read x && cd ${root} && git switch -c fix/x`,
  ]) {
    assert.equal(shellKind(command, inspect, root, root), 'mutation', command);
  }
  assert.equal(
    shellKind('inspect read x && git switch -c fix/x', inspect, root, join(root, 'vendor')),
    'mutation',
  );
  for (const command of [
    'cd vendor && cat x',
    'cd link && cd .. && git status',
    `cd ${other} && ls | cat ${other}/plain.txt`,
    'inspect read x',
  ]) {
    assert.equal(shellKind(command, inspect, root, root), 'read', command);
  }
});

for (const harness of ['pi', 'claude', 'codex']) {
  test(`${harness}: host bookkeeping and web reads preserve gate receipts`, async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-bookkeeping-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: root });
    writeFileSync(
      join(root, '.halvard.json'),
      JSON.stringify({ gate: [process.execPath, '-e', 'process.exit(0)'] }),
    );
    const key = sessionKey(root, harness, 'reads');
    await runGate(root, key);
    for (const name of [
      'get_goal',
      'update_goal',
      'create_goal',
      'webrun',
      'web.run',
      'web__run',
      'clock__curr_time',
    ]) {
      const payload = {
        cwd: root,
        session_id: 'reads',
        tool_name: name,
        tool_input: { status: 'complete' },
      };
      assert.deepEqual(
        await handle(harness, {
          ...payload,
          hook_event_name: 'PreToolUse',
          permission_mode: 'plan',
        }),
        {},
        name,
      );
      await handle(harness, { ...payload, hook_event_name: 'PostToolUse' });
      assert.ok(await withState(root, key, (state) => state.pass), name);
    }
    // Polling a running gate writes no input.
    const poll = {
      cwd: root,
      session_id: 'reads',
      hook_event_name: 'PostToolUse',
      tool_name: 'write_stdin',
    };
    await handle(harness, { ...poll, tool_input: { session_id: 7, chars: '' } });
    assert.ok(await withState(root, key, (state) => state.pass), 'empty write_stdin');
    assert.equal(
      (
        await handle(harness, {
          cwd: root,
          session_id: 'reads',
          hook_event_name: 'PreToolUse',
          permission_mode: 'plan',
          tool_name: 'functions.exec',
          tool_input: { code: 'arbitrary code' },
        })
      ).decision,
      'deny',
    );
  });
}

test('harmless comment lines do not make reads unclassifiable', () => {
  for (const command of [
    '# Check sizes\nls -lah src',
    'ls src # trailing note',
    '# one\n# two\ndu -sh src',
    '# first line only, no secrets\ncat src/a.txt',
  ]) {
    assert.equal(shellKind(command, []), 'read', command);
  }
  for (const command of [
    '# "\nls "; rm -rf src; echo "\nls # "',
    "# it's\nls '; rm -rf src; echo '",
    '# note; rm -rf src\nls',
    '# note > out\nls',
    '# $(rm -rf src)\nls',
    '# a | sh\nls',
    '# a && rm x\nls',
    '# only a comment',
    'ls #x\nrm -rf src',
    'sort /dev/null # -o out',
    'sort src/a.txt # --output out',
    'find src # -delete',
    'find src # -exec sh',
    'git diff # --output=patch',
    'uniq -c src/a.txt # out',
  ]) {
    assert.notEqual(shellKind(command, []), 'read', command);
  }
  // A commented checkout could force or restore files when '#' is a plain word.
  assert.equal(shellKind('git checkout main # -f', []), 'mutation');
  assert.equal(shellKind('git checkout main', []), 'branch');
});

test('adversarial option values and forwarded delimiters stay guarded', () => {
  for (const command of [
    'rg -e -- *',
    'find . -name -- *',
    'git grep -e -- *',
    'find -- *',
    'git -C g1 status',
    'git -C g1 diff',
    'git -C g1 log',
  ]) {
    assert.notEqual(shellKind(command, []), 'read', command);
  }
  assert.notEqual(
    shellKind('npm ls -- --global', [
      { prefix: ['npm', 'ls'], options: {}, positionals: { min: 0, max: 9 } },
    ]),
    'read',
  );
});
