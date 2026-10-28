import type { ProjectConfig } from '../core/types.ts';
import './environment.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { quote } from '../core/shared/plugin.ts';
import { runGate } from '../core/workflow/gate.ts';
import { sessionKey, withState } from '../core/state.ts';
import { loadProject } from '../core/project.ts';
import { evaluatePolicy } from '../core/guard/policy.ts';
import { commands } from '../core/guard/shell.ts';
import { fixture, call, writeInput } from './hook-fixture.ts';

for (const harness of ['pi', 'claude', 'codex']) {
  test(`${harness}: typed read options and generic readers reject bypasses`, async (t) => {
    const root = fixture(t, {
      readCommands: [
        ['inspect', '--list'],
        {
          prefix: ['herdr', 'agent', 'read'],
          options: {
            '--lines': 'positiveInteger',
            '--source': 'string',
            '--quiet': 'flag',
            '-q': 'flag',
          },
          positionals: { min: 1, max: 1 },
        },
      ],
    });
    for (const command of [
      'herdr agent read X --lines 400 --source pane --quiet',
      'herdr agent read -q X',
      'inspect --list X',
      'herdr --help',
      'node --help',
      'npm --version',
      "jq -r '.name' source.txt",
      'herdr agent read X 2>&1 | tail',
    ]) {
      assert.equal(
        (await call(root, harness, 'PreToolUse', 'Bash', { command }, { permission_mode: 'plan' }))
          .decision,
        undefined,
        command,
      );
    }
    for (const command of [
      'herdr agent read X --write',
      'herdr agent read X --lin 3',
      'herdr agent read X --lines=3',
      'herdr agent read X --source=',
      'herdr agent read X --source',
      'herdr agent read X --lines 0',
      'herdr agent read X --lines -1',
      'herdr agent read X --lines 1.5',
      'herdr agent read X --lines nope',
      'herdr agent read X -qq',
      'herdr agent read',
      'herdr agent read X Y',
      'inspect --list X --write',
      'shutdown -h',
      'node -h',
      'node -e "print(1)"',
      'npm pack --dry-run',
      './herdr --help',
      '/usr/bin/node --help',
      'herdr --help X',
      'jq --run-tests source.txt',
      'jq --run-tests=source.txt',
      'jq --run source.txt',
      'jq -f source.txt',
      "jq --output result '.'",
      'cat "$TASK"',
    ]) {
      assert.equal(
        (await call(root, harness, 'PreToolUse', 'Bash', { command }, { permission_mode: 'plan' }))
          .decision,
        'deny',
        command,
      );
    }
    assert.match(
      (await call(root, harness, 'SessionStart')).context!,
      /literal paths rather than shell variables/,
    );
  });

  test(`${harness}: feature branches run shell freely and only shipping asks`, async (t) => {
    const root = realpathSync(fixture(t, { workflow: { requireReview: true } }));
    const key = sessionKey(root, harness, 'test-session');
    const bash = (command: string, extra = {}) =>
      call(root, harness, 'PreToolUse', 'Bash', { command }, extra);
    for (let run = 0; run < 2; run++) {
      writeFileSync(join(root, 'source.txt'), `edit ${run}\n`);
      for (const command of ['npm test', 'go test ./...', 'node -e "process.exit(0)"']) {
        assert.equal((await bash(command)).decision, undefined, command);
      }
    }
    await runGate(root, key);
    await call(root, harness, 'PostToolUse', 'Bash', { command: 'npm test' });
    await withState(root, key, (state) => assert.notEqual(state.pass, null));
    for (const command of [
      'git commit -m x',
      'git -C . commit -m x',
      'git merge feature/other',
      'git push',
      'npm test && git push',
      'npm publish',
      'docker push example/image',
      'npm run deploy',
      'npm run release',
      'echo $(git push)',
      'git add src/*.ts && git commit -m x',
      '/usr/bin/git commit -m x',
      'g\\it commit -m x',
      "'git' push",
      'npm test # note\ngit push',
      "sh -c 'git push'",
      'bash -lc "npm test && git commit -m x"',
      'git --git-dir .git commit -m x',
      'git --work-tree . push',
      'git \\\ncommit -m x',
    ]) {
      const result = await bash(command);
      assert.equal(result.decision, 'ask', command);
      assert.ok(result.request, command);
    }
    for (const command of [
      'rg "deploy" src',
      'npm test # git commit',
      'npm test -- --grep "push button"',
      "sh -c 'npm test'",
    ]) {
      assert.equal((await bash(command)).decision, undefined, command);
    }
    const stdin = (chars: string) =>
      call(root, harness, 'PreToolUse', 'write_stdin', { session_id: 7, chars });
    assert.equal((await stdin('git push\n')).decision, 'ask');
    assert.equal((await stdin('y\n')).decision, undefined);
    // Asking, and an approved retry that leaves the tree alone, keep the gate receipt.
    await withState(root, key, (state) => assert.notEqual(state.pass, null));
    const asked = await bash('git push');
    await call(root, harness, 'UserPromptSubmit', undefined, undefined, {
      prompt: `approve halvard ${asked.request!}`,
    });
    assert.equal((await bash('git push')).decision, undefined);
    assert.equal((await bash('git push')).decision, 'ask');
    await withState(root, key, (state) => assert.notEqual(state.pass, null));
    const [tool, input] = writeInput(harness, 'docs/tasks/new.md', '**Status:** done.');
    assert.match(
      (await call(root, harness, 'PreToolUse', tool, input)).reason!,
      /completion edit may change only task status/,
    );
    for (const path of ['.claude/settings.json', '.halvard.json', '.git/config']) {
      const [protectedTool, protectedInput] = writeInput(harness, path, 'x');
      assert.equal(
        (await call(root, harness, 'PreToolUse', protectedTool, protectedInput)).decision,
        'ask',
        path,
      );
    }
    assert.equal((await bash('npm test', { permission_mode: 'plan' })).decision, 'deny');
    execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
    assert.equal((await bash('npm test')).decision, 'deny');
    assert.equal((await bash('git commit -m x')).decision, 'deny');
    assert.equal((await bash('git push')).decision, 'ask');
    execFileSync('git', ['checkout', '-q', '-b', 'feature/test'], { cwd: root });
    writeFileSync(join(root, 'guard.mjs'), "export const pre = () => 'extension blocked';\n");
    const config = JSON.parse(readFileSync(join(root, '.halvard.json'), 'utf8')) as ProjectConfig;
    config.extensions = ['guard.mjs'];
    writeFileSync(join(root, '.halvard.json'), JSON.stringify(config));
    assert.equal((await bash('npm test')).reason!, 'extension blocked');
  });
}

