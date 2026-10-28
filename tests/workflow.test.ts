import type { TestContext } from 'node:test';
import type { ToolInput, HookPayload, ProjectConfig, HarnessSettings } from '../core/types.ts';
import './environment.ts';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
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
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { handle } from '../core/runtime.ts';
import { pluginRoot, quote } from '../core/shared/plugin.ts';
import { runGate } from '../core/workflow/gate.ts';
import { sessionKey, fingerprint, stateDirectory, withState } from '../core/state.ts';
import { hookOutput } from '../core/harnesses/index.ts';
import { install, installPlan } from '../core/install/install.ts';
import { loadProject } from '../core/project.ts';
import { skills } from '../core/context.ts';
import { evaluatePolicy } from '../core/guard/policy.ts';
import { commands } from '../core/guard/shell.ts';
import { startTask } from '../core/workflow/tasks.ts';

function fixture(t: TestContext, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'workflow-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '--initial-branch=feature/test'], { cwd: root });
  writeFileSync(
    join(root, '.halvard.json'),
    JSON.stringify({
      version: 1,
      workflow: { requireReview: false },
      gate: [process.execPath, '-e', 'process.exit(0)'],
      ...overrides,
    }),
  );
  writeFileSync(join(root, 'source.txt'), 'original\n');
  mkdirSync(join(root, 'docs/tasks'), { recursive: true });
  writeFileSync(join(root, 'docs/tasks/task.md'), '**Status:** open.\n');
  return root;
}

function call(
  root: string,
  harness: string,
  event: string,
  tool?: string,
  input?: unknown,
  extra: Partial<HookPayload> & Record<string, unknown> = {},
) {
  return handle(harness, {
    cwd: root,
    session_id: 'test-session',
    hook_event_name: event,
    tool_name: tool,
    tool_input: input,
    ...extra,
  });
}

function writeInput(harness: string, path: string, content: string): [string, ToolInput] {
  if (harness === 'pi') return ['write', { path, content }];
  if (harness === 'claude') return ['Write', { file_path: path, content }];
  return [
    'apply_patch',
    {
      command: `*** Begin Patch\n*** Add File: ${path}\n${content
        .split('\n')
        .map((line) => '+' + line)
        .join('\n')}\n*** End Patch`,
    },
  ];
}

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

for (const harness of ['pi', 'claude', 'codex']) {
  test(`${harness}: branch and plan modes fail closed for unknown tools`, async (t) => {
    const root = fixture(t);
    execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
    const [tool, input] = writeInput(harness, 'new.txt', 'hello');
    assert.equal((await call(root, harness, 'PreToolUse', tool, input)).decision, 'deny');
    assert.equal(
      (await call(root, harness, 'PreToolUse', 'Bash', { command: 'python3 -c "print(1)"' }))
        .decision,
      'deny',
    );
    assert.equal(
      (await call(root, harness, 'PreToolUse', 'Bash', { command: 'git checkout -b feature/new' }))
        .decision,
      undefined,
    );
    execFileSync('git', ['checkout', '-q', '-b', 'feature/test'], { cwd: root });
    assert.equal(
      (await call(root, harness, 'PreToolUse', tool, input, { permission_mode: 'plan' })).decision,
      'deny',
    );
    assert.equal(
      (
        await call(
          root,
          harness,
          'PreToolUse',
          'Bash',
          { command: 'cat source.txt' },
          { permission_mode: 'plan' },
        )
      ).decision,
      undefined,
    );
    assert.equal(
      (
        await call(
          root,
          harness,
          'PreToolUse',
          'custom_write',
          { path: 'source.txt' },
          { permission_mode: 'plan' },
        )
      ).decision,
      'deny',
    );
    assert.equal(
      (await call(root, harness, 'PreToolUse', 'custom_write', { path: 'source.txt' })).decision,
      undefined,
    );
  });

  test(`${harness}: a real gate unlocks the done marker only on its own tree`, async (t) => {
    const root = fixture(t);
    const key = sessionKey(root, harness, 'test-session');
    const [tool, input] = writeInput(harness, 'docs/tasks/new.md', '**Status:** done.');
    assert.equal((await call(root, harness, 'PreToolUse', tool, input)).decision, 'deny');
    await runGate(root, key);
    assert.equal((await call(root, harness, 'PreToolUse', tool, input)).decision, undefined);
    writeFileSync(join(root, 'source.txt'), 'changed after the gate\n');
    assert.equal((await call(root, harness, 'PreToolUse', tool, input)).decision, 'deny');
  });

  test(`${harness}: outside edits and sentinel spoofing invalidate or cannot establish a pass`, async (t) => {
    const root = fixture(t);
    const key = sessionKey(root, harness, 'test-session');
    const [tool, input] = writeInput(harness, 'docs/tasks/new.md', '**Status:** done.');
    await runGate(root, key);
    writeFileSync(join(root, 'source.txt'), 'changed outside harness\n');
    assert.equal((await call(root, harness, 'PreToolUse', tool, input)).decision, 'deny');
    await call(
      root,
      harness,
      'PostToolUse',
      'Bash',
      { command: 'echo "gate(full): OK"' },
      { tool_response: { stdout: 'gate(full): OK' } },
    );
    assert.equal((await call(root, harness, 'PreToolUse', tool, input)).decision, 'deny');
  });

  test(`${harness}: required skills are loaded and on-demand skills are cataloged`, async (t) => {
    const root = fixture(t, { requiredSkills: ['language-review'] });
    mkdirSync(join(root, '.agents/skills/language-review'), { recursive: true });
    writeFileSync(
      join(root, '.agents/skills/language-review/SKILL.md'),
      '---\nname: language-review\ndescription: Review this language\n---\nSpecific rule for this project.\n',
    );
    mkdirSync(join(root, '.agents/skills/domain'), { recursive: true });
    writeFileSync(
      join(root, '.agents/skills/domain/SKILL.md'),
      '---\nname: domain\ndescription: Use for domain work\n---\nDomain body.\n',
    );
    const { context } = await call(root, harness, 'SessionStart');
    assert.match(context!, /Specific rule for this project/);
    assert.match(context!, /domain: Use for domain work/);
    assert.doesNotMatch(context!, /Domain body/);
  });
}

for (const harness of ['pi', 'claude', 'codex']) {
  test(`${harness}: moving an example marker into task status still requires completion checks`, async (t) => {
    const root = fixture(t, { workflow: { requireReview: true } });
    const before = '**Status:** open.\n\nExample: **Status:** done.\n';
    const after = '**Status:** done.\n\nExample: completed status.\n';
    writeFileSync(join(root, 'docs/tasks/task.md'), before);
    const [tool, input] =
      harness === 'codex'
        ? [
            'apply_patch',
            {
              command: `*** Begin Patch\n*** Update File: docs/tasks/task.md\n@@\n-${before.trimEnd().split('\n').join('\n-')}\n+${after.trimEnd().split('\n').join('\n+')}\n*** End Patch`,
            },
          ]
        : writeInput(harness, 'docs/tasks/task.md', after);
    // Counting marker occurrences misses this status transition because the count stays one.
    const denied = await call(root, harness, 'PreToolUse', tool, input);
    assert.equal(denied.decision, 'deny');
    assert.match(denied.reason!, /Run the full configured gate/);
    await runGate(root, sessionKey(root, harness, 'test-session'));
    const checked = await call(root, harness, 'PreToolUse', tool, input);
    assert.equal(checked.decision, 'deny');
    assert.match(checked.reason!, /completion edit may change only task status/);
  });
}

