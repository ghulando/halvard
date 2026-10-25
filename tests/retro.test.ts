import './environment.ts';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { retroEvents } from '../core/workflow/retro.ts';

const request = 'a'.repeat(64);
const protectedBranch = 'No work on protected branch main. Create a feature or fix branch first.';
const shipping =
  'This command commits, merges, pushes or publishes. Review the exact command before approving.';

function fixture(t: TestContext) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'retro-home-')));
  const root = join(home, 'repo');
  mkdirSync(root);
  execFileSync('git', ['init', '-q', '--initial-branch=feature/demo'], { cwd: root });
  writeFileSync(join(root, '.halvard.json'), JSON.stringify({ version: 1 }));
  const keys = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PI_CODING_AGENT_DIR', 'HALVARD_WORKSPACE'];
  const previous = keys.map((key) => process.env[key]);
  const values = ['.claude', '.codex', '.pi/agent', '.halvard'].map((dir) => join(home, dir));
  keys.forEach((key, i) => (process.env[key] = values[i]));
  t.after(() => {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[i];
      }
    });
    rmSync(home, { recursive: true, force: true });
  });
  const put = (path: string, content: string, mtime?: number) => {
    const file = join(home, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    if (mtime) utimesSync(file, mtime / 1000, mtime / 1000);
    return file;
  };
  const jsonl = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join('\n');
  // The task ran from 30 to 20 minutes ago; the window reaches 40 minutes back and 40 ahead.
  const start = Date.now() - 30 * 60 * 1000;
  const at = (minutes: number) => new Date(start + minutes * 60 * 1000).toISOString();
  const task = `.halvard/${basename(root)}/demo`;
  put(`${task}/.repo`, root + '\n', start);
  put(`${task}/codex-report.md`, 'report', start + 10 * 60 * 1000);
  return { root, put, jsonl, at, task };
}

