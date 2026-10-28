import type { Driver } from './types.ts';
import { standardOutput } from './output.ts';
import { claudeShaped } from './tool-input.ts';

// Pi runs the engine in process through adapters/pi.ts; the hook section serves the
// shared hook entry point. Pi never reviews: Ollama reviews through Pi instead.
export const pi: Driver = {
  name: 'pi',
  hooks: {
    payload: claudeShaped,
    output: (event, result) => standardOutput(event, result),
  },
  agent: {
    command: ({ promptFile, extra }) => ['pi', '-p', ...extra, `@${promptFile}`],
    stdin: false,
    result: (stdout) => ({ text: stdout, costUsd: 0, error: null }),
  },
};