for (const harness of ['pi', 'claude', 'codex']) {
  test(`${harness}: newly added inline completion markers still require completion checks`, async (t) => {
    const before = '**Status:** open.\n';
    for (const line of ['> **Status:** done.', 'Overall: **Status:** done.']) {
      const root = fixture(t, { workflow: { requireReview: true } });
      writeFileSync(join(root, 'docs/tasks/task.md'), before);
      const after = before + line + '\n';
      const [tool, input] =
        harness === 'codex'
          ? [
              'apply_patch',
              {
                command: `*** Begin Patch\n*** Update File: docs/tasks/task.md\n@@\n **Status:** open.\n+${line}\n*** End Patch`,
              },
            ]
          : writeInput(harness, 'docs/tasks/task.md', after);
      // Looking only at the first status line misses new inline or quoted completion markers.
      const denied = await call(root, harness, 'PreToolUse', tool, input);
      assert.equal(denied.decision, 'deny');
      assert.match(denied.reason!, /Run the full configured gate/);
      await runGate(root, sessionKey(root, harness, 'test-session'));
      const checked = await call(root, harness, 'PreToolUse', tool, input);
      assert.equal(checked.decision, 'deny');
      assert.match(checked.reason!, /completion edit may change only task status/);
    }
  });
}

test('task status completion checks include trailing Markdown spaces and comments', async (t) => {
  const root = fixture(t);
  for (const suffix of ['  ', ' <!-- completed -->']) {
    writeFileSync(
      join(root, 'docs/tasks/task.md'),
      '**Status:** open.\n\nExample: **Status:** done.\n',
    );
    const result = await call(root, 'claude', 'PreToolUse', 'Write', {
      file_path: 'docs/tasks/task.md',
      content: `**Status:** done.${suffix}\n\nExample: completed status.\n`,
    });
    assert.equal(result.decision, 'deny');
    assert.match(result.reason!, /Run the full configured gate/);
  }
});

test('Codex explicit approval is one-use, operation-bound, session-bound and tree-bound', async (t) => {
  const root = fixture(t);
  const tool = 'apply_patch';
  const input = {
    command: '*** Begin Patch\n*** Add File: .codex/policy.txt\n+policy\n*** End Patch',
  };
  const requested = await call(root, 'codex', 'PreToolUse', tool, input);
  assert.equal(requested.decision, 'ask');
  assert.equal(
    hookOutput('codex', 'PreToolUse', requested).hookSpecificOutput!.permissionDecision,
    'deny',
  );
  assert.equal(
    hookOutput('claude', 'PreToolUse', requested).hookSpecificOutput!.permissionDecision,
    'ask',
  );
  await call(root, 'codex', 'UserPromptSubmit', undefined, undefined, {
    prompt: `approve halvard ${requested.request!}`,
  });
  assert.equal(
    (await call(root, 'codex', 'PreToolUse', tool, input, { session_id: 'another' })).decision,
    'ask',
  );
  assert.equal((await call(root, 'codex', 'PreToolUse', tool, input)).decision, undefined);
  assert.equal((await call(root, 'codex', 'PreToolUse', tool, input)).decision, 'ask');
  const fresh = await call(root, 'codex', 'PreToolUse', tool, input);
  writeFileSync(join(root, 'source.txt'), 'changed');
  assert.match(
    (
      await call(root, 'codex', 'UserPromptSubmit', undefined, undefined, {
        prompt: `approve halvard ${fresh.request!}`,
      })
    ).context!,
    /stale/,
  );
  assert.equal((await call(root, 'codex', 'PreToolUse', tool, input)).decision, 'ask');
});

test('failed and source-mutating gates never grant a receipt', async (t) => {
  for (const code of ['process.exit(1)', "require('fs').writeFileSync('source.txt','changed')"]) {
    const root = fixture(t, { gate: [process.execPath, '-e', code] });
    await assert.rejects(runGate(root, sessionKey(root, 'codex', randomUUID())), /gate failed/);
  }
});

test('refused patches say how to recover', async (t) => {
  const root = fixture(t);
  const patch = (body: string) =>
    call(root, 'codex', 'PreToolUse', 'apply_patch', {
      command: `*** Begin Patch\n${body}\n*** End Patch`,
    });
  const rebuild = 're-read each file in the patch and rebuild the hunks from its current text';
  await assert.rejects(
    patch('*** Add File: new.txt\n+x\n*** Update File: source.txt\n@@\n-stale\n+fresh'),
    { message: `patch hunk does not match the file; ${rebuild}` },
  );
  await assert.rejects(patch('*** Update File: source.txt\n@@ missing\n-original\n+fresh'), {
    message: `patch context does not match the file; ${rebuild}`,
  });
  await assert.rejects(
    patch(
      '*** Update File: source.txt\n@@\n-original\n+one\n*** Update File: source.txt\n@@\n-original\n+two',
    ),
    {
      message:
        'patch touches the same path more than once; put all changes to each file in one section',
    },
  );
});

