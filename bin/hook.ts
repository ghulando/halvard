#!/usr/bin/env node
import { handle } from '../core/runtime.ts';
import { hookOutput, hostHarness, toHookPayload } from '../core/harnesses/index.ts';

try {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 12 * 1024 * 1024) throw new Error('hook payload exceeds 12 MiB');
  }
  const input = JSON.parse(raw) as unknown;
  const host = hostHarness(input);
  // Grok also loads Halvard's Claude and Cursor entries; each one guards as Grok, and
  // the session state stops a duplicate from asking twice. Cursor runs its own entry only.
  const harness = host === 'grok' ? 'grok' : process.argv[2];
  const payload = host === 'cursor' && harness !== 'cursor' ? null : toHookPayload(harness, input);
  if (!payload) {
    process.stdout.write('{}');
  } else {
    const result = await handle(harness, payload);
    process.stdout.write(JSON.stringify(hookOutput(harness, payload.hook_event_name, result)));
  }
} catch (err) {
  process.stderr.write(`halvard: ${(err as Error).message}\n`);
  process.exitCode = 2;
}
