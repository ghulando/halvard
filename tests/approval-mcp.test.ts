import './environment.ts';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { approvalServer, dialogBlocked } from '../core/approval-mcp.ts';
import { eventFile, readEvents, repoLogDirectory } from '../core/events.ts';
import { pluginRoot } from '../core/shared/plugin.ts';
import { APPROVAL_TOOL } from '../core/types.ts';
import { hookOutput } from '../core/harnesses/index.ts';
import { call, fixture } from './hook-fixture.ts';

const commit = ['Bash', { command: 'git commit -m "Add notes"' }] as const;

async function asked(root: string, session = 'test-session') {
  const result = await call(root, 'codex', 'PreToolUse', ...commit, { session_id: session });
  assert.equal(result.decision, 'ask');
  return result.request!;
}

type Answer = Record<string, unknown> | 'error' | null;

// A scripted Codex client: it answers each elicitation with `answer`, or never when null.
async function client(
  t: TestContext,
  root: string,
  answer: Answer,
  { elicitation = true, files = [] as string[] } = {},
) {
  const sent: Record<string, unknown>[] = [];
  const replies = new Map<unknown, (value: Record<string, unknown>) => void>();
  let receive: ReturnType<typeof approvalServer>;
  receive = approvalServer({
    write: (message) => {
      sent.push(message as unknown as Record<string, unknown>);
      if (message.method === 'elicitation/create') {
        if (answer === null) return;
        setImmediate(() => {
          void receive(
            answer === 'error'
              ? { jsonrpc: '2.0', id: message.id!, error: { code: -1, message: 'cancelled' } }
              : { jsonrpc: '2.0', id: message.id!, result: answer },
          );
        });
      } else if (message.id !== undefined && replies.has(message.id)) {
        replies.get(message.id)!(message.result ?? {});
      }
    },
    configFiles: () => files,
    answerTimeout: 200,
  });
  let next = 0;
  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = ++next;
      replies.set(id, resolve);
      void receive({ jsonrpc: '2.0', id, method, params });
    });
  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: elicitation ? { elicitation: {} } : {},
    clientInfo: { name: 'test' },
  });
  void t;
  const tool = async (
    args: Record<string, unknown>,
    meta: Record<string, unknown> = { sessionId: 'test-session' },
  ) => {
    const result = await request('tools/call', {
      name: APPROVAL_TOOL,
      arguments: args,
      _meta: meta,
    });
    return {
      text: (result.content as { text: string }[])[0]!.text,
      error: result.isError === true,
    };
  };
  return { tool, sent, request };
}

const outcomes = (root: string) =>
  readEvents(eventFile(repoLogDirectory(root), null)).filter((event) => event.kind === 'outcome');

test('the Codex denial names the dialog tool and keeps the text approval', async (t) => {
  const root = fixture(t);
  const result = await call(root, 'codex', 'PreToolUse', ...commit);
  const output = hookOutput('codex', 'PreToolUse', result).hookSpecificOutput!;
  assert.equal(output.permissionDecision, 'deny');
  assert.match(output.permissionDecisionReason!, new RegExp(`call the ${APPROVAL_TOOL} tool`));
  assert.match(output.permissionDecisionReason!, /approve halvard [a-f0-9]{64}/);
  // Claude still gets its native ask with the text approval only.
  const claude = hookOutput('claude', 'PreToolUse', result).hookSpecificOutput!;
  assert.equal(claude.permissionDecision, 'ask');
  assert.doesNotMatch(claude.permissionDecisionReason!, new RegExp(APPROVAL_TOOL));
});