test('retro counts each harness hook denial and ignores the same text elsewhere', async (t) => {
  const { root, put, jsonl, at } = fixture(t);
  const claude = (content: unknown, timestamp: string, extra = {}) => ({
    type: 'user',
    sessionId: 'claude-1',
    cwd: join(root, 'src'),
    timestamp,
    message: { role: 'user', content },
    ...extra,
  });
  const result = (text: string) => [{ type: 'tool_result', content: text, is_error: true }];
  put(
    '.claude/projects/repo/claude-1.jsonl',
    jsonl([
      claude(result(`PreToolUse:Bash hook error: ${protectedBranch}`), at(1)),
      claude(
        [
          {
            type: 'tool_result',
            content: [{ type: 'text', text: `PreToolUse:Write hook error: ${protectedBranch}` }],
            is_error: true,
          },
        ],
        at(2),
      ),
      // A grep of the source, a successful command that prints the denial line and an
      // assistant quote carry the reason without being denials.
      claude(result(`core/policy.ts:27: PreToolUse:Bash hook error: ${protectedBranch}`), at(3)),
      claude(
        [
          {
            type: 'tool_result',
            content: `PreToolUse:Bash hook error: ${protectedBranch}`,
            is_error: false,
          },
        ],
        at(3),
      ),
      {
        type: 'assistant',
        sessionId: 'claude-1',
        cwd: root,
        timestamp: at(3),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `PreToolUse:Bash hook error: ${protectedBranch}` }],
        },
      },
      claude(`approve halvard ${request}`, at(4)),
      claude(result('workflow: gate passed on the current tree\n'), at(5)),
      claude(
        result(
          'Exit code 1\nhalvard: gate failed: checks failed or timed out; fix the cause and rerun',
        ),
        at(6),
      ),
      // Text after the failure marker that runGate never prints is reported only as other.
      claude(result('halvard: gate failed: secret customer text'), at(6)),
      // Outside the repository and outside the window.
      claude(result(`PreToolUse:Bash hook error: ${protectedBranch}`), at(7), {
        cwd: '/elsewhere',
      }),
      claude(result(`PreToolUse:Bash hook error: ${protectedBranch}`), at(-60)),
      claude(result(`PreToolUse:Bash hook error: ${protectedBranch}`), at(90)),
    ]),
  );
  const codexOutput = (text: string, timestamp: string) => ({
    type: 'response_item',
    timestamp,
    payload: { type: 'custom_tool_call_output', output: [{ type: 'input_text', text }] },
  });
  put(
    '.codex/sessions/2026/rollout-codex-1.jsonl',
    jsonl([
      { type: 'session_meta', timestamp: at(0), payload: { id: 'codex-1', cwd: root } },
      codexOutput(
        `Script error:\nCommand blocked by PreToolUse hook: ${shipping}\nTo approve this one operation, send exactly: approve halvard ${request}. Command: git push https://secret-token@example.invalid`,
        at(2),
      ),
      codexOutput(
        JSON.stringify({
          i: 0,
          status: 'rejected',
          reason: `Command blocked by PreToolUse hook: ${protectedBranch}. Command: rm private.txt`,
        }),
        at(3),
      ),
      codexOutput(
        JSON.stringify({ output: 'ok\nworkflow: gate passed on the current tree\n' }),
        at(4),
      ),
      // Command output that prints a denial, plain or inside the result envelope, is not one.
      codexOutput(
        `Script completed\nOutput:\nCommand blocked by PreToolUse hook: ${protectedBranch}`,
        at(5),
      ),
      codexOutput(
        JSON.stringify({
          exit_code: 0,
          output: `Command blocked by PreToolUse hook: ${protectedBranch}. Command: x`,
        }),
        at(5),
      ),
      codexOutput(
        JSON.stringify({
          output: JSON.stringify({
            status: 'rejected',
            reason: `Command blocked by PreToolUse hook: ${protectedBranch}`,
          }),
        }),
        at(5),
      ),
      codexOutput(
        JSON.stringify({
          exit_code: 0,
          output: {
            status: 'rejected',
            reason: 'Command blocked by PreToolUse hook: nested customer text',
          },
        }),
        at(5),
      ),
      // A blocked command never ran, so gate markers inside it are not gate results.
      codexOutput(
        `Script error:\nCommand blocked by PreToolUse hook: ${protectedBranch}. Command: printf '%s\\n' x\nworkflow: gate passed on the current tree\nhalvard: gate failed: checks failed or timed out`,
        at(5),
      ),
      codexOutput(
        JSON.stringify({
          status: 'rejected',
          reason: `Command blocked by PreToolUse hook: ${protectedBranch}. Command: printf x\nworkflow: gate passed on the current tree\nhalvard: gate failed: checks failed or timed out`,
        }),
        at(5),
      ),
      // A parallel call reports each rejected entry in a top-level array.
      codexOutput(
        JSON.stringify([
          { i: 0, status: 'fulfilled', value: { exit_code: 0, output: '' } },
          {
            i: 1,
            status: 'rejected',
            reason: `Command blocked by PreToolUse hook: ${protectedBranch}. Command: ls`,
          },
        ]),
        at(5),
      ),
      {
        type: 'response_item',
        timestamp: at(5),
        payload: {
          type: 'function_call_output',
          output: `Command blocked by PreToolUse hook: ${protectedBranch}`,
        },
      },
      {
        type: 'event_msg',
        timestamp: at(6),
        payload: { type: 'user_message', message: `approve halvard ${request}` },
      },
    ]),
  );
  const pi = (text: string, isError: boolean, timestamp: string) => ({
    type: 'message',
    timestamp,
    message: { role: 'toolResult', content: [{ type: 'text', text }], isError },
  });
  put(
    '.pi/agent/sessions/--repo--/pi-1.jsonl',
    jsonl([
      { type: 'session', id: 'pi-1', timestamp: at(0), cwd: root },
      pi(`halvard blocked: ${protectedBranch}`, true, at(1)),
      pi(`halvard blocked: ${shipping}\nSend: approve halvard ${request}`, true, at(2)),
      pi(`halvard blocked: ${protectedBranch}`, false, at(3)),
      pi(protectedBranch, true, at(4)),
    ]),
  );
  const retro = await retroEvents(root, 'demo');
  const empty = { denials: [], asks: [], approvals: 0, gatePasses: 0, gateFailures: [] };
  assert.deepEqual(retro.events, {
    claude: {
      ...empty,
      sessions: ['claude-1'],
      denials: [{ reason: protectedBranch, count: 2 }],
      approvals: 1,
      gatePasses: 1,
      gateFailures: [
        { reason: 'checks failed or timed out', count: 1 },
        { reason: 'other', count: 1 },
      ],
    },
    codex: {
      ...empty,
      sessions: ['codex-1'],
      denials: [{ reason: protectedBranch, count: 4 }],
      asks: [{ reason: shipping, count: 1 }],
      approvals: 1,
      gatePasses: 1,
    },
    pi: {
      ...empty,
      sessions: ['pi-1'],
      denials: [{ reason: protectedBranch, count: 1 }],
      asks: [{ reason: shipping, count: 1 }],
    },
  });
  const output = JSON.stringify(retro);
  for (const leak of [
    'secret-token',
    'private.txt',
    'secret customer text',
    'nested customer text',
  ]) {
    assert.equal(output.includes(leak), false, leak);
  }
});