test('path traversal, escaping symlinks and mixed patches cannot bypass guards', async (t) => {
  const root = fixture(t);
  const outside = mkdtempSync(join(tmpdir(), 'workflow-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, join(root, 'escape'));
  // Literal paths outside the project belong to the harness's own permissions.
  assert.equal(
    (await call(root, 'pi', 'PreToolUse', 'write', { path: '../outside.txt', content: 'x' }))
      .decision,
    undefined,
  );
  await assert.rejects(
    call(root, 'claude', 'PreToolUse', 'Write', { file_path: 'escape/x.txt', content: 'x' }),
    /escapes/,
  );
  await assert.rejects(
    call(root, 'claude', 'PreToolUse', 'Write', {
      file_path: join(root, 'escape/x.txt'),
      content: 'x',
    }),
    /escapes/,
  );
  const result = await call(root, 'codex', 'PreToolUse', 'apply_patch', {
    command:
      '*** Begin Patch\n*** Add File: good.txt\n+x\n*** Add File: .codex/config.toml\n+x\n*** End Patch',
  });
  assert.equal(result.decision, 'ask');
  await assert.rejects(
    call(root, 'codex', 'PreToolUse', 'apply_patch', { command: 'nonsense' }),
    /envelope/,
  );
  await assert.rejects(
    call(root, 'codex', 'PreToolUse', 'apply_patch', {
      command:
        '*** Begin Patch\n*** Update File: source.txt\n*** Move to: ../escape.txt\n@@\n-original\n+changed\n*** End Patch',
    }),
    /outside/,
  );
});

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

test('installation preserves existing settings, is idempotent and preflights conflicts', (t) => {
  const root = fixture(t);
  mkdirSync(join(root, '.pi'));
  writeFileSync(join(root, '.pi/settings.json'), JSON.stringify({ defaultThinkingLevel: 'high' }));
  mkdirSync(join(root, '.claude'));
  writeFileSync(
    join(root, '.claude/settings.json'),
    JSON.stringify({ permissions: { allow: ['Read'] }, hooks: { Stop: [] } }),
  );
  install(root);
  const first = readFileSync(join(root, '.pi/settings.json'), 'utf8');
  install(root);
  assert.equal(readFileSync(join(root, '.pi/settings.json'), 'utf8'), first);
  const claude = JSON.parse(
    readFileSync(join(root, '.claude/settings.json'), 'utf8'),
  ) as HarnessSettings;
  assert.deepEqual(claude.permissions, { allow: ['Read'] });
  assert.deepEqual(claude.hooks, { Stop: [] });
  const codexConfig = join(root, '.codex/config.toml');
  const enabled = readFileSync(codexConfig, 'utf8');
  writeFileSync(codexConfig, enabled.replace('enabled = true', 'enabled = false'));
  assert.throws(() => installPlan(root), /enabled = true/);
  writeFileSync(codexConfig, enabled);
  writeFileSync(
    join(root, '.claude/settings.json'),
    JSON.stringify({
      extraKnownMarketplaces: { ghulando: { source: { path: 'another' } } },
    }),
  );
  assert.throws(() => installPlan(root), /another source/);
  assert.equal(readFileSync(join(root, '.pi/settings.json'), 'utf8'), first);
});

test('a dangling Claude skills symlink fails installation before any files are written', (t) => {
  const root = fixture(t);
  mkdirSync(join(root, '.agents/skills'), { recursive: true });
  mkdirSync(join(root, '.claude'));
  symlinkSync('../missing-skills', join(root, '.claude/skills'));
  const before = fingerprint(root);
  // existsSync alone treats the dangling link as absent and installation writes settings before EEXIST.
  assert.throws(() => install(root), /dangling.*symlink/);
  assert.equal(fingerprint(root), before);
});

test('installation preserves an equivalent single-quoted Codex plugin table', (t) => {
  const root = fixture(t);
  mkdirSync(join(root, '.codex'));
  const toml = "[plugins.'halvard@ghulando']\nenabled = true\n";
  writeFileSync(join(root, '.codex/config.toml'), toml);
  install(root);
  // Matching only the generated double-quoted heading appends a duplicate table.
  assert.equal(readFileSync(join(root, '.codex/config.toml'), 'utf8'), toml);
  writeFileSync(join(root, '.codex/config.toml'), toml.replace('true', 'false'));
  assert.throws(() => installPlan(root), /enabled = true/);
});

test('checkout exemption validates branches in the shell execution repository', async (t) => {
  const root = fixture(t);
  execFileSync('git', ['add', 'source.txt'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ],
    { cwd: root },
  );
  execFileSync('git', ['branch', 'source.txt'], { cwd: root });
  execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
  const nested = join(root, 'nested');
  mkdirSync(nested);
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: nested });
  writeFileSync(join(nested, 'source.txt'), 'nested original\n');
  execFileSync('git', ['add', 'source.txt'], { cwd: nested });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ],
    { cwd: nested },
  );
  writeFileSync(join(nested, 'source.txt'), 'nested dirty\n');
  execFileSync('git', ['branch', 'feature/nested'], { cwd: nested });
  for (const harness of ['pi', 'claude', 'codex']) {
    const result = await call(root, harness, 'PreToolUse', 'Bash', {
      command: 'git checkout source.txt',
      workdir: nested,
    });
    assert.equal(result.decision, 'deny', harness);
    assert.equal(readFileSync(join(nested, 'source.txt'), 'utf8'), 'nested dirty\n');
    assert.equal(
      (
        await call(root, harness, 'PreToolUse', 'Bash', {
          command: 'git checkout feature/nested',
          workdir: nested,
        })
      ).decision,
      undefined,
    );
  }
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

test('Claude explicit fallback authorizes the exact retry after native ask', async (t) => {
  const root = fixture(t);
  const input = { file_path: '.claude/policy.txt', content: 'policy' };
  // Hashing the request before revision invalidation makes this retry ask again.
  const requested = await call(root, 'claude', 'PreToolUse', 'Write', input);
  await call(root, 'claude', 'UserPromptSubmit', undefined, undefined, {
    prompt: `approve halvard ${requested.request!}`,
  });
  assert.equal((await call(root, 'claude', 'PreToolUse', 'Write', input)).decision, undefined);
  assert.equal((await call(root, 'claude', 'PreToolUse', 'Write', input)).decision, 'ask');
});

test('native edits preview full contents and post hooks accept already-applied edits', async (t) => {
  const root = fixture(t);
  for (const [harness, tool, input] of [
    ['pi', 'edit', { path: 'source.txt', oldText: 'original', newText: 'updated' }],
    [
      'claude',
      'MultiEdit',
      { file_path: 'source.txt', edits: [{ old_string: 'original', new_string: 'updated' }] },
    ],
    [
      'codex',
      'apply_patch',
      {
        command:
          '*** Begin Patch\n*** Update File: source.txt\n@@\n-original\n+updated\n*** End Patch',
      },
    ],
  ] as [string, string, ToolInput][]) {
    writeFileSync(join(root, 'source.txt'), 'original\n');
    assert.equal((await call(root, harness, 'PreToolUse', tool, input)).decision, undefined);
    writeFileSync(join(root, 'source.txt'), 'updated\n');
    // Reapplying the edit in post normalization would throw instead of succeeding.
    assert.deepEqual(await call(root, harness, 'PostToolUse', tool, input), {});
  }
});

