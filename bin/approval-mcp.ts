#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { approvalServer } from '../core/approval-mcp.ts';

// The Codex plugin starts this MCP server over stdio: one JSON-RPC message per line. Its
// launch entry sets HALVARD_APPROVAL_HOST; the guard denies agents that start it, and a
// headless review never answers approvals. Neither check is a boundary, like the hooks.
if (process.env.HALVARD_APPROVAL_HOST !== 'codex' || process.env.HALVARD_REVIEW === '1') {
  process.stderr.write('halvard approval server: start it only from the Codex plugin\n');
  process.exit(1);
}
const receive = approvalServer({
  write: (message) => process.stdout.write(JSON.stringify(message) + '\n'),
});
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'parse error' },
      }) + '\n',
    );
    continue;
  }
  // A tool call waits for the user's answer, which arrives as a later line.
  receive(message as Parameters<typeof receive>[0]).catch((err: Error) => {
    process.stderr.write(`halvard approval server: ${err.message}\n`);
  });
}
