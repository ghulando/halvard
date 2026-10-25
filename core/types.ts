// Shared contracts. Boundary assertions accompany the existing runtime checks.
export const HARNESSES = ['pi', 'claude', 'codex', 'grok', 'cursor'] as const;
export type Harness = (typeof HARNESSES)[number];
// History cleanup and retro read transcript formats known only for these hosts.
export type HistoryHarness = 'pi' | 'claude' | 'codex';

export interface HistoryProcess {
  pid: number;
  comm: string;
}

export interface HistoryEntry {
  harness: HistoryHarness | 'workflow';
  path: string;
  bytes: number;
  mtimeMs: number;
  rule: string;
  snapshot: string;
  appendIdentity?: { dev: number; ino: number };
}

export interface HistoryNotice {
  path: string;
  reason: string;
}

export interface HistoryPlan {
  version: 1;
  harnesses: HistoryHarness[];
  roots: Record<HistoryHarness | 'workflow', string>;
  entries: HistoryEntry[];
  keptLive: HistoryNotice[];
  deferred: HistoryNotice[];
}

export interface HistoryDigest {
  harness: HistoryHarness;
  project: string;
  id: string;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  promptCount: number;
  firstPrompt: string;
}

export interface RetroCount {
  reason: string;
  count: number;
}

export interface RetroHarnessEvents {
  sessions: string[];
  denials: RetroCount[];
  asks: RetroCount[];
  approvals: number;
  gatePasses: number;
  gateFailures: RetroCount[];
}

export interface RetroEvents {
  task: string;
  repo: string;
  workspace: string;
  window: { from: string; to: string };
  files: { name: string; bytes: number; modified: string }[];
  reviews: { reviewer: string; round: number; verdict: string }[];
  retroLogs: string[];
  events: Record<HistoryHarness, RetroHarnessEvents>;
}

export type Reviewer = 'claude' | 'codex' | 'grok' | 'cursor' | 'ollama';

export interface ReviewerSettings {
  reviewer?: string | undefined;
  model?: string | undefined;
  transport?: 'cli' | 'pi' | undefined;
}

export interface ReviewException {
  maxRound: number;
  reason: string;
}

export interface ReviewDeferral {
  finding: string;
  approvedBy: string;
  reason: string;
  override?: boolean;
}

export interface FlowConfig {
  taskDirectory: string;
  baseBranch: string;
  featurePrefix: string;
  fixPrefix: string;
  requireReview: boolean;
  reviewers: Record<string, ReviewerSettings>;
  reviewTimeout: number;
  reviewExclude: string[];
  reviewContext: string[];
  reviewExceptions: Record<string, ReviewException>;
  reviewDeferrals: Record<string, ReviewDeferral[]>;
  stacks: string | null;
}

export interface TypedReadCommand {
  prefix: string[];
  options: Record<string, 'flag' | 'string' | 'positiveInteger'>;
  positionals: { min: number; max: number };
}

export type ReadCommand = string[] | TypedReadCommand;

export interface StackStamp {
  name: string;
  commit: string | null;
  modified: boolean;
  gate: string[][];
}

export interface ProjectConfig {
  version?: number;
  protectedBranches: string[];
  taskFiles: string[];
  doneMarker: string;
  gate: string[] | string[][] | null;
  review: string[] | null;
  skillRoots: string[];
  requiredSkills: string[];
  readCommands: ReadCommand[];
  readOnlyTools: string[];
  extensions: string[];
  stack: StackStamp | null;
  team: TeamConfig | null;
  factory: FactoryConfig | null;
  workflow: FlowConfig;
}

// Factory mode: a runner drives headless harnesses through one task and ships the result.
export interface FactoryConfig {
  author: Harness;
  // Reviewer preference for the first round; later rounds keep the first round's reviewer.
  reviewers: string[];
  setup: string[][];
  auth: Partial<Record<Harness, 'api' | 'subscription'>>;
  harnessArgs: Partial<Record<Harness, string[]>>;
  // Wall-clock limits in seconds.
  timeouts: { plan: number; build: number };
  // Claude's --max-budget-usd for each agent run.
  budgetUsd: number;
  // Agent runs after the first build that fix a failed gate or a blocked review.
  maxFixPasses: number;
  draft: boolean;
  riskPaths: string[];
}

export type FactoryStage =
  | 'awaiting-plan'
  | 'planning'
  | 'awaiting-approval'
  | 'approved'
  | 'building'
  | 'gating'
  | 'reviewing'
  | 'shipping'
  | 'committed'
  | 'pr-open'
  | 'parked';

export interface FactoryJob {
  version: 1;
  id: string;
  repo: string;
  title: string;
  issue: { number: number; url: string } | null;
  small: boolean;
  fix: boolean;
  author: Harness;
  stage: FactoryStage;
  worktree: string | null;
  branch: string | null;
  task: string | null;
  // proposedAt is when the plan went to the issue; a label added before it approves nothing.
  plan: {
    digest: string;
    approvedBy: string | null;
    at: string | null;
    proposedAt?: string | null;
  } | null;
  reviewer: string | null;
  round: number;
  fixPasses: number;
  parked: { reason: string; detail: string } | null;
  pr: string | null;
  costUsd: number;
  created: string;
  updated: string;
}

export interface TeamConfig {
  lead: Harness;
  dev: Harness;
  reviewer: Harness;
  investigator: Harness | null;
  // What the lead does with the other panes through Herdr.
  monitor: { watch: boolean; nudge: boolean; approve: 'reads-edits-gate' | 'none' };
}

export interface Project {
  root: string;
  config: ProjectConfig;
}

