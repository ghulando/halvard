import type { TestContext } from 'node:test';
import type { NativeHookOutput } from '../core/types.ts';
import './environment.ts';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { HARNESSES } from '../core/types.ts';
import { providers } from '../core/config/reviewers.ts';
import { historyHarnesses } from '../core/workflow/clean-history.ts';
import { driver, drivers, hostHarness, toHookPayload } from '../core/harnesses/index.ts';
import { canonicalTool } from '../core/harnesses/tool-input.ts';

const hook = fileURLToPath(new URL('../bin/hook.ts', import.meta.url));
const runner = fileURLToPath(new URL('../bin/halvard.ts', import.meta.url));

// A repository on a feature branch, or on main when branch is null.
function repo(t: TestContext, branch: string | null = 'feature/hosts') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-hosts-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root });
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(root, '.halvard.json'), '{"version":1}\n');
  writeFileSync(join(root, 'source.txt'), 'original\n');
  mkdirSync(join(root, 'docs/tasks'), { recursive: true });
  writeFileSync(join(root, 'docs/tasks/example.md'), '**Status:** active.\n');
  git('add', '.');
  git('commit', '-q', '-m', 'initial');
  if (branch) git('checkout', '-q', '-b', branch);
  return root;
}

function run(harness: string, payload: unknown, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [hook, harness], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, GROK_HOOK_EVENT: '', ...env },
  });
  return {
    status: result.status,
    stderr: result.stderr,
    output: (result.stdout ? JSON.parse(result.stdout) : null) as NativeHookOutput | null,
  };
}

const grok = (root: string, extra: Record<string, unknown>) => ({
  hookEventName: 'pre_tool_use',
  hook_event_name: 'PreToolUse',
  sessionId: 'grok-session',
  cwd: root,
  workspaceRoot: root,
  permissionMode: 'default',
  ...extra,
});

const cursor = (root: string, extra: Record<string, unknown>) => ({
  conversation_id: 'cursor-conversation',
  generation_id: 'generation',
  cursor_version: '2.4.0',
  workspace_roots: [root],
  ...extra,
});

const GROK_ENV = { GROK_HOOK_EVENT: 'pre_tool_use' };

test('Grok and Cursor tool names map onto the engine tools', () => {
  assert.deepEqual(canonicalTool('run_terminal_command', { command: 'ls', cwd: 'src' }), [
    'Bash',
    { command: 'ls', cwd: 'src' },
  ]);
  assert.deepEqual(canonicalTool('Shell', { command: 'ls' }), ['Bash', { command: 'ls' }]);
  assert.equal(canonicalTool('read_file', { path: 'a' })[0], 'Read');
  assert.deepEqual(canonicalTool('search_replace', { path: 'a', old_str: 'x', new_str: 'y' }), [
    'Edit',
    { file_path: 'a', old_string: 'x', new_string: 'y', content: undefined },
  ]);
  // An empty old string creates the file.
  assert.deepEqual(
    canonicalTool('search_replace', { path: 'a', old_string: '', new_string: 'y' }),
    ['Write', { file_path: 'a', content: 'y' }],
  );
  assert.deepEqual(canonicalTool('Write', { file_path: 'a', contents: 'z' })[0], 'Write');
  assert.deepEqual(canonicalTool('edit_file', { target_file: 'a', code_edit: '...' }), [
    'OpaqueEdit',
    { file_path: 'a' },
  ]);
  assert.deepEqual(canonicalTool('Delete', { path: 'a' }), ['OpaqueEdit', { file_path: 'a' }]);
  assert.deepEqual(canonicalTool('spawn_subagent', { subagentType: 'Explore' }), [
    'Task',
    { subagent_type: 'Explore' },
  ]);
  assert.deepEqual(canonicalTool('mcp__server__tool', { a: 1 }), ['mcp__server__tool', { a: 1 }]);
});

test('the host is read from the Grok environment or the Cursor payload', () => {
  assert.equal(hostHarness({ cwd: '/' }, { GROK_HOOK_EVENT: 'pre_tool_use' }), 'grok');
  assert.equal(hostHarness(cursor('/', {}), {}), 'cursor');
  assert.equal(hostHarness({ cwd: '/', session_id: 'x', transcript_path: '/t' }, {}), null);
  // Cursor's preToolUse leaves shell commands to beforeShellExecution.
  assert.equal(
    toHookPayload(
      'cursor',
      cursor('/', { hook_event_name: 'preToolUse', tool_name: 'Shell', tool_input: {} }),
    ),
    null,
  );
  assert.equal(toHookPayload('cursor', cursor('/', { hook_event_name: 'stop' })), null);
});