test('patch previews honor anchors, EOF, original-file chunks and append-only updates', async (t) => {
  const { previewPatch } = await import('../core/guard/tools.ts');
  const root = realpathSync(fixture(t));
  writeFileSync(join(root, 'source.txt'), 'first\nrepeat\nsecond\nrepeat\n');
  const preview = (body: string) =>
    previewPatch(
      root,
      root,
      `*** Begin Patch\n*** Update File: source.txt\n${body}\n*** End Patch`,
    )[0]!.after;
  // Ignoring the context anchor replaces the first repeat instead of the second.
  assert.equal(preview('@@ second\n-repeat\n+changed'), 'first\nrepeat\nsecond\nchanged\n');
  assert.equal(
    preview('@@\n-repeat\n+changed\n*** End of File'),
    'first\nrepeat\nsecond\nchanged\n',
  );
  // Treating an empty old hunk as an insertion at cursor zero would prepend it.
  assert.equal(preview('@@\n+appended'), 'first\nrepeat\nsecond\nrepeat\nappended\n');
  assert.equal(
    preview('@@\n-first\n+inserted\n+first\n@@ second\n-repeat\n+changed'),
    'inserted\nfirst\nrepeat\nsecond\nchanged\n',
  );
  assert.throws(() => preview('@@ missing\n-repeat\n+changed'), /context/);
  assert.throws(
    () =>
      previewPatch(
        root,
        root,
        '*** Begin Patch\n*** Add File: new.txt\n+x\n*** Update File: new.txt\n@@\n+y\n*** End Patch',
      ),
    /same path/,
  );
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

test('Claude planning controls and discovery work; plan mode refuses editing delegates', async (t) => {
  const root = fixture(t);
  for (const tool of [
    'ExitPlanMode',
    'EnterPlanMode',
    'TodoWrite',
    'Skill',
    'WebFetch',
    'WebSearch',
  ]) {
    assert.equal(
      (await call(root, 'claude', 'PreToolUse', tool, {}, { permission_mode: 'plan' })).decision,
      undefined,
    );
  }
  for (const tool of ['Task', 'Agent']) {
    assert.equal(
      (await call(root, 'claude', 'PreToolUse', tool, {}, { permission_mode: 'plan' })).decision,
      'deny',
    );
    assert.equal((await call(root, 'claude', 'PreToolUse', tool, {})).decision, undefined);
  }
});

test('hooks outside any repository or configuration make no decision', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-norepo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const harness of ['pi', 'claude', 'codex']) {
    const [tool, input] = writeInput(harness, 'new.txt', 'hello');
    assert.deepEqual(await call(dir, harness, 'PreToolUse', tool, input), {});
    assert.deepEqual(await call(dir, harness, 'SessionStart'), {});
  }
});

test('writes to absolute paths outside the project are left to the harness, even on main and in plan mode', async (t) => {
  const root = fixture(t);
  const outside = mkdtempSync(join(tmpdir(), 'workflow-plans-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
  for (const [tool, input] of [
    ['Write', { file_path: join(outside, 'plan.md'), content: 'plan' }],
    ['write', { path: join(outside, 'memory.md'), content: 'note' }],
  ] as [string, ToolInput][]) {
    assert.equal((await call(root, 'claude', 'PreToolUse', tool, input)).decision, undefined);
    assert.equal(
      (await call(root, 'claude', 'PreToolUse', tool, input, { permission_mode: 'plan' })).decision,
      undefined,
    );
  }
});

test('the workflow runner task commands work on protected branches', async (t) => {
  const root = fixture(t);
  execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
  const runner = `node ${quote(resolve(pluginRoot, 'bin/halvard.ts'))}`;
  for (const command of [
    `${runner} task-start login 'Add login' --author claude --fix`,
    `${runner} task-start login 'Add login' --author codex --small --fix`,
    `${runner} task-resume docs/tasks/task.md`,
    `${runner} review-status docs/tasks/task.md`,
    `${runner} history-plan --harness all`,
    `${runner} history-digest --harness claude`,
    `${runner} retro-events login`,
  ]) {
    assert.equal(
      (await call(root, 'claude', 'PreToolUse', 'Bash', { command })).decision,
      undefined,
      command,
    );
  }
  for (const command of [
    `${runner} task-handoff docs/tasks/task.md --author codex`,
    `${runner} task-start login 'Add login' --author claude --apply`,
    `${runner} task-start login 'Add login' --author claude --fix --fix`,
    `${runner} install-user --apply`,
    `${runner} retro-events login extra`,
    `node other.mjs task-start login 'Add login' --author claude`,
  ]) {
    assert.equal(
      (await call(root, 'claude', 'PreToolUse', 'Bash', { command })).decision,
      'deny',
      command,
    );
  }
  // Starting a task writes files, so a read-only session still refuses it.
  assert.equal(
    (
      await call(
        root,
        'claude',
        'PreToolUse',
        'Bash',
        { command: `${runner} task-start login 'Add login' --author claude` },
        { permission_mode: 'plan' },
      )
    ).decision,
    'deny',
  );
  assert.equal(
    (
      await call(
        root,
        'claude',
        'PreToolUse',
        'Bash',
        { command: `${runner} task-resume docs/tasks/task.md` },
        { permission_mode: 'plan' },
      )
    ).decision,
    undefined,
  );
  assert.equal(
    (
      await call(
        root,
        'claude',
        'PreToolUse',
        'Bash',
        { command: `${runner} history-clean /tmp/plan.json --confirm DELETE` },
        { permission_mode: 'plan' },
      )
    ).decision,
    'deny',
  );
});

test('an agent can leave a protected branch through cd and git -C spellings only', async (t) => {
  const root = fixture(t);
  execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
  const other = mkdtempSync(join(tmpdir(), 'workflow-other-'));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: other });
  const runner = `node ${quote(resolve(pluginRoot, 'bin/halvard.ts'))}`;
  const start = `${runner} task-start login 'Add login' --author claude --fix --small`;
  // The fixture's files are untracked, which a new branch carries along unharmed.
  for (const command of [
    `cd ${quote(root)} && ${start}`,
    `git -C ${quote(root)} switch -c fix/login`,
    `git -C ${quote(root)} checkout -b feature/login`,
  ]) {
    assert.equal(
      (await call(root, 'claude', 'PreToolUse', 'Bash', { command })).decision,
      undefined,
      command,
    );
  }
  for (const command of [
    `cd ${quote(other)} && ${start}`,
    `cd ${quote(root)} && ${start} --apply`,
    `cd ${quote(root)} && touch new.txt`,
    `git -C ${quote(other)} switch -c fix/login`,
    `git -C ${quote(root)} checkout source.txt`,
    `git -C ${quote(root)} commit -m change`,
    `git -C ${quote(root)} switch -c fix/login && touch new.txt`,
  ]) {
    assert.equal(
      (await call(root, 'claude', 'PreToolUse', 'Bash', { command })).decision,
      'deny',
      command,
    );
  }
  assert.equal(
    (await call(root, 'claude', 'PreToolUse', 'Write', { file_path: 'new.txt', content: 'x' }))
      .decision,
    'deny',
  );
});

