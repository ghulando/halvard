import type { HookPayload, HookResult, NativeHookOutput, ReviewerSettings } from '../types.ts';

// The settings shapes Halvard edits when it installs itself into a tool.
export interface HarnessSettings {
  permissions?: unknown;
  hooks?: unknown;
  packages?: string[];
  extraKnownMarketplaces?: Record<string, { source: { source: string; path: string } }>;
  enabledPlugins?: Record<string, boolean>;
}

export interface MarketplacePlugin {
  name: string;
  source: { source: string; path: string };
  interface?: { displayName: string; shortDescription: string };
  policy?: { installation: string; authentication: string };
  category?: string;
}

export interface Marketplace {
  name: string;
  plugins: MarketplacePlugin[];
}

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

// A project install: the tool's settings in the repository point at the installed package.
// Paths given to stage, stageJSON and link are relative to root and checked to stay in it.
export interface ProjectInstall {
  root: string;
  installedRoot: string;
  market: string;
  json: <T>(path: string, fallback?: T) => T;
  stage: (path: string, content: string) => void;
  stageJSON: (path: string, value: unknown) => void;
  link: (path: string, target: string) => void;
}

// A personal install: the tool's settings in the user's home point at the copy in source,
// which destination holds. stage takes absolute paths under home.
export interface PersonalInstall {
  home: string;
  destination: string;
  source: string;
  market: string;
  description: string;
  json: <T>(path: string) => T;
  stage: (path: string, value: unknown) => void;
}

// What one transcript line says, for the retro: where and when, the user's prompts, and
// each tool result with the hook denials in it. Each tool reports a hook denial in its own
// shape; reason text elsewhere is not a denial.
export interface TranscriptItem {
  cwd?: unknown;
  time?: unknown;
  prompts: string[];
  results: { texts: string[]; denials: string[] }[];
}

// Everything Halvard knows about one tool. A section is missing when the tool does not
// play that part: Ollama only reviews, and Pi is never a headless reviewer.
export interface Driver {
  name: string;
  // The folder in a repository that holds the tool's own settings. Agents change it only
  // with approval, and a factory change to it is high risk.
  settingsDir?: string;
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
    // Authors this reviewer is not independent of.
    notFor?: string[];
    // Throws when the settings cannot run this reviewer.
    command: (request: ReviewRequest) => string[];
    // Whether the evidence goes on standard input.
    stdin: (settings: ReviewerSettings) => boolean;
    result: (stdout: string, output: string) => ReviewOutput;
  };
  install?: {
    project?: (install: ProjectInstall) => void;
    personal?: (install: PersonalInstall) => void;
    // The native commands that register a personal install; reinstall replaces an older one.
    commands?: (paths: { source: string; destination: string; reinstall: boolean }) => string[][];
    // How the user lets the tool write to the task workspace; Halvard never widens it itself.
    workspace?: (path: string) => string;
    // Files a project and a personal install write, relative to the root and to home.
    projectFiles: string[];
    homeFiles: string[];
  };
  // Only for tools whose transcripts Halvard can read.
  history?: {
    // The folder the tool keeps its history in.
    root: () => string;
    // Folders under the root that hold session transcripts.
    transcripts: string[];
    item: (record: Raw) => TranscriptItem;
  };
}
