import type {
  Action,
  Project,
  ProjectConfig,
  HookPayload,
  HookResult,
  ParsedCommand,
  Extension,
  ToolInput,
} from './types.ts';
import { HARNESSES } from './types.ts';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  CONFIG,
  currentBranch,
  findRoot,
  gateSteps,
  inside,
  loadProject,
  matches,
  projectPath,
} from './project.ts';
import { startupContext } from './context.ts';
import { commands, isShipping, rootGit, shellKind } from './guard/shell.ts';
import { normalize } from './guard/tools.ts';
import {
  HOOK_BUDGET,
  digest,
  fingerprint,
  invalidate,
  privateDirectory,
  sessionKey,
  withState,
} from './state.ts';
import { hasReview } from './workflow/review.ts';
import { evaluatePolicy } from './guard/policy.ts';
import { parseCommand } from './cli.ts';
import { planIntact, readTask, taskWorkspace } from './workflow/tasks.ts';
import { assignment, providers, workspaceRoot } from './flow-config.ts';
import { packageDigest } from './install/package.ts';
import { claimsDone, completionStatus } from './workflow/status.ts';

export const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
// The guard re-parses printed commands and rejects a backslash outside quotes,
// so text with an apostrophe goes in double quotes instead of '\''.
export const quote = (text: string) =>
  text.includes("'") ? '"' + text.replace(/["\\$`]/g, '\\$&') + '"' : "'" + text + "'";

const runnerPath = () => resolve(pluginRoot, 'bin/halvard.ts');

export function gateCommand(key: string) {
  return `node ${quote(runnerPath())} gate ${key}`;
}

// The runner's location differs per harness install, so each session names its own.
export function reviewCall(key: string, harness: string, config: ProjectConfig) {
  const reviewer = assignment(config.workflow, harness)?.reviewer ?? '<reviewer>';
  if (config.review) {
    return `REVIEW_GATE_SESSION=${key} HALVARD_RUNNER=${quote(runnerPath())} ${quote(config.review[0]!)} <task-file> ${harness} ${reviewer} [round]`;
  }
  return `node ${quote(runnerPath())} review <task-file> --author ${harness} --reviewer ${reviewer} --round <n> --gate-session ${key}`;
}

function runnerCall(action: Action, root: string) {
  if (action.kind !== 'shell') return null;
  let parts = commands(action.command);
  let cwd = resolve(action.cwd);
  // Agents often prefix the runner with a cd into the project root.
  if (parts?.length === 2 && parts[0]![0] === 'cd' && parts[0]!.length === 2) {
    try {
      if (realpathSync(resolve(cwd, parts[0]![1]!)) !== root) return null;
    } catch {
      return null;
    }
    parts = parts.slice(1);
    cwd = root;
  }
  if (parts?.length !== 1) return null;
  const [node, runner, verb, ...args] = parts[0]!;
  if (node !== 'node' || !runner) return null;
  if (
    cwd !== root &&
    (!isAbsolute(runner) || !['history-plan', 'history-digest', 'history-clean'].includes(verb!))
  ) {
    return null;
  }
  try {
    if (cwd !== root && !inside(root, realpathSync(cwd))) return null;
    const path = realpathSync(resolve(cwd, runner));
    if (path !== realpathSync(resolve(pluginRoot, 'bin/halvard.ts'))) {
      const candidate = dirname(dirname(path));
      if (
        path !== resolve(candidate, 'bin/halvard.ts') ||
        packageDigest(candidate) !== packageDigest(pluginRoot)
      ) {
        return null;
      }
    }
    return parseCommand(verb!, args);
  } catch {
    return null;
  }
}

// A runner or installed halvard command followed by factory, in any segment of the command.
function factoryCall(command: string) {
  const parts = commands(command);
  if (!parts) return /halvard(?:\.ts)?['"]?\s+factory\b/.test(command);
  return parts.some((words) =>
    words.some((word, i) => /(?:^|\/)halvard(?:\.ts)?$/.test(word) && words[i + 1] === 'factory'),
  );
}

function isGate(call: ParsedCommand | null, key: string) {
  return call?.verb === 'gate' && call.positional[0] === key;
}

// A gate the hook cannot recognize loses its receipt on PostToolUse.
function strandedGate(command: string) {
  const parts = commands(command);
  if (!parts) return /halvard\.ts\S*\s+gate\b/.test(command);
  return (
    parts.length > 1 &&
    parts.some((s) => s[0] === 'node' && s[1]?.endsWith('halvard.ts') && s[2] === 'gate')
  );
}

function isReview(
  call: ParsedCommand | null,
  action: Action,
  key: string,
  root: string,
  harness: string,
  config: ProjectConfig,
) {
  if (call?.verb === 'review') {
    return call.flags.author === harness && call.flags['gate-session'] === key;
  }
  if (action.kind !== 'shell' || resolve(action.cwd) !== root) return false;
  const parts = commands(action.command);
  let p = parts?.[0];
  if (p?.[1]?.startsWith('HALVARD_RUNNER=')) {
    if (p[1] !== `HALVARD_RUNNER=${runnerPath()}`) return false;
    p = [p[0]!, ...p.slice(2)];
  }
  return (
    parts?.length === 1 &&
    config.review?.length === 1 &&
    [5, 6].includes(p?.length as number) &&
    p![0]! === `REVIEW_GATE_SESSION=${key}` &&
    resolve(root, p![1]!) === resolve(root, config.review[0]!) &&
    p![3]! === harness &&
    providers.includes(p![4]!) &&
    (p!.length === 5 || /^(?:[1-9]|10)$/.test(p![5]!))
  );
}

const READ_VERBS = [
  'task-resume',
  'review-status',
  'doctor',
  'setup',
  'bootstrap',
  'install-plan',
  'history-plan',
  'history-digest',
  'retro-events',
];

function runnerKind(call: ParsedCommand | null) {
  if (READ_VERBS.includes(call?.verb as string)) return 'read';
  if (call?.verb === 'team' && call.positional[0] === 'show' && !Object.keys(call.flags).length) {
    return 'read';
  }
  if (call?.verb === 'task-start') return 'branch';
  return null;
}

async function extensions(project: Project) {
  const loaded: Extension[] = [];
  for (const path of project.config.extensions) {
    const file = projectPath(project.root, project.root, path);
    // Configuration and extension modules are trusted project code. Pin the
    // import to its content so a long-running Pi process sees later edits.
    const url = pathToFileURL(resolve(project.root, file));
    url.searchParams.set('version', digest(readFileSync(url, 'utf8')));
    const module = (await import(url.href)) as Extension;
    if (typeof module.pre !== 'function' && typeof module.post !== 'function') {
      throw new Error(`workflow extension has no pre/post export: ${path}`);
    }
    loaded.push(module);
  }
  return loaded;
}

// Edits that could rewrite the agent's own permissions, Git internals or the checks
// behind the done proof still ask.
export function protectedPatterns(project: Project) {
  const { root, config } = project;
  const patterns = [
    CONFIG,
    `**/${CONFIG}`,
    '.git',
    '.git/**',
    '**/.git',
    '**/.git/**',
    '.pi/**',
    '.claude/**',
    '.codex/**',
    '.grok/**',
    '.cursor/**',
    '.agents/plugins/**',
    ...config.extensions,
  ];
  for (const command of [...(config.gate ? gateSteps(config.gate) : []), config.review]) {
    if (command && command[0]!.includes('/') && inside(root, resolve(root, command[0]!))) {
      patterns.push(projectPath(root, root, command[0]!));
    }
    // Scripts handed to an interpreter, as in ["node", "scripts/check.ts"].
    for (const arg of command?.slice(1) ?? []) {
      const file = resolve(root, arg);
      if (inside(root, file) && existsSync(file) && statSync(file).isFile()) {
        patterns.push(projectPath(root, root, arg));
      }
    }
  }
  return patterns;
}

const APPROVAL_STALE =
  'Workflow approval is missing, stale or expired. Retry the original operation to request a fresh approval.';

// Marks one pending request approved. The prompt hook calls it for the approval phrase;
// `halvard approve` calls it from the user's own terminal on hosts without a prompt hook.
function approve(root: string, key: string, id: string, deadline?: number) {
  return withState(root, key, (state) => {
    const pending = state.pending;
    if (
      !pending ||
      pending.id !== id ||
      pending.tree !== fingerprint(root, undefined, deadline) ||
      Date.now() - pending.at > 600000
    ) {
      return APPROVAL_STALE;
    }
    state.approved = pending.id;
    return `Approved workflow request ${pending.id}, once. Retry the exact original operation.`;
  });
}

export async function approveFromTerminal(cwd: string, key: string, id: string) {
  // The guard denies an agent's approve command; a headless reviewer never approves.
  if (process.env.HALVARD_REVIEW === '1') {
    throw new Error('approve runs only in your own terminal');
  }
  if (!/^[a-f0-9]{64}$/.test(key) || !/^[a-f0-9]{64}$/.test(id)) {
    throw new Error('approve needs a session key and a request id');
  }
  const message = await approve(loadProject(cwd).root, key, id);
  if (message === APPROVAL_STALE) throw new Error(message);
  return message;
}

// HALVARD_READONLY is set by the factory runner for a plan run in any harness.
function readonlyMode(payload: HookPayload) {
  return (
    payload.permission_mode === 'plan' ||
    process.env.HALVARD_REVIEW === '1' ||
    process.env.PI_REVIEW === '1' ||
    process.env.HALVARD_READONLY === '1'
  );
}

// A factory run has nobody to answer an approval, so every ask becomes a denial.
export const unattended = () => process.env.HALVARD_UNATTENDED === '1';
// Factory runs may not edit files or redirect shell output outside their worktree and task
// workspace, where the main checkout, the shared Git directory and the factory's job files
// lie. Other shell commands on a feature branch stay unclassified, as in every run.
const factoryRun = () => unattended() || process.env.HALVARD_READONLY === '1';
const UNATTENDED =
  'This is an unattended factory run: nobody can approve it, and the factory runner commits, pushes and opens the pull request itself. Do not retry; finish the task and report.';

export async function handle(harness: string | undefined, raw: unknown): Promise<HookResult> {
  if (!harness || !(HARNESSES as readonly string[]).includes(harness)) {
    throw new Error('unknown harness');
  }
  if (!raw || typeof raw !== 'object' || typeof (raw as HookPayload).cwd !== 'string') {
    throw new Error('hook requires a cwd');
  }
  const payload = raw as HookPayload;
  const event = payload.hook_event_name;
  const deadline = Date.now() + HOOK_BUDGET;
  const approval =
    event === 'UserPromptSubmit' &&
    typeof payload.prompt === 'string' &&
    payload.prompt.trim().match(/^approve halvard ([a-f0-9]{64})$/);
  // Ordinary prompts must remain usable even when project configuration is broken.
  if (event === 'UserPromptSubmit' && !approval) return {};
  // A personal install loads these hooks in every session; there is no project to guard here.
  if (!findRoot(payload.cwd)) return {};
  const project = loadProject(payload.cwd);
  const { root, config } = project;
  const key = sessionKey(root, harness, payload.session_id);
  if (event === 'SessionStart') {
    return {
      context: startupContext(
        project,
        key,
        gateCommand(key),
        reviewCall(key, harness, config),
        harness,
      ),
    };
  }
  if (event === 'UserPromptSubmit') {
    if (unattended()) return { context: `Approval refused. ${UNATTENDED}` };
    const message = await approve(root, key, (approval as RegExpMatchArray)[1]!, deadline);
    return { context: message };
  }
  if (!['PreToolUse', 'PostToolUse'].includes(event as string)) {
    throw new Error(`unsupported workflow event: ${event}`);
  }
  const action = normalize(project, payload);
  if (action.kind === 'outside') {
    return factoryRun() && event === 'PreToolUse'
      ? {
          decision: 'deny',
          reason:
            'A factory run writes only inside its worktree and task workspace; this target is outside it.',
        }
      : {};
  }
  // Each team file has one writer, named by its prefix; everyone may read it.
  if (action.kind === 'workspace') {
    const foreign =
      event === 'PreToolUse' &&
      action.paths.find((path) => !basename(path).startsWith(`${harness}-`));
    if (!foreign) return {};
    const name = basename(foreign);
    const topic = name.replace(new RegExp(`^(?:${HARNESSES.join('|')})-`), '');
    const base = workspaceRoot();
    const where =
      relative(existsSync(base) ? realpathSync(base) : base, foreign).split('/').length === 3
        ? 'task workspace'
        : 'agent workspace';
    return {
      decision: 'deny',
      reason: `${name} in the ${where} is not yours. Each file there has one writer, named by its prefix; write ${harness}-${topic} instead.`,
    };
  }
  const call = runnerCall(action, root);
  const gate = isGate(call, key);
  const review = isReview(call, action, key, root, harness, config);
  const runner = runnerKind(call);
  const modules = await extensions(project);

  // The gate receipt names a tree fingerprint, so completion needs no per-command invalidation.
  if (event === 'PostToolUse') {
    const notes = [];
    if (!payload.is_error) {
      for (const module of modules) {
        if (module.post) {
          const context = await module.post({ root, config, action });
          if (context) notes.push(context);
        }
      }
    }
    return notes.length ? { context: notes.join('\n') } : {};
  }

  // Approval belongs to the user; an agent must not approve its own request.
  if (
    action.kind === 'shell' &&
    (call?.verb === 'approve' ||
      /halvard(?:\.ts)?['"]?\s+approve\s+[a-f0-9]{64}\b/.test(action.command))
  ) {
    return {
      decision: 'deny',
      reason: 'Only the user approves workflow requests. Ask the user to run the approve command.',
    };
  }
  // The factory runner approves plans, runs reviews and ships; an agent never drives it.
  if (action.kind === 'shell' && factoryCall(action.command)) {
    return {
      decision: 'deny',
      reason: 'Factory commands run only from your own terminal, never from an agent session.',
    };
  }

  if (action.kind === 'shell' && !gate && strandedGate(action.command)) {
    return {
      decision: 'deny',
      reason:
        'Run the gate as a plain command on its own, with your session key: node <runner> gate <session-key>. Inside a pipeline, chain or redirect it is not recognized.',
    };
  }

  return withState(root, key, async (state) => {
    let kind =
      runner ??
      (action.kind === 'shell'
        ? shellKind(action.command, config.readCommands, root, action.cwd)
        : action.kind);
    // Checkout also accepts file paths. Only existing local branch names are a
    // safe branch exemption; otherwise it could restore files on main.
    if (kind === 'branch' && action.kind === 'shell') {
      // A cd in a branch command leads to the root.
      let dir = action.cwd;
      for (const written of commands(action.command)!) {
        if (written[0] === 'cd') dir = root;
        const segment = rootGit(written, root, dir);
        if (segment[0] === 'git' && segment[1] === 'checkout' && segment.length === 3) {
          const ref = spawnSync(
            'git',
            ['show-ref', '--verify', '--quiet', `refs/heads/${segment[2]}`],
            { cwd: segment === written ? dir : root, timeout: 10000 },
          );
          if (ref.status !== 0) kind = 'mutation';
        }
      }
    }
    // A shell write outside the project passes like an outside file edit.
    if (kind === 'outside' && factoryRun()) {
      return {
        decision: 'deny',
        reason:
          'A factory run writes only inside its worktree and task workspace; this target is outside it.',
      };
    }
    const read = kind === 'read' || kind === 'outside';
    const branch = currentBranch(root);
    const shellParts = action.kind === 'shell' ? commands(action.command) : null;
    // git branch -d refuses a branch that is not merged, so cleanup after a merge ships too.
    const approvedShipping =
      shellParts?.length === 1 &&
      shellParts[0]![0] === 'git' &&
      (['merge', 'push'].includes(shellParts[0]![1]!) ||
        (shellParts[0]!.length >= 4 &&
          shellParts[0]![1] === 'branch' &&
          shellParts[0]![2] === '-d' &&
          shellParts[0]!.slice(3).every((name) => /^[A-Za-z0-9][\w./-]*$/.test(name))));
    const decision = evaluatePolicy({
      readonly: readonlyMode(payload),
      read,
      opaque: kind === 'opaque',
      review,
      gate,
      gateConfigured: Boolean(config.gate),
      branch,
      branchOperation: kind === 'branch' || call?.verb === 'history-clean',
      shipping: approvedShipping,
      shippingAttempt:
        action.kind === 'shell' &&
        (isShipping(action.command) || /\bgit\s+branch\s+(?:-d|--delete)\b/.test(action.command)),
      protectedBranches: config.protectedBranches,
    });
    if (decision) return decision;
    const done = claimsDone(action, config);
    let tree: string | undefined;
    const getTree = () => (tree ??= fingerprint(root, undefined, deadline));
    if (done && getTree() !== state.pass?.tree) {
      return {
        decision: 'deny',
        reason: `Run the full configured gate on this tree first: ${gateCommand(key)}`,
      };
    }
    if (
      done &&
      action.kind === 'files' &&
      action.files.some((file) => !planStands(project, file.path))
    ) {
      return { decision: 'deny', reason: PLAN_CHANGED };
    }
    if (done && config.workflow.requireReview && action.kind === 'files') {
      if (action.files.length !== 1) {
        return {
          decision: 'deny',
          reason:
            'Mark one task done in a separate status-only edit; do not combine completion with code changes.',
        };
      }
      for (const file of action.files) {
        if (
          file.after !==
          file.before.replace(/^\*\*Status:\*\*[^\n]*$/m, () => completionStatus(config.doneMarker))
        ) {
          return {
            decision: 'deny',
            reason:
              'Update task notes before final verification. The completion edit may change only task status.',
          };
        }
        if (!(await hasReview(project, file.path, getTree()))) {
          return {
            decision: 'deny',
            reason: 'Get a passing independent review on this tree before marking done.',
          };
        }
      }
    }
    for (const module of modules) {
      if (!module.pre) continue;
      const reason = await module.pre({ root, config, action });
      if (reason) return { decision: 'deny', reason: reason as string };
    }
    const reason =
      action.kind === 'files' &&
      action.files.some((file) => matches(file.path, protectedPatterns(project)))
        ? 'This edit changes Git metadata, harness settings, or the workflow configuration and checks.'
        : call?.verb === 'history-clean'
          ? 'This deletes harness session history. Review the plan before approving.'
          : (call?.verb === 'team' && call.positional[0] !== 'show') ||
              (action.kind === 'shell' && /halvard(?:\.ts)?\S*\s+team\s+set\b/.test(action.command))
            ? 'This changes the team in the workflow configuration.'
            : (action.kind === 'shell' && (approvedShipping || isShipping(action.command))) ||
                // Codex can type a command into a shell it already started.
                (payload.tool_name === 'write_stdin' &&
                  isShipping(String((payload.tool_input as ToolInput | undefined)?.chars ?? '')))
              ? 'This command commits, merges, pushes or publishes. Review the exact command before approving.'
              : undefined;
    if (!reason) return {};
    const requestTree = getTree();
    const request = digest([
      harness,
      key,
      payload.tool_name,
      payload.tool_input,
      action,
      requestTree,
      state.revision,
    ]);
    const toolCall =
      typeof payload.tool_use_id === 'string' && payload.tool_use_id ? payload.tool_use_id : null;
    if (toolCall && state.consumed?.id === request && state.consumed.call === toolCall) return {};
    if (
      state.approved !== request ||
      state.pending?.id !== request ||
      Date.now() - state.pending.at > 600000
    ) {
      if (unattended()) return { decision: 'deny', reason: `${reason} ${UNATTENDED}` };
      state.pending = { id: request, tree: requestTree, at: Date.now() };
      return { decision: 'ask', reason, request, session: key };
    }
    // The approval is one-use. The gate receipt stays bound to its tree fingerprint.
    state.pending = null;
    state.approved = null;
    state.consumed = toolCall ? { id: request, call: toolCall } : null;
    return {};
  });
}

const PLAN_CHANGED =
  'The Approved plan section changed after approval, so the approval no longer holds. Restore it, or ask the user for a new approval.';

// A hand-written task without workflow metadata has no recorded approval to protect.
function planStands(project: Project, file: string) {
  try {
    return planIntact(readTask(project, file));
  } catch {
    return true;
  }
}

// The completion checks the hook applies to a done edit, for a runner that marks the task
// done itself: the session's gate receipt and the independent review cover this tree. The
// task file is agent-editable, so a runner passes the plan digest it holds itself, or null
// for a task without an approved plan; the hook can only compare the file with itself.
export async function completeTask(
  cwd: string,
  path: string,
  gateSession: string,
  expected?: { plan: string | null },
) {
  const project = loadProject(cwd);
  const { root, config } = project;
  const task = readTask(project, path);
  if (currentBranch(root) !== task.metadata.branch) {
    throw new Error('task belongs to another branch');
  }
  if (!planIntact(task)) throw new Error(PLAN_CHANGED);
  if (expected && (task.metadata.plan?.digest ?? null) !== expected.plan) {
    throw new Error(PLAN_CHANGED);
  }
  const status = completionStatus(config.doneMarker);
  const line = task.content.match(/^\*\*Status:\*\*[^\n]*$/m);
  if (!line) throw new Error('task has no **Status:** line');
  if (line[0].trimEnd() === status) throw new Error('task is already done');
  const after = task.content.replace(/^\*\*Status:\*\*[^\n]*$/m, () => status);
  const tree = fingerprint(root);
  const gate = await withState(root, gateSession, (state) => state.pass);
  if (gate?.tree !== tree) throw new Error('run the full configured gate on this tree first');
  if (config.workflow.requireReview && !(await hasReview(project, task.file, tree))) {
    throw new Error('get a passing independent review on this tree before marking done');
  }
  writeFileSync(resolve(root, task.file), after);
  // The tree the runner commits: the reviewed tree plus the status line.
  return { task: task.file, tree, gate, final: fingerprint(root) };
}

const GATE_TIMEOUT = 20 * 60 * 1000;
const GATE_TAIL = 40;

// The log sits with the task's team files; a branch without a task uses the repository folder.
function gateLogDirectory(project: Project) {
  const { root, config } = project;
  const branch = currentBranch(root);
  const dir = resolve(root, config.workflow.taskDirectory);
  const tasks = (existsSync(dir) ? readdirSync(dir) : [])
    .filter((name) => name.endsWith('.md'))
    .flatMap((name) => {
      // A hand-written file without workflow metadata names no branch.
      try {
        const task = readTask(project, `${config.workflow.taskDirectory}/${name}`);
        return task.metadata.branch === branch ? [task.file] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => statSync(resolve(root, b)).mtimeMs - statSync(resolve(root, a)).mtimeMs);
  if (tasks.length) return taskWorkspace(root, basename(tasks[0]!, '.md'));
  mkdirSync(workspaceRoot(), { recursive: true, mode: 0o700 });
  return privateDirectory(resolve(workspaceRoot(), basename(root)));
}

// Reads backward from the end of the file to the step's start until it holds count whole
// lines. Output is kept as written except for the final line break.
function lastLines(file: string, from: number, count: number) {
  const fd = openSync(file, 'r');
  const split = (text: Buffer) => text.toString('utf8').replace(/\n$/, '').split('\n');
  try {
    let end = fstatSync(fd).size;
    let text = Buffer.alloc(0);
    while (end > from && split(text).length <= count) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, end - from));
      end -= chunk.length;
      readSync(fd, chunk, 0, chunk.length, end);
      text = Buffer.concat([chunk, text]);
    }
    return split(text).slice(-count).join('\n');
  } finally {
    closeSync(fd);
  }
}

export async function runGate(cwd: string, key: string) {
  const project = loadProject(cwd);
  const { root, config } = project;
  if (!config.gate) throw new Error('no project gate configured');
  const directory = gateLogDirectory(project);
  const before = fingerprint(root);
  const run = randomUUID();
  const revision = await withState(root, key, (state) => {
    invalidate(state);
    state.gate = run;
    return state.revision;
  });
  // The full output goes to the log; the agent gets one line per step and the failing tail.
  // Each run creates its own file, so overlapping runs keep both logs and an existing
  // link is never written through.
  const log = join(directory, `gate-${key.slice(0, 12)}-${run.slice(0, 8)}.log`);
  const fd = openSync(log, 'wx', 0o600);
  const deadline = Date.now() + GATE_TIMEOUT;
  const lines: string[] = [];
  let failed: { label: string; offset: number } | null = null;
  try {
    for (const step of gateSteps(config.gate)) {
      const label = step.join(' ');
      if (failed) {
        lines.push(`  skip  ${label}`);
        continue;
      }
      const offset = fstatSync(fd).size;
      writeSync(fd, `$ ${label}\n`);
      const started = Date.now();
      const result = spawnSync(step[0]!, step.slice(1), {
        cwd: root,
        stdio: ['inherit', fd, fd],
        timeout: Math.max(1, deadline - started),
        shell: false,
      });
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (result.status === 0 && !result.error) {
        lines.push(`  pass  ${label} (${seconds}s)`);
        continue;
      }
      const why = result.error
        ? result.error.message
        : result.signal
          ? `signal ${result.signal}`
          : `exit ${result.status}`;
      lines.push(`  FAIL  ${label} (${why}, ${seconds}s)`);
      failed = { label, offset };
    }
  } finally {
    closeSync(fd);
  }
  const summary = [`workflow: gate steps`, ...lines];
  if (failed) {
    summary.push(
      `workflow: last ${GATE_TAIL} lines of ${failed.label}`,
      lastLines(log, failed.offset, GATE_TAIL),
    );
  }
  summary.push(`workflow: full gate log ${log}`);
  process.stdout.write(summary.join('\n') + '\n');
  const after = fingerprint(root);
  const passed = await withState(root, key, (state) => {
    if (failed) return 'checks failed or timed out';
    if (before !== after) return 'source tree changed during checks';
    if (state.revision !== revision || state.gate !== run) {
      return 'overlapped a guarded mutation or unclassified tool';
    }
    state.pass = { tree: after, command: config.gate!, at: new Date().toISOString() };
    state.gate = null;
    return true;
  });
  if (passed !== true) throw new Error(`gate failed: ${passed}; fix the cause and rerun`);
  process.stdout.write('workflow: gate passed on the current tree\n');
}