test('read command objects and shell approval settings validate strictly', (t) => {
  const entry = {
    prefix: ['inspect'],
    options: { '--count': 'positiveInteger' },
    positionals: { min: 0, max: 1 },
  };
  const root = fixture(t);
  for (const bad of [
    null,
    {},
    { ...entry, extra: true },
    { ...entry, prefix: [] },
    { ...entry, options: [] },
    { ...entry, options: { '--x': 'number' } },
    { ...entry, options: { '-ab': 'flag' } },
    { ...entry, positionals: { min: -1, max: 1 } },
    { ...entry, positionals: { min: 2, max: 1 } },
    { ...entry, positionals: { min: 0, max: 1.5 } },
    { ...entry, positionals: { min: 0, max: 1, extra: true } },
  ]) {
    assert.throws(() => loadProject(root, { readCommands: [bad] }), /readCommands|read command/);
  }
  // Older configurations keep loading; the settings no longer change behaviour.
  assert.doesNotThrow(() =>
    loadProject(root, { protectedPaths: ['secret/**'], workflow: { shellApproval: 'workflow' } }),
  );
  assert.throws(() => loadProject(root, { workflow: { shellApproval: 'allow' } }), /shellApproval/);
  assert.throws(() => loadProject(root, { protectedPaths: [1] }), /protectedPaths/);
});

