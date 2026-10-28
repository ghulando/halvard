import type { ToolInput } from '../core/types.ts';
import './environment.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runGate } from '../core/workflow/gate.ts';
import { sessionKey } from '../core/state.ts';
import { fixture, call, writeInput } from './hook-fixture.ts';

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