test('Grok: an edit on main is denied in the Claude-shaped output Grok reads', (t) => {
  const root = repo(t, null);
  const payload = grok(root, {
    toolName: 'search_replace',
    toolInput: { path: 'source.txt', old_string: 'original', new_string: 'changed' },
    toolUseId: 'call-1',
  });
  for (const entry of ['grok', 'claude', 'cursor']) {
    // Grok runs Halvard's Claude and Cursor entries too; each guards as Grok.
    const result = run(entry, payload, GROK_ENV);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output!.hookSpecificOutput!.permissionDecision, 'deny', entry);
  }
});

test('Grok: a protected edit asks natively and duplicate entries do not ask twice', (t) => {
  const root = repo(t);
  const edit = (call: string) =>
    grok(root, {
      toolName: 'search_replace',
      toolInput: { path: '.halvard.json', old_string: '"version":1', new_string: '"version": 1' },
      toolUseId: call,
    });
  const asked = run('grok', edit('call-1'), GROK_ENV);
  const decision = asked.output!.hookSpecificOutput!;
  assert.equal(decision.permissionDecision, 'ask');
  const id = decision.permissionDecisionReason!.match(/approve halvard ([a-f0-9]{64})/)![1]!;
  const approved = run(
    'grok',
    grok(root, {
      hookEventName: 'user_prompt_submit',
      hook_event_name: 'UserPromptSubmit',
      prompt: `approve halvard ${id}`,
    }),
    GROK_ENV,
  );
  assert.match(approved.output!.hookSpecificOutput!.additionalContext!, /Approved/);
  // The Grok entry and the Claude entry both see the approved call.
  assert.deepEqual(run('grok', edit('call-1'), GROK_ENV).output, {});
  assert.deepEqual(run('claude', edit('call-1'), GROK_ENV).output, {});
  // The approval is spent: another call asks again.
  assert.equal(
    run('grok', edit('call-2'), GROK_ENV).output!.hookSpecificOutput!.permissionDecision,
    'ask',
  );
});

test('Cursor: shell mutations on main are denied and other entries stay quiet', (t) => {
  const root = repo(t, null);
  const shell = cursor(root, {
    hook_event_name: 'beforeShellExecution',
    command: 'touch new.txt',
    cwd: root,
  });
  const denied = run('cursor', shell);
  assert.equal(denied.status, 0, denied.stderr);
  assert.equal(denied.output!.permission, 'deny');
  assert.match(denied.output!.agent_message!, /protected branch main/);
  // Halvard's Claude entry, loaded by Cursor as a third-party hook, leaves it to Cursor's.
  assert.deepEqual(run('claude', shell).output, {});
  // preToolUse leaves the shell call to beforeShellExecution.
  assert.deepEqual(
    run(
      'cursor',
      cursor(root, {
        hook_event_name: 'preToolUse',
        tool_name: 'Shell',
        tool_input: { command: 'touch new.txt' },
      }),
    ).output,
    {},
  );
});