test('checkout paths and executable reader options cannot bypass read-only protection', async (t) => {
  const root = fixture(t);
  execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
  // Removing local-ref verification would allow checkout to restore a file on main.
  assert.equal(
    (await call(root, 'codex', 'PreToolUse', 'Bash', { command: 'git checkout source.txt' }))
      .decision,
    'deny',
  );
  assert.equal(
    (
      await call(
        root,
        'codex',
        'PreToolUse',
        'Bash',
        { command: 'sort --compress-program=evil source.txt' },
        { permission_mode: 'plan' },
      )
    ).decision,
    'deny',
  );
  for (const command of [
    'uniq source.txt output.txt',
    'sort -ro output.txt source.txt',
    'file -C',
  ]) {
    assert.equal(
      (await call(root, 'codex', 'PreToolUse', 'Bash', { command }, { permission_mode: 'plan' }))
        .decision,
      'deny',
    );
  }
});

for (const harness of ['pi', 'claude', 'codex']) {
  test(`${harness}: configured read prefixes cannot admit additional mutating flags`, async (t) => {
    const root = fixture(t, {
      readCommands: [
        ['gofmt', '-l'],
        ['go', 'env'],
        ['inspect', '--list'],
      ],
    });
    for (const command of [
      'gofmt -l -w source.go',
      'go env -w GOPROXY=hostile',
      'inspect --list --write output.txt',
    ]) {
      // Removing the extra-option check would allow these in a read-only session.
      assert.equal(
        (await call(root, harness, 'PreToolUse', 'Bash', { command }, { permission_mode: 'plan' }))
          .decision,
        'deny',
      );
    }
    assert.equal(
      (
        await call(
          root,
          harness,
          'PreToolUse',
          'Bash',
          { command: 'inspect --list source.txt' },
          { permission_mode: 'plan' },
        )
      ).decision,
      undefined,
    );
  });
}

test('common read commands are reads and lookalike writes are not', async (t) => {
  const root = fixture(t);
  mkdirSync(join(root, 'core'));
  for (const command of [
    'cd core && ls',
    'ls 2>/dev/null',
    'git log 2>&1 | head -5',
    'cat source.txt >/dev/null',
    'wc core/*.mjs',
    'ls docs/task?.md',
    'grep "a\\"b" source.txt',
    'git grep original',
    'git remote -v',
    'git branch -a',
    'git branch --show-current',
    'git rev-list HEAD',
    'sed -n 1,5p source.txt',
    'git log --oneline --no-textconv',
    'sort -r source.txt',
  ]) {
    assert.equal(
      (await call(root, 'claude', 'PreToolUse', 'Bash', { command }, { permission_mode: 'plan' }))
        .decision,
      undefined,
      command,
    );
  }
  for (const command of [
    'find * -delete',
    'sort -o out *.txt',
    'git checkout *.txt',
    'cat source.txt > out.txt',
    'ls 2>/tmp/errors',
    'cd core && rm x',
    'git branch -D x',
    'git branch new-branch',
    'git remote add origin x',
    'git grep -O original',
    'git grep -iOvim original',
    'grep "$HOME" source.txt',
    'sed -n 1p -i source.txt',
    "sed -n 1p -e 'w out.txt' source.txt",
    'sed -n 1p --in-place source.txt',
    'git grep --open-files-in=vim original',
    'git log --textc -p',
    'git diff --ext',
    'git log --outp=out.txt',
    'sort --out=out.txt source.txt',
    'sort --compress=evil source.txt',
    'file --comp source.txt',
  ]) {
    assert.equal(
      (await call(root, 'claude', 'PreToolUse', 'Bash', { command }, { permission_mode: 'plan' }))
        .decision,
      'deny',
      command,
    );
  }
});

test('quoted paths parse back to the same word, including apostrophes', () => {
  for (const path of [
    '/plain/bin/halvard.ts',
    '/a b/bin/halvard.ts',
    "/Users/o'neil/bin/halvard.ts",
    `/it's "$HOME" \\ \`x\`/halvard.ts`,
  ]) {
    assert.deepEqual(
      commands(`node ${quote(path)} gate key`),
      [['node', path, 'gate', 'key']],
      path,
    );
  }
});

