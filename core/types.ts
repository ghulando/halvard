// Shared contracts. Boundary assertions accompany the existing runtime checks.
export const HARNESSES = ['pi', 'claude', 'codex', 'grok', 'cursor'] as const;
export type Harness = (typeof HARNESSES)[number];

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
  // Agent spend per calendar month (UTC); the daemon claims no new work past 90% of it.
  monthlyUsd: number;
  // How often factory serve polls GitHub, in seconds.
  pollSeconds: number;
  // A second harness writes acceptance tests the builder may not change.
  tests: { by: Harness; dir: string } | null;
  // Jobs factory serve works at the same time.
  concurrency: number;
  // When set, every job gets its own clone, and agents, setup, the gate and the review run
  // in containers of this image.
  container: ContainerConfig | null;
  // Checks kept outside the repository that the runner runs after the gate passes.
  holdout: HoldoutCheck[];
  autoMerge: AutoMergeConfig;
  // A weekly digest of review findings and parked jobs becomes a job that edits guidance.
  retro: RetroConfig | null;
}

export interface HoldoutCheck {
  name: string;
  // A host folder the check reads its scenarios from; the agent's container never mounts it.
  dir: string;
  command: string[];
  // The share of jobs the check runs on, chosen from the job id so a retry runs the same set.
  sample: number;
  // A failed blocking check parks the job; any other result goes into the evidence.
  blocking: boolean;
}

export interface AutoMergeConfig {
  // Off by default; the repository variable FACTORY_AUTOMERGE must also read on.
  enabled: boolean;
  // Change classes by path pattern; a pull request is in a class when every file matches it.
  classes: Record<string, string[]>;
  // Track record a class needs: merged pull requests, and the share of them no human edited.
  minPrs: number;
  minCleanRate: number;
  maxLines: number;
  // No revert of a pull request in the class within this many days.
  windowDays: number;
  // Check names that must have succeeded; any check, so a bot's quick success is not enough.
  requiredChecks: string[];
}

export interface RetroConfig {
  everyDays: number;
  // The only files a retro job may change.
  paths: string[];
}

export interface ContainerConfig {
  image: string;
  // A Docker network whose egress you limit; none gives no network at all.
  network: string;
  // Names of host variables passed into the containers, such as model API keys.
  env: string[];
  // Extra bind mounts, host:container[:ro], such as a harness login file.
  mounts: { host: string; container: string; readonly: boolean }[];
  // The Halvard runner inside the image.
  runner: string;
  memory: string | null;
  cpus: number | null;
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
