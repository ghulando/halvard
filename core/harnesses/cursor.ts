import type { HookPayload, HookResult, NativeHookOutput } from '../types.ts';
import type { Driver, Raw } from './types.ts';
import { resolve } from 'node:path';
import { pluginRoot, quote } from '../shared/plugin.ts';
import { envelopeAgent, envelopeText } from './output.ts';
import { canonicalTool, shellInput, text } from './tool-input.ts';

// Cursor sends shell commands to both preToolUse and beforeShellExecution. Halvard
// registers both and reads shell from beforeShellExecution only, so a one-use approval
// is not spent twice on the same command.
function cursorPayload(raw: Raw): HookPayload | null {
  const roots = Array.isArray(raw.workspace_roots) ? raw.workspace_roots : [];
  const root = text(roots[0], raw.cwd);
  const mode = text(raw.composer_mode, raw.permission_mode);
  const base = {
    cwd: root as string,
    session_id: raw.conversation_id ?? raw.session_id,
    permission_mode: mode === 'plan' || mode === 'ask' ? 'plan' : mode,
  };
  switch (raw.hook_event_name) {
    case 'sessionStart':
      return { ...base, hook_event_name: 'SessionStart' };
    case 'beforeSubmitPrompt':
      return { ...base, hook_event_name: 'UserPromptSubmit', prompt: text(raw.prompt) };
    case 'beforeShellExecution':
    case 'afterShellExecution':
      return {
        ...base,
        hook_event_name:
          raw.hook_event_name === 'beforeShellExecution' ? 'PreToolUse' : 'PostToolUse',
        tool_name: 'Bash',
        tool_input: shellInput(raw),
      };
    case 'preToolUse':
    case 'postToolUse': {
      const name = text(raw.tool_name) ?? '';
      const [tool, input] = canonicalTool(name, raw.tool_input);
      if (tool === 'Bash') return null;
      return {
        ...base,
        hook_event_name: raw.hook_event_name === 'preToolUse' ? 'PreToolUse' : 'PostToolUse',
        tool_name: tool,
        tool_input: input,
        tool_use_id: raw.tool_use_id,
        is_error: raw.is_error === true,
      };
    }
    default:
      return null;
  }
}

// Cursor's own shape. It does not enforce ask, and its CLI fires no prompt hook, so the
// user approves a request from a terminal instead of with a chat phrase.
function cursorOutput(event: string | undefined, result: HookResult): NativeHookOutput {
  if (result.decision) {
    const reason = result.request
      ? `${result.reason}\nTo approve this one operation, run this in the repository from your own terminal: node ${quote(resolve(pluginRoot, 'bin/halvard.ts'))} approve ${result.session} ${result.request}\nThen ask the agent to retry it.`
      : result.reason;
    return { permission: 'deny' as const, user_message: reason, agent_message: reason };
  }
  // A prompt hook that answers without continue could hold the prompt back.
  if (event === 'UserPromptSubmit') return { continue: true };
  if (result.context && event !== 'PreToolUse') return { additional_context: result.context };
  return {};
}

export const cursor: Driver = {
  name: 'cursor',
  settingsDir: '.cursor',
  detect: (raw) =>
    typeof raw.cursor_version === 'string' ||
    (typeof raw.conversation_id === 'string' && Array.isArray(raw.workspace_roots)),
  hooks: { payload: cursorPayload, output: cursorOutput },
  agent: {
    command: ({ stage, prompt, extra }) => [
      'cursor-agent',
      '-p',
      '--output-format',
      'json',
      ...(stage === 'plan' ? ['--mode', 'ask'] : ['--force']),
      ...extra,
      prompt,
    ],
    stdin: false,
    result: (stdout) => envelopeAgent('Cursor', stdout),
  },
  review: {
    // Ask mode is Cursor's read-only mode; the evidence arrives on stdin and in the input file.
    command: ({ settings, input }) => [
      'cursor-agent',
      '-p',
      '--mode',
      'ask',
      '--output-format',
      'json',
      ...(settings.model ? ['--model', settings.model] : []),
      `Review the evidence on standard input (also saved at ${input}) and return only the requested JSON verdict.`,
    ],
    stdin: () => true,
    result: (stdout) => ({ text: envelopeText('Cursor', stdout), models: [] }),
  },
};
