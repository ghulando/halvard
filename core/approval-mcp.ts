import type { WorkflowState } from './types.ts';
import { APPROVAL_TOOL } from './types.ts';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { currentBranch, loadProject } from './project.ts';
import { REQUEST_TTL, approve, recordOutcome } from './approval.ts';
import { findPendingRequest, sessionKey, withState } from './state.ts';

// Codex does not enforce a hook's ask, so Halvard's Codex hook denies and names a request.
// This stdio MCP server, declared by the Codex plugin, turns that request into a dialog:
// it asks Codex to show an elicitation form to the user, and only the answer Codex sends
// back, never the tool's arguments or the agent's text, can approve the request. Anything
// short of an explicit "Approve once" leaves the operation blocked, and the text approval
// (approve halvard <id>) keeps working.

const PROTOCOL = '2025-06-18';

interface Message {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface Elicited {
  action?: unknown;
  content?: Record<string, unknown> | null;
}

export interface ApprovalServerOptions {
  write: (message: Message) => void;
  // The Codex configuration files that decide whether a dialog can reach the user.
  configFiles?: (root: string) => string[];
  // How long to wait for the user's answer, at most until the request expires.
  answerTimeout?: number;
}

const text = (value: string, isError = false) => ({
  content: [{ type: 'text', text: value }],
  ...(isError ? { isError: true } : {}),
});

const fallback = (id: string, why: string) =>
  text(
    `${why} The operation stays blocked. Ask the user to read the request and, to approve it, send exactly: approve halvard ${id}`,
    true,
  );

function codexConfigFiles(root: string) {
  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  return [join(home, 'config.toml'), join(root, '.codex/config.toml')];
}

// A dialog cannot reach the user when Codex declines every elicitation (approval_policy
// never) or when an automatic reviewer answers approvals instead of the user.
export function dialogBlocked(files: string[]) {
  for (const file of files) {
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.replace(/#.*$/, '').trim());
    if (lines.some((line) => /^approval_policy\s*=\s*["']never["']/.test(line))) {
      return 'Codex is configured with approval_policy = "never", which declines approval dialogs.';
    }
    if (lines.some((line) => /guardian|auto[_-]?review/i.test(line))) {
      return 'Codex is configured with an automatic approval reviewer, which could answer the dialog instead of the user.';
    }
  }
  return null;
}

export function approvalServer({
  write,
  configFiles = codexConfigFiles,
  answerTimeout,
}: ApprovalServerOptions) {
  let elicitation = false;
  let next = 0;
  const waiting = new Map<string, (message: Message) => void>();

  const ask = (params: Record<string, unknown>, timeout: number) =>
    new Promise<Message>((resolvePromise) => {
      const id = `halvard-${++next}`;
      const timer = setTimeout(() => {
        waiting.delete(id);
        // Withdraw the form, so a late answer is not silently ignored.
        write({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: id, reason: 'The approval request timed out.' },
        });
        resolvePromise({ jsonrpc: '2.0', id, error: { code: -1, message: 'timed out' } });
      }, timeout);
      waiting.set(id, (message) => {
        clearTimeout(timer);
        resolvePromise(message);
      });
      write({ jsonrpc: '2.0', id, method: 'elicitation/create', params });
    });

  async function request(id: string, meta: Record<string, unknown>) {
    const found = findPendingRequest(id);
    if (!found) {
      return text(
        `No Halvard request ${id.slice(0, 12)} is waiting. Retry the original operation to request approval.`,
        true,
      );
    }
    const project = loadProject(found.root);
    // The request belongs to one Codex session. A call from another session cannot show it.
    const sessions = [meta.sessionId, meta.threadId].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    if (!sessions.length) {
      return fallback(id, 'Codex did not say which session called the tool.');
    }
    if (!sessions.some((session) => sessionKey(project.root, 'codex', session) === found.key)) {
      return text(
        'This request belongs to another session. Nothing was shown or approved; the operation stays blocked.',
        true,
      );
    }
    const pending = await withState(project.root, found.key, (state: WorkflowState) =>
      state.pending?.id === id ? state.pending : null,
    );
    if (!pending)
      return text('The request is no longer waiting. Retry the original operation.', true);
    const left = pending.at + REQUEST_TTL - Date.now();
    if (left <= 0) {
      return text(
        `Request ${id.slice(0, 12)} has expired. Retry the original operation; Halvard then issues a new request.`,
        true,
      );
    }
    if (!elicitation) {
      return fallback(id, 'This Codex session cannot show approval dialogs.');
    }
    const blocked = dialogBlocked(configFiles(project.root));
    if (blocked) return fallback(id, blocked);
    let branch = 'unknown';
    try {
      branch = currentBranch(project.root) ?? 'detached';
    } catch {}
    const expires = new Date(pending.at + REQUEST_TTL).toTimeString().slice(0, 5);
    const answer = await ask(
      {
        message: [
          'Halvard approval request',
          `Repository: ${project.root}`,
          `Branch: ${branch}`,
          `Operation:\n${pending.summary}`,
          `Request ${id.slice(0, 12)}, expires at ${expires}. Approving allows this exact operation once.`,
        ].join('\n'),
        requestedSchema: {
          type: 'object',
          properties: {
            decision: {
              type: 'string',
              title: 'Decision',
              enum: ['approve_once', 'reject'],
              enumNames: ['Approve once', 'Reject'],
            },
          },
          required: ['decision'],
        },
      },
      Math.min(left, answerTimeout ?? left),
    );
    // No answer is not the user's answer: the outcome stays unknown.
    if (answer.error) return fallback(id, 'The approval dialog did not return an answer.');
    const result = (answer.result ?? {}) as Elicited;
    // Only an explicit choice approves. Codex accepts a form with no fields by itself, so
    // the form has a required field without a default, and an empty accept is no answer.
    if (result.action === 'accept' && result.content?.decision === 'approve_once') {
      const { outcome, message } = await approve(
        project,
        'codex',
        found.key,
        id,
        'codex-elicitation',
      );
      return outcome === 'approved'
        ? text(
            `The user approved request ${id.slice(0, 12)} once. Retry the exact original operation now.`,
          )
        : text(message, true);
    }
    // Reject is the user's choice. Codex also declines by itself under some approval
    // policies, so a decline is logged as declined, not as the user's rejection.
    const rejected = result.action === 'accept' && result.content?.decision === 'reject';
    const declined = result.action === 'decline';
    recordOutcome(
      project,
      'codex',
      found.key,
      id,
      rejected ? 'rejected' : declined ? 'declined' : 'cancelled',
      'codex-elicitation',
    );
    return text(
      rejected
        ? `The user rejected request ${id.slice(0, 12)}. Do not retry the operation; ask the user how to proceed.`
        : declined
          ? `The approval dialog was declined, by the user or by Codex's approval policy. The operation stays blocked. Ask the user how to proceed; they can approve it by sending exactly: approve halvard ${id}`
          : `The approval dialog was cancelled without an answer. The operation stays blocked. Ask the user how to proceed; they can approve it by sending exactly: approve halvard ${id}`,
      true,
    );
  }

  async function call(params: Record<string, unknown>) {
    if (params.name !== APPROVAL_TOOL) throw new Error(`unknown tool: ${String(params.name)}`);
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const id = args.request;
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) {
      return text('The request must be the 64-character id Halvard named.', true);
    }
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    try {
      return await request(id, meta);
    } catch (err) {
      return fallback(id, `The approval dialog could not run (${(err as Error).message}).`);
    }
  }

  return async function receive(message: Message) {
    if (message.method === undefined) {
      // A response to an elicitation this server sent.
      const resolve = waiting.get(String(message.id));
      if (resolve) {
        waiting.delete(String(message.id));
        resolve(message);
      }
      return;
    }
    if (message.id === undefined) return; // Notifications need no answer.
    const reply = (result: Record<string, unknown>) =>
      write({ jsonrpc: '2.0', id: message.id!, result });
    const params = message.params ?? {};
    try {
      if (message.method === 'initialize') {
        const capabilities = (params.capabilities ?? {}) as Record<string, unknown>;
        elicitation = Boolean(capabilities.elicitation);
        reply({
          protocolVersion:
            typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: 'halvard', version: '1' },
        });
      } else if (message.method === 'ping') {
        reply({});
      } else if (message.method === 'tools/list') {
        reply({
          tools: [
            {
              name: APPROVAL_TOOL,
              title: 'Ask the user to approve a Halvard request',
              description:
                'When Halvard blocks an operation and names a request id, call this with that id to show the user an approval dialog. Only the user answers it; this tool cannot approve anything by itself. After an approval, retry the exact original operation once.',
              inputSchema: {
                type: 'object',
                properties: {
                  request: { type: 'string', pattern: '^[a-f0-9]{64}$' },
                },
                required: ['request'],
                additionalProperties: false,
              },
              annotations: { destructiveHint: false, openWorldHint: false },
            },
          ],
        });
      } else if (message.method === 'tools/call') {
        reply(await call(params));
      } else {
        write({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `method not found: ${message.method}` },
        });
      }
    } catch (err) {
      write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32602, message: (err as Error).message },
      });
    }
  };
}