export interface EditPairInput {
  oldText?: unknown;
  old_string?: unknown;
  newText?: unknown;
  new_string?: unknown;
}

export interface ToolInput extends EditPairInput {
  [key: string]: unknown;
  edits?: unknown;
  command?: unknown;
  cmd?: unknown;
  path?: unknown;
  file_path?: unknown;
  notebook_path?: unknown;
  content?: unknown;
  workdir?: unknown;
  cwd?: unknown;
  new_source?: unknown;
  subagent_type?: unknown;
  replace_all?: unknown;
}

export interface HookPayload {
  cwd: string;
  session_id?: unknown;
  hook_event_name?: string | undefined;
  tool_name?: string | undefined;
  tool_input?: ToolInput | string | undefined;
  tool_use_id?: unknown;
  permission_mode?: string | undefined;
  prompt?: string | undefined;
  is_error?: boolean | undefined;
}

export interface FileChange {
  path: string;
  before: string;
  after: string | null;
}

export type Action =
  | { kind: 'shell'; command: string; cwd: string; input: ToolInput }
  | { kind: 'files'; files: FileChange[] }
  | { kind: 'workspace'; paths: string[] }
  | { kind: 'read' | 'outside' | 'unknown' };

export type ShellKind = 'read' | 'outside' | 'branch' | 'opaque' | 'mutation';

export interface HookResult {
  decision?: 'deny' | 'ask';
  reason?: string;
  request?: string;
  // The session key that holds the pending request, for hosts approved from a terminal.
  session?: string;
  context?: string;
}

export interface ParsedCommand {
  verb: string;
  positional: string[];
  flags: Record<string, string | boolean | undefined>;
}

export interface TaskMetadata {
  version: number;
  title: string;
  author: string;
  branch: string;
  base: string;
  small?: boolean;
  reviewCycle?: string;
  // An approved plan: the SHA-256 of the task's Approved plan section and who approved it.
  plan?: { digest: string; approvedBy: string; at: string };
}

export interface Task {
  file: string;
  content: string;
  metadata: TaskMetadata;
}

export interface ReviewFinding {
  severity: 'blocking' | 'should-fix' | 'nit';
  location: string;
  problem: string;
  suggestion: string;
  deferral?: string;
}

export interface ReviewVerdict {
  verdict: 'pass' | 'blocked';
  standards: string;
  spec: string;
  findings: ReviewFinding[];
}

export interface ReviewRecord extends ReviewVerdict {
  reviewer: string;
  model: string;
  authorization: string | null;
  requestedModel: string;
  transport: string;
  author: string;
  tree: string;
  base: string;
  round: number;
  deferrals?: (ReviewDeferral & Pick<ReviewFinding, 'severity' | 'location' | 'problem'>)[];
  report?: string;
}

export interface RunningReview {
  id: string;
  ownerPid: number;
  reviewerPid: number | null | undefined;
  phase: string;
  startedAt: string;
}

export interface Receipt {
  tree: string;
  base?: string;
  command?: string[] | string[][];
  at?: string;
}

export interface WorkflowState {
  revision: number;
  pass: Receipt | null;
  pending: { id: string; tree: string; at: number } | null;
  approved: string | null;
  // The tool call that spent the last approval. Grok can run several Halvard entries
  // for one call; the others see the same call and do not ask again.
  consumed?: { id: string; call: string } | null;
  gate: string | null;
  first?: ReviewRecord;
  second?: ReviewRecord;
  extraReviews?: ReviewRecord[];
  running?: RunningReview | null;
  history?: { event: string; run: RunningReview; at: string }[];
  additionalReviewAuthorization?: unknown;
}

export interface CopyPlan {
  destination: string;
  files: string[];
}

export interface SettingsWrite {
  path: string;
  content: string;
  before: Buffer | null;
}

export interface LinkPlan {
  path: string;
  target: string;
}

export interface PackageStatus {
  path: string;
  matches: boolean;
  expected: string;
  actual?: string;
  error?: string;
}

export interface InstallOptions {
  repair?: boolean | undefined;
}

export interface InstallationPlan {
  source: string;
  writes: SettingsWrite[];
  copy?: CopyPlan | null | undefined;
  link?: LinkPlan | undefined;
  replace?: boolean | undefined;
}

export interface ProjectInstallPlan {
  root: string;
  writes: SettingsWrite[];
  link: LinkPlan | undefined;
  copy: CopyPlan | undefined;
  drift: PackageStatus | undefined;
  replace: boolean;
}

export interface PackageMetadata {
  name: string;
  version: string;
  files: string[];
  description: string;
}

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

export interface Skill {
  name: string;
  description: string;
  file: string;
  content: string;
  bundled?: boolean;
}

export interface Extension {
  pre?: (input: Project & { action: Action }) => unknown | Promise<unknown>;
  post?: (input: Project & { action: Action }) => string | undefined | Promise<string | undefined>;
}

export interface SetupProject {
  path: string;
  stacks: string[];
  commands: { purpose: string; argv: string[]; evidence: string }[];
}

export interface PackedArchive {
  filename: string;
  files: { path: string; size: number; mode: number }[];
}

export interface NativeHookOutput {
  hookSpecificOutput?: {
    hookEventName?: string | undefined;
    permissionDecision?: string;
    permissionDecisionReason?: string | undefined;
    additionalContext?: string;
  };
  // Grok's top-level decision.
  decision?: 'deny' | 'ask';
  reason?: string | undefined;
  // Cursor's shape.
  continue?: boolean;
  permission?: 'deny';
  user_message?: string | undefined;
  agent_message?: string | undefined;
  additional_context?: string;
}