test('Approve once in the dialog allows exactly one matching operation', async (t) => {
  const root = fixture(t);
  const id = await asked(root);
  const { tool, sent } = await client(t, root, {
    action: 'accept',
    content: { decision: 'approve_once' },
  });
  const result = await tool({ request: id }, { sessionId: 'test-session' });
  assert.equal(result.error, false, result.text);
  assert.match(result.text, /approved request .* once/);
  // The dialog showed the repository and the exact operation from Halvard's own state.
  const dialog = sent.find((message) => message.method === 'elicitation/create')!;
  const params = dialog.params as { message: string; requestedSchema: Record<string, unknown> };
  assert.match(
    params.message,
    new RegExp(`Repository: ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  );
  assert.match(params.message, /git commit -m "Add notes"/);
  assert.deepEqual((params.requestedSchema as { required: string[] }).required, ['decision']);
  // A different command is not covered.
  const other = await call(root, 'codex', 'PreToolUse', 'Bash', { command: 'git push' });
  assert.equal(other.decision, 'ask');
  // The approval above was for the commit, whose request the push replaced.
  const id2 = await asked(root);
  const again = await client(t, root, { action: 'accept', content: { decision: 'approve_once' } });
  assert.equal((await again.tool({ request: id2 })).error, false);
  assert.equal((await call(root, 'codex', 'PreToolUse', ...commit)).decision, undefined);
  // Single use: the same operation asks again.
  assert.equal((await call(root, 'codex', 'PreToolUse', ...commit)).decision, 'ask');
  assert.ok(
    outcomes(root).some(
      (event) => event.via === 'codex-elicitation' && event.outcome === 'approved',
    ),
  );
  // The log holds a request digest prefix, never the command.
  assert.doesNotMatch(JSON.stringify(outcomes(root)), /git commit/);
});

for (const [name, answer, logged] of [
  ['Reject', { action: 'accept', content: { decision: 'reject' } }, 'rejected'],
  ['decline', { action: 'decline' }, 'declined'],
  ['cancel', { action: 'cancel' }, 'cancelled'],
  ['an empty accept', { action: 'accept', content: {} }, 'cancelled'],
  ['an accept without content', { action: 'accept' }, 'cancelled'],
  ['an unexpected value', { action: 'accept', content: { decision: 'approve' } }, 'cancelled'],
  // No answer is not the user's: nothing is logged, and the outcome stays unknown.
  ['a client error', 'error', undefined],
  ['no answer', null, undefined],
] as const) {
  test(`${name} in the dialog leaves the operation blocked`, async (t) => {
    const root = fixture(t);
    const id = await asked(root);
    const { tool } = await client(t, root, answer as Answer);
    const result = await tool({ request: id });
    assert.equal(result.error, true);
    assert.equal((await call(root, 'codex', 'PreToolUse', ...commit)).decision, 'ask');
    assert.equal(outcomes(root).at(-1)?.outcome, logged);
  });
}

test('without a dialog the tool falls back to the text approval and approves nothing', async (t) => {
  const root = fixture(t);
  const id = await asked(root);
  const dir = mkdtempSync(join(tmpdir(), 'codex-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const never = join(dir, 'never.toml');
  writeFileSync(never, 'approval_policy = "never"\n');
  const guardian = join(dir, 'guardian.toml');
  writeFileSync(guardian, 'approvals_reviewer = "guardian_subagent"\n');
  for (const options of [{ elicitation: false }, { files: [never] }, { files: [guardian] }]) {
    const { tool, sent } = await client(
      t,
      root,
      { action: 'accept', content: { decision: 'approve_once' } },
      options,
    );
    // Arguments that claim approval are ignored.
    const result = await tool({ request: id, approved: true, decision: 'approve_once' });
    assert.equal(result.error, true);
    assert.match(result.text, new RegExp(`approve halvard ${id}`));
    assert.equal(sent.filter((message) => message.method === 'elicitation/create').length, 0);
    assert.equal((await call(root, 'codex', 'PreToolUse', ...commit)).decision, 'ask');
  }
  // The text approval still works.
  const { context } = await call(root, 'codex', 'UserPromptSubmit', undefined, undefined, {
    prompt: `approve halvard ${id}`,
  });
  assert.match(context!, /Approved workflow request/);
  assert.equal((await call(root, 'codex', 'PreToolUse', ...commit)).decision, undefined);
});

test('dialogBlocked ignores comments and reads both config files', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'a.toml');
  writeFileSync(file, '# approval_policy = "never"\napproval_policy = "on-request"\n');
  assert.equal(dialogBlocked([file, join(dir, 'missing.toml')]), null);
  writeFileSync(file, "approval_policy = 'never' # quiet\n");
  assert.match(dialogBlocked([file])!, /never/);
});

test('a request from another session, an unknown id or a changed tree is not approved', async (t) => {
  const root = fixture(t);
  const id = await asked(root);
  const approveOnce = { action: 'accept', content: { decision: 'approve_once' } };
  const { tool, sent } = await client(t, root, approveOnce);
  const wrong = await tool({ request: id }, { sessionId: 'another-session' });
  assert.equal(wrong.error, true);
  assert.match(wrong.text, /another session/);
  assert.equal(sent.filter((message) => message.method === 'elicitation/create').length, 0);
  const unknown = await tool({ request: 'f'.repeat(64) });
  assert.match(unknown.text, /No Halvard request/);
  assert.equal((await tool({ request: 'not-an-id' })).error, true);
  // The tree changes while the dialog is open: the answer no longer applies.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let receive: ReturnType<typeof approvalServer>;
  receive = approvalServer({
    write: (message) => {
      if (message.method === 'elicitation/create') {
        writeFileSync(join(root, 'source.txt'), 'changed\n');
        void receive({ jsonrpc: '2.0', id: message.id!, result: approveOnce });
      } else if (message.id === 2) {
        const text = (message.result!.content as { text: string }[])[0]!.text;
        assert.match(text, /stale/);
        release();
      }
    },
    configFiles: () => [],
  });
  await receive({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { capabilities: { elicitation: {} } },
  });
  await receive({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: APPROVAL_TOOL,
      arguments: { request: id },
      _meta: { sessionId: 'test-session' },
    },
  });
  await gate;
  assert.equal((await call(root, 'codex', 'PreToolUse', ...commit)).decision, 'ask');
});

test('an expired request shows no dialog', async (t) => {
  const root = fixture(t);
  const id = await asked(root);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 11 * 60 * 1000 });
  const { tool, sent } = await client(t, root, {
    action: 'accept',
    content: { decision: 'approve_once' },
  });
  const result = await tool({ request: id });
  assert.match(result.text, /expired/);
  assert.equal(sent.filter((message) => message.method === 'elicitation/create').length, 0);
});

test('the MCP server answers over real stdio and its approval reaches the hook', async (t) => {
  const root = fixture(t);
  const id = await asked(root);
  const codexHome = mkdtempSync(join(tmpdir(), 'codex-home-'));
  t.after(() => rmSync(codexHome, { recursive: true, force: true }));
  const child = spawn(process.execPath, [join(pluginRoot, 'bin/approval-mcp.ts')], {
    cwd: pluginRoot,
    env: { ...process.env, CODEX_HOME: codexHome, HALVARD_APPROVAL_HOST: 'codex' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
  const read = async () =>
    JSON.parse((await lines.next()).value as string) as Record<string, unknown>;
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} } },
  });
  assert.equal(
    ((await read()).result as { serverInfo: { name: string } }).serverInfo.name,
    'halvard',
  );
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const listed = (await read()).result as { tools: { name: string }[] };
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    [APPROVAL_TOOL],
  );
  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: APPROVAL_TOOL,
      arguments: { request: id },
      _meta: { sessionId: 'test-session' },
    },
  });
  const elicit = await read();
  assert.equal(elicit.method, 'elicitation/create');
  send({
    jsonrpc: '2.0',
    id: elicit.id,
    result: { action: 'accept', content: { decision: 'approve_once' } },
  });
  const done = await read();
  assert.equal(done.id, 3);
  assert.match((done.result as { content: { text: string }[] }).content[0]!.text, /approved/);
  assert.equal((await call(root, 'codex', 'PreToolUse', ...commit)).decision, undefined);
  assert.equal((await call(root, 'codex', 'PreToolUse', ...commit)).decision, 'ask');
});

test('without a calling session the tool shows nothing and falls back to text', async (t) => {
  const root = fixture(t);
  const id = await asked(root);
  const { tool, sent } = await client(t, root, {
    action: 'accept',
    content: { decision: 'approve_once' },
  });
  const result = await tool({ request: id }, {});
  assert.equal(result.error, true);
  assert.match(result.text, /did not say which session/);
  assert.match(result.text, new RegExp(`approve halvard ${id}`));
  assert.equal(sent.filter((message) => message.method === 'elicitation/create').length, 0);
  assert.equal((await call(root, 'codex', 'PreToolUse', ...commit)).decision, 'ask');
});

test('an agent cannot start the approval server or import the approval module', async (t) => {
  const root = fixture(t);
  const server = join(pluginRoot, 'bin/approval-mcp.ts');
  for (const command of [
    `node ${server} < /tmp/in.jsonl`,
    `(printf x; sleep 1) | node ${server}`,
    `HALVARD_APPROVAL_HOST=codex node ${server}`,
    `node -e "import('${join(pluginRoot, 'core/approval.ts')}').then((m) => m.approve())"`,
    `${server}`,
  ]) {
    const result = await call(root, 'codex', 'PreToolUse', 'Bash', { command });
    assert.equal(result.decision, 'deny', command);
    assert.match(result.reason!, /Only Codex starts/);
  }
  const typed = await call(root, 'codex', 'PreToolUse', 'write_stdin', {
    session_id: 1,
    chars: `node ${server}\n`,
  });
  assert.equal(typed.decision, 'deny');
  // Reading the source, and a project's own approval code, stay allowed.
  for (const command of [
    `cat ${server}`,
    `rg approve ${join(pluginRoot, 'core/approval.ts')}`,
    'npx vitest run src/approval',
    'node src/approval.js',
    'bash scripts/check-approval.sh',
    './approval',
  ]) {
    assert.equal(
      (await call(root, 'codex', 'PreToolUse', 'Bash', { command })).decision,
      undefined,
      command,
    );
  }
  // Started without the plugin's launch marker, the server refuses to run.
  const child = spawn(process.execPath, [server], {
    env: { ...process.env, HALVARD_APPROVAL_HOST: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 1);
  assert.match(stderr, /only from the Codex plugin/);
});
