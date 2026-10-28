import type { Driver } from './types.ts';
import { readFileSync } from 'node:fs';
import { standardOutput } from './output.ts';
import { claudeShaped } from './tool-input.ts';

// Codex writes its final message to the file named by -o.
export const codex: Driver = {
  name: 'codex',
  hooks: {
    payload: claudeShaped,
    // Codex does not enforce ask, so a request for approval denies.
    output: (event, result) => standardOutput(event, result, { askAsDeny: true }),
  },
  agent: {
    command: ({ stage, output, extra }) => [
      'codex',
      'exec',
      '--sandbox',
      stage === 'plan' ? 'read-only' : 'workspace-write',
      '--skip-git-repo-check',
      '--color',
      'never',
      '-o',
      output,
      ...extra,
      '-',
    ],
    stdin: true,
    result: (_stdout, output) => ({ text: readFileSync(output, 'utf8'), costUsd: 0, error: null }),
  },
  review: {
    command: ({ settings, output }) => [
      'codex',
      'exec',
      '--ignore-user-config',
      '--ignore-rules',
      '--sandbox',
      'read-only',
      '--ephemeral',
      '--skip-git-repo-check',
      '--color',
      'never',
      '-o',
      output,
      ...(settings.model ? ['--model', settings.model] : []),
      '-',
    ],
    stdin: () => true,
    result: (_stdout, output) => ({ text: readFileSync(output, 'utf8'), models: [] }),
  },
};