test('retro reports workspace files, review verdicts and earlier retro logs', async (t) => {
  const { root, put, task } = fixture(t);
  put(
    `${task}/codex-review-round1.md`,
    '# Review round 1 by codex\n\nVerdict: blocked. Author: claude.\n',
  );
  put(
    `${task}/codex-review-round2.md`,
    '# Review round 2 by codex\n\nVerdict: pass. Author: claude.\n',
  );
  put('.halvard/claude-retro-log.md', 'log');
  put('.halvard/pi-retro-log.md', 'log');
  put('.halvard/ollama-retro-log.md', 'log');
  put('.halvard/notes.md', 'not a retro log');
  const retro = await retroEvents(root, 'demo');
  assert.deepEqual(
    retro.files.map((file) => file.name),
    ['.repo', 'codex-report.md', 'codex-review-round1.md', 'codex-review-round2.md'],
  );
  assert.deepEqual(retro.reviews, [
    { reviewer: 'codex', round: 1, verdict: 'blocked' },
    { reviewer: 'codex', round: 2, verdict: 'pass' },
  ]);
  assert.deepEqual(
    retro.retroLogs.map((file) => basename(file)),
    ['claude-retro-log.md', 'ollama-retro-log.md', 'pi-retro-log.md'],
  );
  assert.equal(
    new Date(retro.window.from).getTime(),
    new Date(retro.files[0]!.modified).getTime() - 10 * 60 * 1000,
  );
});

test('retro includes records by their own time even when the transcript file is older', async (t) => {
  const { root, put, jsonl, at } = fixture(t);
  // A restored or copied transcript can keep an mtime from before the task began.
  put(
    '.pi/agent/sessions/--repo--/restored.jsonl',
    jsonl([
      { type: 'session', id: 'pi-restored', timestamp: at(0), cwd: root },
      {
        type: 'message',
        timestamp: at(1),
        message: { role: 'user', content: [{ type: 'text', text: `approve halvard ${request}` }] },
      },
    ]),
    Date.now() - 24 * 60 * 60 * 1000,
  );
  const retro = await retroEvents(root, 'demo');
  assert.deepEqual(retro.events.pi.sessions, ['pi-restored']);
  assert.equal(retro.events.pi.approvals, 1);
});

test('retro refuses a missing workspace, a foreign one and an invalid task id', async (t) => {
  const { root, put, task } = fixture(t);
  await assert.rejects(retroEvents(root, 'missing'), /no task workspace/);
  await assert.rejects(retroEvents(root, '../demo'), /short lowercase slug/);
  put(`${task}/.repo`, '/another/repo\n');
  await assert.rejects(retroEvents(root, 'demo'), /belongs to another repository/);
});