for (const harness of ['pi', 'claude', 'codex']) {
  test(`${harness}: help and version flags are reads only for vetted executables`, async (t) => {
    const root = fixture(t);
    execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
    for (const command of ['git --help', 'node --version', 'rg --help']) {
      assert.equal(
        (await call(root, harness, 'PreToolUse', 'Bash', { command }, { permission_mode: 'plan' }))
          .decision,
        undefined,
        command,
      );
    }
    // An executable can ignore the flag and write, commit or push instead.
    for (const command of ['release-helper --help', 'make --version', 'python3 --help']) {
      assert.equal(
        (await call(root, harness, 'PreToolUse', 'Bash', { command })).decision,
        'deny',
        command,
      );
      assert.equal(
        (await call(root, harness, 'PreToolUse', 'Bash', { command }, { permission_mode: 'plan' }))
          .decision,
        'deny',
        command,
      );
    }
  });

  test(`${harness}: outside aliases into the project follow project policy`, async (t) => {
    const root = fixture(t);
    const outside = mkdtempSync(join(tmpdir(), 'workflow-alias-'));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    symlinkSync(join(root, 'source.txt'), join(outside, 'file-alias'));
    symlinkSync(join(root, 'docs'), join(outside, 'dir-alias'));
    execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
    for (const path of [
      join(outside, 'file-alias'),
      join(outside, 'dir-alias/tasks/task.md'),
      join(outside, 'dir-alias/new.md'),
    ]) {
      const [tool, input] = writeInput(harness, path, 'changed');
      assert.equal((await call(root, harness, 'PreToolUse', tool, input)).decision, 'deny', path);
    }
    execFileSync('git', ['checkout', '-q', '-b', 'feature/alias'], { cwd: root });
    const [tool, input] = writeInput(
      harness,
      join(outside, 'dir-alias/tasks/new.md'),
      '**Status:** done.',
    );
    assert.match(
      (await call(root, harness, 'PreToolUse', tool, input)).reason!,
      /Run the full configured gate/,
    );
  });

  test(`${harness}: multiply linked files and nested configuration cannot bypass protection`, async (t) => {
    const root = fixture(t);
    linkSync(join(root, '.halvard.json'), join(root, 'ordinary.json'));
    const [tool, input] = writeInput(
      harness,
      'ordinary.json',
      '{"version":1,"protectedBranches":[]}',
    );
    await assert.rejects(call(root, harness, 'PreToolUse', tool, input), /multiple hard links/);
    rmSync(join(root, 'ordinary.json'));
    const [nestedTool, nestedInput] = writeInput(
      harness,
      'nested/.halvard.json',
      '{"version":1,"protectedBranches":[]}',
    );
    assert.equal(
      (await call(root, harness, 'PreToolUse', nestedTool, nestedInput)).decision,
      'ask',
    );
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested/.halvard.json'), '{"version":1,"protectedBranches":[]}');
    execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
    const [parentTool, parentInput] = writeInput(harness, '../source.txt', 'changed');
    assert.equal(
      (await call(join(root, 'nested'), harness, 'PreToolUse', parentTool, parentInput)).decision,
      'deny',
    );
    // Git ignores an empty or malformed marker and uses the parent repository.
    mkdirSync(join(root, 'nested/.git'));
    mkdirSync(join(root, 'bad'));
    writeFileSync(join(root, 'bad/.git'), 'not a gitdir pointer');
    mkdirSync(join(root, 'partial/.git'), { recursive: true });
    writeFileSync(join(root, 'partial/.git/HEAD'), 'ref: refs/heads/main\n');
    for (const dir of ['nested', 'bad', 'partial']) {
      assert.equal(loadProject(join(root, dir)).root, realpathSync(root), dir);
      assert.equal(
        (await call(join(root, dir), harness, 'PreToolUse', parentTool, parentInput)).decision,
        'deny',
        dir,
      );
    }
  });
}

test('quoted backslashes, multi-range sed, check-ignore and project -C are reads', async (t) => {
  const root = fixture(t);
  const other = mkdtempSync(join(tmpdir(), 'workflow-other-'));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: other });
  for (const command of [
    'grep -rn "a\\|b" source.txt',
    'grep -v "\\.map" source.txt',
    'grep "\\$HOME" source.txt',
    "sed -n '1,2p;3p' source.txt",
    'cat source.txt | sed -n 1p',
    'git check-ignore -v source.txt',
    `git -C ${root} status --short`,
    `ls ${root} && git -C ${root} log --oneline -3`,
  ]) {
    assert.equal(
      (await call(root, 'pi', 'PreToolUse', 'Bash', { command }, { permission_mode: 'plan' }))
        .decision,
      undefined,
      command,
    );
  }
  for (const command of [
    'grep "$HOME" source.txt',
    'grep "`id`" source.txt',
    'grep "a\\\nb" source.txt',
    "sed -n '1p;w out.txt' source.txt",
    "sed -n '1p;e id' source.txt",
    `git -C ${other} status`,
    'git -C . status',
    `git -C ${root} -c core.pager=x log`,
  ]) {
    assert.equal(
      (await call(root, 'pi', 'PreToolUse', 'Bash', { command }, { permission_mode: 'plan' }))
        .decision,
      'deny',
      command,
    );
  }
  assert.equal(
    (
      await call(
        root,
        'pi',
        'PreToolUse',
        'web_search',
        { query: 'x' },
        { permission_mode: 'plan' },
      )
    ).decision,
    undefined,
  );
});

