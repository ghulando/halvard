import type { HookPayload, HookResult, NativeHookOutput, ReviewerSettings } from '../types.ts';

export type Raw = Record<string, unknown>;

export type Stage = 'plan' | 'build';

// One headless agent run. The prompt is in promptFile as well, for hosts that read it from
// a file; output names a last-message file for hosts that write one.
export interface AgentRequest {
  stage: Stage;
  prompt: string;
  promptFile: string;
  output: string;
  workspace: string;
  budgetUsd: number;
  auth: 'api' | 'subscription';
  // The operator's extra arguments from factory.harnessArgs.
  extra: string[];
}

// The final message and the reported cost. Hosts other than Claude report no dollars.
export interface AgentOutput {
  text: string;
  costUsd: number;
  error: string | null;
}

// One headless review. The evidence is in input as well, for hosts that read it from a file.
export interface ReviewRequest {
  settings: ReviewerSettings;
  output: string;
  input: string;
}

// The verdict text and the models the host reports it used, if any.
export interface ReviewOutput {
  text: string;
  models: string[];
}

// Everything Halvard knows about one tool. A section is missing when the tool does not
// play that part: Ollama only reviews, and Pi is never a headless reviewer.
export interface Driver {
  name: string;
  // Recognises this host's own payload when it also loads another host's hook entries.
  detect?: (raw: Raw, env: NodeJS.ProcessEnv) => boolean;
  hooks?: {
    // Maps the host's payload onto the Claude-shaped one the engine reads; null leaves the
    // event to another entry.
    payload: (raw: Raw) => HookPayload | null;
    output: (event: string | undefined, result: HookResult) => NativeHookOutput;
  };
  agent?: {
    command: (request: AgentRequest) => string[];
    // Whether the prompt goes on standard input.
    stdin: boolean;
    result: (stdout: string, output: string) => AgentOutput;
  };
  review?: {
    // Throws when the settings cannot run this reviewer.
    command: (request: ReviewRequest) => string[];
    // Whether the evidence goes on standard input.
    stdin: (settings: ReviewerSettings) => boolean;
    result: (stdout: string, output: string) => ReviewOutput;
  };
}