test('a protected branch allows reads anywhere, writes outside the project and trusted test runs', async (t) => {
  const root = fixture(t, {
    readCommands: [
      {
        prefix: ['uv', 'run', 'pytest'],
        options: { '-q': 'flag' },
        positionals: { min: 0, max: 0 },
      },
    ],
  });
  execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-other-')));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  writeFileSync(join(other, 'SKILL.md'), 'skill\n');
  for (const command of [
    `cd ${quote(other)} && cat SKILL.md`,
    `echo '- [Note](note.md) - hook' >> ${quote(other)}/MEMORY.md`,
    `cd ${quote(realpathSync(root))} && git switch -c fix/login`,
    'uv run pytest -q',
  ]) {
    assert.equal(
      (await call(root, 'claude', 'PreToolUse', 'Bash', { command })).decision,
      undefined,
      command,
    );
  }
  for (const command of [
    `echo note >> ${quote(other)}/MEMORY.md`,
    `cd ${quote(other)} && cat SKILL.md`,
  ]) {
    assert.equal(
      (await call(root, 'pi', 'PreToolUse', 'Bash', { command }, { permission_mode: 'plan' }))
        .decision,
      undefined,
      command,
    );
  }
  symlinkSync(realpathSync(root), join(other, 'into'));
  symlinkSync(join(realpathSync(root), 'docs'), join(other, 'sub'));
  symlinkSync(join(realpathSync(root), 'created.md'), join(other, 'dangling'));
  execFileSync('git', ['init', '-q', join(root, 'vendor')]);
  const workspace = realpathSync(process.env.HALVARD_WORKSPACE!);
  for (const command of [
    'echo note >> source.txt',
    `cd ${quote(other)} | echo note > source.txt`,
    `cd ${quote(other)} && true & echo note > source.txt`,
    `cd ${quote(other)} && git status`,
    'uv run pytest -q --cache-clear',
    `echo note > ${quote(other)}/into/source.txt`,
    `echo note > ${quote(other)}/dangling`,
    `echo note > ${quote(other)}/sub/../source.txt`,
    `echo note > ${quote(workspace)}/login/claude-notes.md`,
    'cd vendor && uv run pytest -q',
  ]) {
    for (const extra of [{}, { permission_mode: 'plan' }]) {
      assert.equal(
        (await call(root, 'claude', 'PreToolUse', 'Bash', { command }, extra)).decision,
        'deny',
        command,
      );
    }
  }
  assert.match(
    (await call(root, 'claude', 'PreToolUse', 'Bash', { command: 'uv run cargoo-graph query x' }))
      .reason!,
    /readCommands/,
  );
});

test('skills that commit stage code by name and ask before including workflow files', () => {
  for (const skill of ['halvard', 'halvard-team']) {
    const text = readFileSync(new URL(`../skills/${skill}/SKILL.md`, import.meta.url), 'utf8');
    for (const required of [
      /stage[^.]*code and tests by name/i,
      /never `git add -A`, `git add \.`/,
      /taskDirectory/,
      /`\.halvard\.json`/,
      /reviewExceptions/,
      /reviewDeferrals/,
    ]) {
      assert.match(text, required, skill);
    }
  }
});

test('a gate inside a pipeline, chain or redirect is refused before it loses its receipt', async (t) => {
  const root = fixture(t);
  execFileSync('git', ['checkout', '-q', '-b', 'feature/gate'], { cwd: root });
  const runner = `node ${quote(resolve(pluginRoot, 'bin/halvard.ts'))}`;
  const gate = `${runner} gate ${sessionKey(root, 'claude', 'test-session')}`;
  for (const command of [
    `${gate} | tail -8`,
    `${gate} 2>&1 | tail -8`,
    `${gate} && echo done`,
    `${gate} > gate.log`,
  ]) {
    const result = await call(root, 'claude', 'PreToolUse', 'Bash', { command });
    assert.equal(result.decision, 'deny', command);
    assert.match(result.reason!, /plain command on its own/, command);
  }
  for (const command of [gate, `${gate} 2>&1`, 'grep -n "halvard.ts gate" docs/usage.md']) {
    const result = await call(root, 'claude', 'PreToolUse', 'Bash', { command });
    assert.doesNotMatch(result.reason ?? '', /plain command on its own/, command);
  }
});

test('history runners work from protected-branch subdirectories without widening other runners', async (t) => {
  for (const harness of ['claude', 'codex', 'pi']) {
    {
      const root = fixture(t);
      execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
      const sub = join(root, 'sub');
      mkdirSync(sub);
      const runner = `node ${quote(resolve(pluginRoot, 'bin/halvard.ts'))}`;
      for (const cwd of [root, sub]) {
        for (const verb of ['history-plan', 'history-digest']) {
          assert.equal(
            (
              await call(
                root,
                harness,
                'PreToolUse',
                'Bash',
                { command: `${runner} ${verb} --harness all` },
                { cwd, permission_mode: 'plan' },
              )
            ).decision,
            undefined,
            `${harness} ${verb} ${cwd}`,
          );
        }
        const command = `${runner} history-clean /tmp/plan.json --confirm DELETE`;
        assert.equal(
          (await call(root, harness, 'PreToolUse', 'Bash', { command }, { cwd })).decision,
          'ask',
          `${harness} ${cwd}`,
        );
        assert.equal(
          (
            await call(
              root,
              harness,
              'PreToolUse',
              'Bash',
              { command },
              { cwd, permission_mode: 'plan' },
            )
          ).decision,
          'deny',
        );
        const previous = process.env.HALVARD_REVIEW;
        process.env.HALVARD_REVIEW = '1';
        try {
          assert.equal(
            (await call(root, harness, 'PreToolUse', 'Bash', { command }, { cwd })).decision,
            'deny',
          );
        } finally {
          if (previous === undefined) {
            delete process.env.HALVARD_REVIEW;
          } else {
            process.env.HALVARD_REVIEW = previous;
          }
        }
      }
      assert.equal(
        (
          await call(
            root,
            harness,
            'PreToolUse',
            'Bash',
            { command: `${runner} setup .` },
            { cwd: sub, permission_mode: 'plan' },
          )
        ).decision,
        'deny',
      );
      assert.equal(
        (
          await call(
            root,
            harness,
            'PreToolUse',
            'Bash',
            { command: `${runner} setup .`, workdir: join(root, 'missing') },
            { permission_mode: 'plan' },
          )
        ).decision,
        'deny',
      );
      const key = sessionKey(root, harness, 'test-session');
      assert.equal(
        (
          await call(
            root,
            harness,
            'PreToolUse',
            'Bash',
            { command: `${runner} gate ${key}` },
            { cwd: sub },
          )
        ).decision,
        'deny',
      );
      assert.equal(
        (await call(root, harness, 'PreToolUse', 'Bash', { command: `${runner} gate ${key}` }))
          .decision,
        undefined,
      );
    }
  }
});

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

test('questions, tool discovery and read-only subagents work in plan mode; any subagent spawns outside it', async (t) => {
  const root = fixture(t);
  execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
  for (const [tool, input] of [
    ['AskUserQuestion', { questions: [] }],
    ['ToolSearch', { query: 'x' }],
    ['Agent', { subagent_type: 'Explore', prompt: 'x' }],
    ['Agent', { subagent_type: 'Plan', prompt: 'x' }],
  ] as [string, ToolInput][]) {
    assert.equal(
      (await call(root, 'claude', 'PreToolUse', tool, input, { permission_mode: 'plan' })).decision,
      undefined,
      tool,
    );
    assert.equal((await call(root, 'claude', 'PreToolUse', tool, input)).decision, undefined, tool);
  }
  const general = { subagent_type: 'general-purpose', prompt: 'x' };
  assert.equal(
    (await call(root, 'claude', 'PreToolUse', 'Agent', general, { permission_mode: 'plan' }))
      .decision,
    'deny',
  );
  // The delegate's own edits still meet the protected-branch guard.
  assert.equal((await call(root, 'claude', 'PreToolUse', 'Agent', general)).decision, undefined);
  execFileSync('git', ['checkout', '-q', '-b', 'feature/other'], { cwd: root });
  assert.equal((await call(root, 'claude', 'PreToolUse', 'Agent', general)).decision, undefined);
});

