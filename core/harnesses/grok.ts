import type { HookPayload } from '../types.ts';
import type { Driver, Raw } from './types.ts';
import { envelopeAgent, envelopeText, standardOutput } from './output.ts';
import { canonicalTool, text } from './tool-input.ts';

const GROK_EVENTS: Record<string, string> = {
  session_start: 'SessionStart',
  user_prompt_submit: 'UserPromptSubmit',
  pre_tool_use: 'PreToolUse',
  post_tool_use: 'PostToolUse',
};

function grokPayload(raw: Raw): HookPayload | null {
  const event =
    text(raw.hook_event_name) ?? GROK_EVENTS[text(raw.hookEventName) ?? ''] ?? undefined;
  const name = text(raw.toolName, raw.tool_name);
  const [tool, input] = name
    ? canonicalTool(name, raw.toolInput ?? raw.tool_input)
    : [undefined, undefined];
  return {
    cwd: text(raw.cwd, raw.workspaceRoot) as string,
    session_id: raw.sessionId ?? raw.session_id,
    hook_event_name: event,
    tool_name: tool,
    tool_input: input,
    tool_use_id: raw.toolUseId ?? raw.tool_use_id,
    permission_mode: text(raw.permissionMode, raw.permission_mode),
    prompt: text(raw.prompt, raw.userPrompt, raw.user_prompt),
    is_error: raw.is_error === true || raw.isError === true,
  };
}

// Grok's headless mode reads the prompt from a file, not stdin.
export const grok: Driver = {
  name: 'grok',
  settingsDir: '.grok',
  // Grok also loads Claude hooks and ~/.cursor/hooks.json, so one tool call may reach
  // several Halvard entries; each one guards as Grok.
  detect: (_raw, env) => Boolean(env.GROK_HOOK_EVENT),
  hooks: {
    payload: grokPayload,
    output: (event, result) => standardOutput(event, result, { topLevel: true }),
  },
  agent: {
    command: ({ promptFile, extra }) => [
      'grok',
      '--prompt-file',
      promptFile,
      '--output-format',
      'json',
      '--no-auto-update',
      ...extra,
    ],
    stdin: false,
    result: (stdout) => envelopeAgent('Grok', stdout),
  },
  review: {
    // Grok's headless mode does not read stdin; the evidence goes in as a prompt file.
    command: ({ settings, input }) => [
      'grok',
      '--prompt-file',
      input,
      '--output-format',
      'json',
      '--disallowed-tools',
      'search_replace,write_file,run_terminal_command,web_search,web_fetch,spawn_subagent',
      '--no-subagents',
      '--disable-web-search',
      ...(settings.model ? ['-m', settings.model] : []),
    ],
    stdin: () => true,
    result: (stdout) => ({ text: envelopeText('Grok', stdout), models: [] }),
  },
};