test('cd into another repository is not a read, while cd inside the project is', async (t) => {
  const root = fixture(t);
  const other = mkdtempSync(join(tmpdir(), 'workflow-cd-'));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  mkdirSync(join(root, 'core'));
  for (const command of [
    'cd core && ls',
    `cd ${root} && git status`,
    'cd core && cd .. && git status',
    // Built-in readers act the same in any directory.
    'cd ~ && ls',
    'cd - && ls',
    `cd ${other} && ls *.txt`,
  ]) {
    assert.equal(
      (await call(root, 'pi', 'PreToolUse', 'Bash', { command }, { permission_mode: 'plan' }))
        .decision,
      undefined,
      command,
    );
  }
  for (const command of [
    `cd ${other} && git status`,
    'cd .. && git status',
    'cd && git status',
    'cd - && git status',
  ]) {
    assert.equal(
      (await call(root, 'pi', 'PreToolUse', 'Bash', { command }, { permission_mode: 'plan' }))
        .decision,
      'deny',
      command,
    );
  }
  // A valid nested repository can run its own fsmonitor or pager configuration.
  execFileSync('git', ['init', '-q', join(root, 'core/vendor')]);
  assert.equal(
    (
      await call(
        root,
        'pi',
        'PreToolUse',
        'Bash',
        { command: 'cd core/vendor && ls' },
        { permission_mode: 'plan' },
      )
    ).decision,
    undefined,
  );
  for (const [command, workdir] of [
    ['cd core/vendor && git status', undefined],
    ['git status', 'core/vendor'],
    ['git log', join(root, 'core/vendor')],
  ]) {
    assert.equal(
      (
        await call(
          root,
          'pi',
          'PreToolUse',
          'Bash',
          { command, workdir },
          { permission_mode: 'plan' },
        )
      ).decision,
      'deny',
      `${command} in ${workdir}`,
    );
  }
  assert.equal(
    (
      await call(
        root,
        'pi',
        'PreToolUse',
        'Bash',
        { command: 'git status', workdir: 'core' },
        { permission_mode: 'plan' },
      )
    ).decision,
    undefined,
  );
});

for (const harness of ['claude', 'codex', 'pi']) {
  test(`${harness}: nested Git reads are not reads on protected branches`, async (t) => {
    const root = fixture(t);
    const nested = join(root, 'vendor');
    execFileSync('git', ['init', '-q', nested]);
    for (const branch of ['main', 'feature/test']) {
      execFileSync('git', ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd: root });
      for (const [command, workdir] of [
        ['git status', nested],
        ['git log', nested],
        ['cd vendor && git status', root],
      ]) {
        const result = await call(
          root,
          harness,
          'PreToolUse',
          'Bash',
          { command, workdir },
          { permission_mode: 'default' },
        );
        assert.equal(
          result.decision,
          branch === 'main' ? 'deny' : undefined,
          `${branch}: ${command}`,
        );
      }
    }
  });
}

test('opaque commands on an undetermined branch retain the branch diagnosis', () => {
  const result = evaluatePolicy({
    readonly: false,
    read: false,
    opaque: true,
    review: false,
    gate: false,
    gateConfigured: false,
    branch: null,
    branchOperation: false,
    shipping: false,
    protectedBranches: ['main'],
  });
  assert.equal(result?.decision, 'deny');
  assert.match(result!.reason!, /Cannot determine the branch/);
  assert.match(result!.reason!, /could not be classified as read-only/);
  assert.match(result!.reason!, /literal paths/);
  assert.match(result!.reason!, /Check out a branch before changing the project\.$/);
});

