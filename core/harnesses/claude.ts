import type { Driver } from './types.ts';
import { pluginRoot } from '../shared/plugin.ts';
import { standardOutput } from './output.ts';
import { claudeShaped } from './tool-input.ts';

interface Envelope {
  result?: unknown;
  is_error?: unknown;
  total_cost_usd?: unknown;
  modelUsage?: Record<string, unknown>;
}

export const claude: Driver = {
  name: 'claude',
  hooks: {
    payload: claudeShaped,
    output: (event, result) => standardOutput(event, result),
  },
  agent: {
    command: ({ stage, workspace, budgetUsd, auth, extra }) => [
      'claude',
      '-p',
      '--output-format',
      'json',
      '--permission-prompts',
      'none',
      '--max-budget-usd',
      budgetUsd.toFixed(2),
      // Bare mode loads only Halvard and reads only an API key; a subscription token
      // needs the normal startup, which also loads the user's own Claude settings.
      ...(auth === 'api' ? ['--bare', '--plugin-dir', pluginRoot] : []),
      ...(stage === 'plan'
        ? ['--permission-mode', 'dontAsk', '--allowedTools', 'Read,Grep,Glob,Bash']
        : ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,Read,Edit,Write,Glob,Grep']),
      // --add-dir and --allowedTools take lists and would swallow a trailing prompt, so
      // Claude reads it on stdin.
      '--add-dir',
      workspace,
      ...extra,
    ],
    stdin: true,
    result: (stdout) => {
      const envelope = JSON.parse(stdout) as Envelope;
      const costUsd = typeof envelope.total_cost_usd === 'number' ? envelope.total_cost_usd : 0;
      if (envelope.is_error || typeof envelope.result !== 'string') {
        return { text: '', costUsd, error: `Claude reported an error: ${String(envelope.result)}` };
      }
      return { text: envelope.result, costUsd, error: null };
    },
  },
  review: {
    command: ({ settings }) => [
      'claude',
      '-p',
      '--output-format',
      'json',
      '--tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--setting-sources',
      'user',
      '--settings',
      '{"disableAllHooks":true}',
      '--no-session-persistence',
      ...(settings.model ? ['--model', settings.model] : []),
      'Review the supplied evidence and return only the requested JSON verdict.',
    ],
    stdin: () => true,
    result: (stdout) => {
      const envelope = JSON.parse(stdout) as Envelope;
      if (envelope.is_error || typeof envelope.result !== 'string') {
        throw new Error('Claude did not produce a successful review');
      }
      return { text: envelope.result, models: Object.keys(envelope.modelUsage ?? {}) };
    },
  },
};
