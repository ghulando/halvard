import type { TestContext } from 'node:test';
import type { ToolInput, HookPayload } from '../core/types.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handle } from '../core/runtime.ts';

export function fixture(t: TestContext, overrides = {}) {
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

export function call(
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

export function writeInput(harness: string, path: string, content: string): [string, ToolInput] {
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