for (const harness of ['pi', 'claude', 'codex']) {
  test(`${harness}: opaque denials explain classification while mutation wording stays unchanged`, async (t) => {
    const root = fixture(t);
    execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
    for (const extra of [{}, { permission_mode: 'plan' }]) {
      const result = await call(
        root,
        harness,
        'PreToolUse',
        'Bash',
        { command: 'wc -l $(git ls-files)' },
        extra,
      );
      assert.equal(result.decision, 'deny');
      assert.match(result.reason!, /could not be classified as read-only/);
      assert.match(result.reason!, /literal paths/);
    }
    const previousReview = process.env.HALVARD_REVIEW;
    try {
      process.env.HALVARD_REVIEW = '1';
      const result = await call(root, harness, 'PreToolUse', 'Bash', {
        command: 'wc -l $(git ls-files)',
      });
      assert.equal(result.decision, 'deny');
      assert.match(result.reason!, /could not be classified as read-only/);
      assert.match(result.reason!, /literal paths/);
      assert.doesNotMatch(result.reason!, /feature or fix branch/);
    } finally {
      if (previousReview === undefined) {
        delete process.env.HALVARD_REVIEW;
      } else {
        process.env.HALVARD_REVIEW = previousReview;
      }
    }
    assert.equal(
      (await call(root, harness, 'PreToolUse', 'Bash', { command: 'touch changed.txt' })).reason,
      'No work on protected branch main. Create a feature or fix branch first. To trust a test or query command as a read, list it in readCommands.',
    );
    assert.equal(
      (
        await call(
          root,
          harness,
          'PreToolUse',
          'Bash',
          { command: 'touch changed.txt' },
          { permission_mode: 'plan' },
        )
      ).reason,
      'This session is read-only. Exit plan/review mode before making changes or running project checks.',
    );
  });

  test(`${harness}: plain feature-branch edits do not fingerprint an over-budget tree`, async (t) => {
    const root = fixture(t);
    const now = Date.now;
    let calls = 0;
    Date.now = () => now() + (calls++ ? 10 * 60 * 1000 : 0);
    t.after(() => {
      Date.now = now;
    });
    const [tool, input] = writeInput(harness, 'other.txt', 'changed');
    assert.equal((await call(root, harness, 'PreToolUse', tool, input)).decision, undefined);
    calls = 0;
    assert.equal(
      (await call(root, harness, 'PreToolUse', 'Bash', { command: 'cat source.txt' })).decision,
      undefined,
    );
    if (harness !== 'pi') {
      Date.now = now;
      writeFileSync(
        join(root, '.halvard.json'),
        JSON.stringify({ version: 1, workflow: { shellApproval: 'native' } }),
      );
      calls = 0;
      Date.now = () => now() + (calls++ ? 10 * 60 * 1000 : 0);
      assert.equal(
        (await call(root, harness, 'PreToolUse', 'Bash', { command: 'touch changed.txt' }))
          .decision,
        undefined,
      );
    }
  });

  test(`${harness}: an approval request on an over-budget tree fails closed`, async (t) => {
    const root = fixture(t);
    const now = Date.now;
    let calls = 0;
    Date.now = () => now() + (calls++ ? 10 * 60 * 1000 : 0);
    t.after(() => {
      Date.now = now;
    });
    const [tool, input] = writeInput(harness, '.halvard.json', '{}');
    await assert.rejects(call(root, harness, 'PreToolUse', tool, input), /too large to verify/);
  });

  test(`${harness}: a done edit past its time budget denies before the tool`, async (t) => {
    const root = fixture(t);
    const key = sessionKey(root, harness, 'test-session');
    await runGate(root, key);
    const now = Date.now;
    let calls = 0;
    // The first reading sets the deadline; every later one is past it.
    Date.now = () => now() + (calls++ ? 10 * 60 * 1000 : 0);
    t.after(() => {
      Date.now = now;
    });
    const [tool, input] = writeInput(harness, 'docs/tasks/new.md', '**Status:** done.');
    await assert.rejects(call(root, harness, 'PreToolUse', tool, input), /too large to verify/);
  });
}