test('Cursor: an ask becomes a denial approved from the terminal, once', (t) => {
  const root = repo(t);
  const edit = cursor(root, {
    hook_event_name: 'preToolUse',
    tool_name: 'Write',
    tool_input: { file_path: '.halvard.json', content: '{"version": 1}\n' },
  });
  const denied = run('cursor', edit).output!;
  assert.equal(denied.permission, 'deny');
  const [, key, id] = denied.user_message!.match(/ approve ([a-f0-9]{64}) ([a-f0-9]{64})/)!;
  // The agent cannot approve its own request.
  const agent = run(
    'cursor',
    cursor(root, {
      hook_event_name: 'beforeShellExecution',
      command: `node ${runner} approve ${key} ${id}`,
      cwd: root,
    }),
  ).output!;
  assert.equal(agent.permission, 'deny');
  assert.match(agent.agent_message!, /Only the user approves/);
  const approve = spawnSync(process.execPath, [runner, 'approve', key!, id!], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(approve.status, 0, approve.stderr);
  assert.match(approve.stdout, /Approved workflow request/);
  assert.deepEqual(run('cursor', edit).output, {});
  assert.equal(run('cursor', edit).output!.permission, 'deny');
  // A request that is not pending is refused.
  const stale = spawnSync(process.execPath, [runner, 'approve', key!, 'f'.repeat(64)], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /missing, stale or expired/);
});

test('Cursor: an edit without exact text is checked by path and refused on task files', (t) => {
  const root = repo(t);
  const opaque = (file: string) =>
    cursor(root, {
      hook_event_name: 'preToolUse',
      tool_name: 'edit_file',
      tool_input: { target_file: file, code_edit: '// ... existing code ...' },
    });
  assert.deepEqual(run('cursor', opaque('source.txt')).output, {});
  assert.equal(run('cursor', opaque('.halvard.json')).output!.permission, 'deny');
  const task = run('cursor', opaque('docs/tasks/example.md'));
  assert.equal(task.status, 2);
  assert.match(task.stderr, /exact replacement/);
});

test('Cursor: session start gives the workflow context', (t) => {
  const root = repo(t);
  const result = run('cursor', cursor(root, { hook_event_name: 'sessionStart' }));
  assert.match(result.output!.additional_context!, /skills\/halvard\/SKILL\.md/);
});

test('the Grok manifest names its own hooks and the Cursor hooks fail closed', (t) => {
  const manifest = JSON.parse(
    readFileSync(new URL('../.grok-plugin/plugin.json', import.meta.url), 'utf8'),
  ) as { hooks: string };
  assert.equal(manifest.hooks, './hooks/grok.json');
  const root = mkdtempSync(join(tmpdir(), 'workflow-stale-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const grokHooks = JSON.parse(
    readFileSync(new URL('../hooks/grok.json', import.meta.url), 'utf8'),
  ) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
  const cursorHooks = JSON.parse(
    readFileSync(new URL('../hooks/cursor.json', import.meta.url), 'utf8'),
  ) as { hooks: Record<string, { command: string; failClosed?: boolean }[]> };
  const commands = [
    ...['PreToolUse', 'PostToolUse'].map((event) => ({
      command: grokHooks.hooks[event]![0]!.hooks[0]!.command,
      variable: 'GROK_PLUGIN_ROOT',
    })),
    ...['preToolUse', 'beforeShellExecution'].map((event) => {
      assert.equal(cursorHooks.hooks[event]![0]!.failClosed, true);
      return { command: cursorHooks.hooks[event]![0]!.command, variable: 'HALVARD_ROOT' };
    }),
  ];
  for (const { command, variable } of commands) {
    const stale = spawnSync('sh', ['-c', command], {
      input: '{}',
      encoding: 'utf8',
      env: { ...process.env, [variable]: join(root, 'deleted') },
    });
    assert.equal(stale.status, 2, command);
    assert.match(stale.stderr, /hook is missing/);
  }
});

test('Cursor: the prompt hook continues and a JSON-string tool input is read', (t) => {
  const root = repo(t, null);
  assert.deepEqual(
    run('cursor', cursor(root, { hook_event_name: 'beforeSubmitPrompt', prompt: 'hello' })).output,
    { continue: true },
  );
  const write = run(
    'cursor',
    cursor(root, {
      hook_event_name: 'preToolUse',
      tool_name: 'Write',
      tool_input: JSON.stringify({ file_path: 'source.txt', content: 'changed' }),
    }),
  ).output!;
  assert.equal(write.permission, 'deny');
  assert.match(write.agent_message!, /protected branch main/);
});

test('a commit message that names the approve command still asks as shipping', (t) => {
  const root = repo(t);
  const result = run(
    'cursor',
    cursor(root, {
      hook_event_name: 'beforeShellExecution',
      command: 'git commit -m "Add halvard approve"',
      cwd: root,
    }),
  ).output!;
  assert.match(result.agent_message!, /commits, merges, pushes or publishes/);
});

test('every harness and review provider has a driver', () => {
  for (const name of HARNESSES) {
    assert.ok(driver(name)?.hooks && driver(name)?.agent, `${name} has no hook or agent driver`);
  }
  for (const name of providers) assert.ok(driver(name)?.review, `${name} has no review driver`);
  for (const name of historyHarnesses('all')) {
    assert.ok(driver(name)?.history, `${name} has no history driver`);
  }
  assert.equal(new Set(drivers.map((entry) => entry.name)).size, drivers.length);
});