test('MCP tools pass to host permissions and readOnlyTools patterns are reads', async (t) => {
  const root = fixture(t, { readOnlyTools: ['custom_look*'] });
  execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
  const tool = 'mcp__plugin_example-workspace_azure-devops__repo_pull_request';
  assert.equal(
    (await call(root, 'claude', 'PreToolUse', tool, { repositoryId: 'x' })).decision,
    undefined,
  );
  assert.equal(
    (
      await call(
        root,
        'claude',
        'PreToolUse',
        tool,
        { repositoryId: 'x' },
        { permission_mode: 'plan' },
      )
    ).decision,
    undefined,
  );
  assert.equal((await call(root, 'claude', 'PreToolUse', 'custom_lookup', {})).decision, undefined);
  assert.equal((await call(root, 'claude', 'PreToolUse', 'custom_write', {})).decision, 'deny');
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

test('required bundled skills load and project overrides retain precedence', async (t) => {
  const root = fixture(t, { requiredSkills: ['halvard-test'] });
  // Validating before bundled discovery rejects a required skill shipped with the package.
  for (const harness of ['pi', 'claude', 'codex']) {
    const { context } = await call(root, harness, 'SessionStart');
    assert.match(context!, /Loaded required skill: .*skills\/halvard-test\/SKILL\.md/);
    assert.match(context!, /Choose the interface where real callers observe behavior/);
  }
  mkdirSync(join(root, '.agents/skills/halvard-test'), { recursive: true });
  writeFileSync(
    join(root, '.agents/skills/halvard-test/SKILL.md'),
    '---\nname: halvard-test\ndescription: Project testing\n---\nProject testing override.\n',
  );
  const { context } = await call(root, 'claude', 'SessionStart');
  assert.match(context!, /Project testing override/);
  assert.doesNotMatch(context!, /Choose the interface where real callers observe behavior/);
  const config = JSON.parse(readFileSync(join(root, '.halvard.json'), 'utf8')) as ProjectConfig;
  config.requiredSkills = ['missing-skill'];
  writeFileSync(join(root, '.halvard.json'), JSON.stringify(config));
  await assert.rejects(
    call(root, 'claude', 'SessionStart'),
    /required skill not found: missing-skill/,
  );
});

test('startup context reports defaults when the project configuration is absent', async (t) => {
  const root = fixture(t);
  rmSync(join(root, '.halvard.json'));
  for (const harness of ['pi', 'claude', 'codex']) {
    const { context } = await call(root, harness, 'SessionStart');
    // Unconditionally naming the file sends agents to a nonexistent configuration.
    assert.match(context!, /Project configuration: defaults \(no \.halvard\.json\)/);
    assert.doesNotMatch(context!, /Project configuration: \.halvard\.json\./);
  }
  writeFileSync(join(root, '.halvard.json'), '{"version":1}');
  const { context } = await call(root, 'claude', 'SessionStart');
  assert.match(context!, /Project configuration: \.halvard\.json\./);
});

test('startup context stays inside the native preview and points to the halvard skill', async (t) => {
  const root = fixture(t);
  const { context } = await call(root, 'claude', 'SessionStart');
  assert.ok(
    Buffer.byteLength(context!) < 2000,
    `startup context is ${Buffer.byteLength(context!)} bytes`,
  );
  assert.match(context!, /skills\/halvard\/SKILL\.md/);
  assert.doesNotMatch(context!, /halvard-review/);
  assert.doesNotMatch(context!, /Adapted from Pstack poteto-mode/);
});

test('startup context prints the session review command only when review is required', async (t) => {
  const runner = quote(resolve(pluginRoot, 'bin/halvard.ts'));
  assert.doesNotMatch(
    (await call(fixture(t), 'claude', 'SessionStart')).context!,
    /Run independent review/,
  );
  const root = realpathSync(
    fixture(t, { workflow: { requireReview: true, reviewers: { codex: {} } } }),
  );
  const key = sessionKey(root, 'claude', 'test-session');
  assert.ok(
    (await call(root, 'claude', 'SessionStart')).context!.includes(
      `Run independent review with: node ${runner} review <task-file> --author claude --reviewer <reviewer> --round <n> --gate-session ${key}`,
    ),
  );
  const config = JSON.parse(readFileSync(join(root, '.halvard.json'), 'utf8'));
  writeFileSync(
    join(root, '.halvard.json'),
    JSON.stringify({ ...config, review: ['scripts/review.sh'] }),
  );
  assert.ok(
    (await call(root, 'claude', 'SessionStart')).context!.includes(
      `Run independent review with: REVIEW_GATE_SESSION=${key} HALVARD_RUNNER=${runner} 'scripts/review.sh' <task-file> claude <reviewer> [round]`,
    ),
  );
});

test('startup context names the reviewer assigned to the session harness', async (t) => {
  const root = realpathSync(
    fixture(t, { workflow: { requireReview: true, reviewers: { claude: { reviewer: 'codex' } } } }),
  );
  assert.match(
    (await call(root, 'claude', 'SessionStart')).context!,
    /review <task-file> --author claude --reviewer codex --round <n>/,
  );
  assert.match(
    (await call(root, 'codex', 'SessionStart')).context!,
    /No configured independent reviewer for codex/,
  );
});

test('a review wrapper on a protected branch is recognised only with the session runner', async (t) => {
  const root = realpathSync(
    fixture(t, {
      review: ['scripts/review.sh'],
      workflow: { requireReview: true, reviewers: { codex: {} } },
    }),
  );
  execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
  const key = sessionKey(root, 'claude', 'test-session');
  const wrapper = (runner: string) =>
    call(root, 'claude', 'PreToolUse', 'Bash', {
      command: `REVIEW_GATE_SESSION=${key} ${runner}scripts/review.sh docs/tasks/task.md claude codex 1`,
    });
  const runner = resolve(pluginRoot, 'bin/halvard.ts');
  assert.equal((await wrapper('')).decision, undefined);
  assert.equal((await wrapper(`HALVARD_RUNNER=${quote(runner)} `)).decision, undefined);
  for (const path of ['scripts/review wrapper.sh', "scripts/review's.sh"]) {
    const other = realpathSync(
      fixture(t, {
        review: [path],
        workflow: { requireReview: true, reviewers: { codex: {} } },
      }),
    );
    execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: other });
    const printed = (await call(other, 'claude', 'SessionStart'))
      .context!.match(/Run independent review with: (.+)/)![1]!
      .replace('<task-file>', 'docs/tasks/task.md')
      .replace('<reviewer>', 'codex')
      .replace('[round]', '1');
    assert.equal(
      (await call(other, 'claude', 'PreToolUse', 'Bash', { command: printed })).decision,
      undefined,
      printed,
    );
  }
  for (const other of ['/tmp/halvard.ts', `${runner}x`, '']) {
    assert.equal((await wrapper(`HALVARD_RUNNER=${quote(other)} `)).decision, 'deny', other);
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

test('Herdr team skill is discoverable as a bundled skill without requiredSkills', (t) => {
  const root = fixture(t);
  const team = skills(loadProject(root)).find((skill) => skill.name === 'halvard-team');
  assert.ok(team);
  assert.equal(team.bundled, true);
  assert.match(team.description, /only when the user explicitly asks/);
  assert.match(team.content, /The lead approves teammates' requests by default/);
});

test('Git metadata writes require approval in every harness', async (t) => {
  const root = fixture(t);
  for (const harness of ['pi', 'claude', 'codex']) {
    for (const path of ['.git/config', '.git/hooks/pre-commit']) {
      const [tool, input] = writeInput(harness, path, 'unapproved code');
      assert.equal((await call(root, harness, 'PreToolUse', tool, input)).decision, 'ask');
    }
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

test('a fingerprint past its deadline fails instead of returning a partial hash', (t) => {
  const root = fixture(t);
  assert.throws(() => fingerprint(root, undefined, Date.now() - 1), /too large to verify/);
  assert.equal(fingerprint(root, undefined, Date.now() + 60000), fingerprint(root));
});

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

test('scripts handed to an interpreter by the gate are protected', async (t) => {
  const root = fixture(t, { gate: ['node', 'scripts/check.ts'] });
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts/check.ts'), 'process.exit(0);\n');
  for (const harness of ['pi', 'claude', 'codex']) {
    const [tool, input] = writeInput(harness, 'scripts/check.ts', 'process.exit(0);\n');
    assert.equal((await call(root, harness, 'PreToolUse', tool, input)).decision, 'ask', harness);
    const [other, otherInput] = writeInput(harness, 'scripts/other.ts', 'x');
    assert.equal((await call(root, harness, 'PreToolUse', other, otherInput)).decision, undefined);
  }
});

test('Pi approval covers one exact shipping operation, once', async (t) => {
  const root = fixture(t);
  const shell = { command: 'git push' };
  const first = await call(root, 'pi', 'PreToolUse', 'bash', shell);
  assert.equal(first.decision, 'ask');
  // A session-wide approval is an ordinary prompt and authorizes nothing.
  assert.deepEqual(
    await call(root, 'pi', 'UserPromptSubmit', undefined, undefined, {
      prompt: `approve halvard ${first.request} for this session`,
    }),
    {},
  );
  assert.equal((await call(root, 'pi', 'PreToolUse', 'bash', shell)).decision, 'ask');
  const second = await call(root, 'pi', 'PreToolUse', 'bash', shell);
  await call(root, 'pi', 'UserPromptSubmit', undefined, undefined, {
    prompt: `approve halvard ${second.request}`,
  });
  assert.equal((await call(root, 'pi', 'PreToolUse', 'bash', shell)).decision, undefined);
  assert.equal((await call(root, 'pi', 'PreToolUse', 'bash', shell)).decision, 'ask');
});

for (const harness of ['pi', 'claude', 'codex']) {
  test(`${harness}: dangling symlinks are judged by the file they would create`, async (t) => {
    const root = fixture(t);
    const outside = mkdtempSync(join(tmpdir(), 'workflow-dangling-'));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    mkdirSync(join(root, 'nested'));
    symlinkSync(join(root, 'nested/.halvard.json'), join(outside, 'config-alias'));
    symlinkSync(join(root, '.claude/settings.json'), join(root, 'link.txt'));
    symlinkSync(join(outside, 'escape-target.txt'), join(root, 'escape.txt'));
    for (const path of [join(outside, 'config-alias'), 'link.txt']) {
      const [tool, input] = writeInput(harness, path, 'x');
      assert.equal((await call(root, harness, 'PreToolUse', tool, input)).decision, 'ask', path);
    }
    const [tool, input] = writeInput(harness, 'escape.txt', 'x');
    await assert.rejects(
      call(root, harness, 'PreToolUse', tool, input),
      /outside the project|escapes/,
    );
  });
}

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

test('merging and deleting a merged branch on a protected branch ask instead of deny', async (t) => {
  const root = fixture(t);
  execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
  for (const harness of ['claude', 'codex', 'pi']) {
    for (const command of [
      'git merge --ff-only feature/x',
      'git branch -d feature/x',
      'git branch -d feature/x feature/y fix/z',
    ]) {
      assert.equal(
        (await call(root, harness, 'PreToolUse', 'Bash', { command })).decision,
        'ask',
        `${harness}: ${command}`,
      );
    }
    for (const command of [
      'git branch -D feature/x',
      'git branch -d feature/x -D feature/y',
      'git branch -d -r origin/x',
      'git branch -d feature/x && touch source.txt',
    ]) {
      assert.equal(
        (await call(root, harness, 'PreToolUse', 'Bash', { command })).decision,
        'deny',
        `${harness}: ${command}`,
      );
    }
  }
});

test('a shipping command denied on a protected branch says how to run it', async (t) => {
  const root = fixture(t);
  execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
  const bash = (command: string) => call(root, 'claude', 'PreToolUse', 'Bash', { command });
  assert.equal((await bash('git push origin main')).decision, 'ask');
  for (const command of [
    'git push origin main 2>&1 | tail -5',
    `cd ${root} && git push origin main`,
    'git branch -d feature/x && git branch -d feature/y',
  ]) {
    const result = await bash(command);
    assert.equal(result.decision, 'deny', command);
    assert.match(
      result.reason!,
      /^No work on protected branch main\. Run each shipping command alone and plain, for example git push origin main, without a pipe, chain, cd or redirect; it then asks for approval\.$/,
      command,
    );
  }
  for (const command of [
    'git push "$REMOTE" main',
    'git push origin $(git branch --show-current)',
  ]) {
    const result = await bash(command);
    assert.equal(result.decision, 'deny', command);
    assert.equal(
      result.reason,
      'No work on protected branch main. Run each shipping command alone and plain, for example git push origin main, without a pipe, chain, cd or redirect; it then asks for approval. Write names literally, without variables or substitution.',
      command,
    );
  }
  assert.equal(
    (await bash('touch source.txt')).reason,
    'No work on protected branch main. Create a feature or fix branch first. To trust a test or query command as a read, list it in readCommands.',
  );
});

test('the gate prints one line per step and the failing tail, and logs everything', async (t) => {
  const node = process.execPath;
  const noisy = "for (let i = 0; i < 100; i++) console.log('noisy line ' + i)";
  const failing = "console.log('failing out'); console.error('failing err'); process.exit(3)";
  const root = fixture(t, {
    gate: [
      [node, '-e', noisy],
      [node, '-e', failing],
      [node, '-e', "console.log('never runs')"],
    ],
  });
  const key = sessionKey(root, 'codex', randomUUID());
  const printed: string[] = [];
  t.mock.method(process.stdout, 'write', (text: string) => printed.push(text));
  await assert.rejects(runGate(root, key), /gate failed: checks failed or timed out/);
  t.mock.restoreAll();
  const output = printed.join('');
  const log = output.match(/^workflow: full gate log (.+)$/m)![1]!;
  assert.match(
    log.slice(join(process.env.HALVARD_WORKSPACE!, basename(root)).length),
    new RegExp(`^/gate-${key.slice(0, 12)}-[0-9a-f]{8}\\.log$`),
  );
  assert.equal(
    output,
    [
      'workflow: gate steps',
      output.match(/^  pass  .+ \(\d+\.\ds\)$/m)![0],
      output.match(/^  FAIL  .+ \(exit 3, \d+\.\ds\)$/m)![0],
      `  skip  ${node} -e console.log('never runs')`,
      `workflow: last 40 lines of ${node} -e ${failing}`,
      `$ ${node} -e ${failing}\nfailing out\nfailing err`,
      `workflow: full gate log ${log}`,
      '',
    ].join('\n'),
  );
  assert.ok(output.includes(`  pass  ${node} -e ${noisy} (`));
  assert.doesNotMatch(output, /noisy line \d/);
  const full = readFileSync(log, 'utf8');
  for (let i = 0; i < 100; i++) assert.ok(full.includes(`noisy line ${i}\n`), `line ${i}`);
  assert.match(full, /failing out\nfailing err\n/);
  assert.doesNotMatch(full, /never runs/);
  assert.equal(await withState(realpathSync(root), key, (state) => state.pass), null);
});

test('a passing step-list gate grants the receipt and logs to the task workspace', async (t) => {
  const root = fixture(t, {
    gate: [
      [process.execPath, '-e', "console.log('first')"],
      [process.execPath, '-e', "console.log('second')"],
    ],
  });
  for (const args of [
    ['add', '.'],
    ['commit', '-qm', 'fixture'],
    ['branch', 'main'],
  ]) {
    execFileSync(
      'git',
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
      { cwd: root },
    );
  }
  const started = startTask(root, { id: 'steps', title: 'Steps', author: 'codex' });
  const key = sessionKey(root, 'codex', randomUUID());
  const printed: string[] = [];
  t.mock.method(process.stdout, 'write', (text: string) => printed.push(text));
  await runGate(root, key);
  t.mock.restoreAll();
  const output = printed.join('');
  assert.equal(output.match(/^  pass  /gm)?.length, 2);
  assert.match(output, /\nworkflow: gate passed on the current tree\n$/);
  assert.doesNotMatch(output, /last 40 lines/);
  const log = output.match(/^workflow: full gate log (.+)$/m)![1]!;
  assert.ok(log.startsWith(join(started.workspace, `gate-${key.slice(0, 12)}-`)));
  assert.match(readFileSync(log, 'utf8'), /first\n[^]*second\n/);
  assert.equal(
    (await withState(realpathSync(root), key, (state) => state.pass))?.tree,
    fingerprint(root),
  );
});

test('the gate tail holds the last 40 whole lines however long they are', async (t) => {
  const long =
    "for (let i = 0; i < 50; i++) console.log(i + ':' + 'x'.repeat(8000)); process.exit(1)";
  const root = fixture(t, { gate: [[process.execPath, '-e', long]] });
  const printed: string[] = [];
  t.mock.method(process.stdout, 'write', (text: string) => printed.push(text));
  await assert.rejects(runGate(root, sessionKey(root, 'codex', randomUUID())), /gate failed/);
  t.mock.restoreAll();
  const tail = printed
    .join('')
    .split('\n')
    .filter((line) => /^\d+:x+$/.test(line));
  assert.deepEqual(
    tail.map((line) => line.split(':')[0]),
    Array.from({ length: 40 }, (_, i) => String(i + 10)),
  );
  assert.ok(tail.every((line) => line.length === line.indexOf(':') + 8001));
  // Trailing blank lines and spaces are output too.
  const blank = fixture(t, {
    gate: [
      [
        process.execPath,
        '-e',
        "console.log('keep  '); console.log('\\n'.repeat(38)); process.exit(1)",
      ],
    ],
  });
  const lines: string[] = [];
  t.mock.method(process.stdout, 'write', (text: string) => lines.push(text));
  await assert.rejects(runGate(blank, sessionKey(blank, 'codex', randomUUID())), /gate failed/);
  t.mock.restoreAll();
  assert.ok(lines.join('').includes(`lines of ${process.execPath} -e console.log('keep  ');`));
  assert.ok(lines.join('').includes(`\nkeep  ${'\n'.repeat(39)}\nworkflow: full gate log `));
});

test('overlapping gates keep a log each and an unsafe repository folder is refused', async (t) => {
  const root = fixture(t, {
    gate: [
      [process.execPath, '-e', "console.log('run ' + process.ppid); setTimeout(() => {}, 1500)"],
    ],
  });
  const key = sessionKey(root, 'codex', randomUUID());
  const gate = () =>
    new Promise<string>((done) => {
      const child = spawn(process.execPath, [join(pluginRoot, 'bin/halvard.ts'), 'gate', key], {
        cwd: root,
      });
      let output = '';
      child.stdout.on('data', (bytes: Buffer) => (output += bytes));
      child.on('close', () => done(output));
    });
  const outputs = await Promise.all([gate(), gate()]);
  const logs = outputs.map((output) => output.match(/^workflow: full gate log (.+)$/m)![1]!);
  assert.notEqual(logs[0], logs[1]);
  const runs = logs.map((log) => readFileSync(log, 'utf8').match(/^run (\d+)$/m)![1]);
  assert.notEqual(runs[0], runs[1]);
  const other = fixture(t);
  const elsewhere = mkdtempSync(join(tmpdir(), 'workflow-gate-elsewhere-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  symlinkSync(elsewhere, join(process.env.HALVARD_WORKSPACE!, basename(other)));
  await assert.rejects(runGate(other, sessionKey(other, 'codex', randomUUID())), /unsafe/);
});

test('gate step lists reject empty steps and protect interpreter scripts', (t) => {
  assert.throws(
    () => loadProject(fixture(t, { gate: [['npm', 'test'], []] })),
    /gate step is empty/,
  );
  assert.throws(() => loadProject(fixture(t, { gate: [['npm', 'test'], 'lint'] })), /gate step/);
  const root = fixture(t, {
    gate: [
      ['npm', 'test'],
      [process.execPath, 'check.js'],
    ],
  });
  writeFileSync(join(root, 'check.js'), '');
  assert.deepEqual(loadProject(root).config.gate, [
    ['npm', 'test'],
    [process.execPath, 'check.js'],
  ]);
});

test('Pi shipping on a protected branch gets only one-time approval', async (t) => {
  const root = fixture(t);
  execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
  const push = await call(root, 'pi', 'PreToolUse', 'bash', { command: 'git push' });
  assert.equal(push.decision, 'ask');
  assert.deepEqual(
    await call(root, 'pi', 'UserPromptSubmit', undefined, undefined, {
      prompt: `approve halvard ${push.request} for this session`,
    }),
    {},
  );
  assert.equal(
    (await call(root, 'pi', 'PreToolUse', 'bash', { command: 'git push' })).decision,
    'ask',
  );
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
