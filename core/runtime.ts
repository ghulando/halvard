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
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { currentBranch, findRoot, inside, loadProject, matches, projectPath } from './project.ts';
import { startupContext } from './context.ts';
import { commands, isShipping, rootGit, shellKind } from './guard/shell.ts';
import { normalize } from './guard/tools.ts';
import { HOOK_BUDGET, digest, fingerprint, sessionKey, withState } from './state.ts';
import { hasReview } from './workflow/review.ts';
import { evaluatePolicy } from './guard/policy.ts';
import { parseCommand } from './cli.ts';
import { planIntact, readTask } from './workflow/tasks.ts';
import { assignment, providers } from './config/reviewers.ts';
import { workspaceRoot } from './config/paths.ts';
import { packageDigest } from './install/package.ts';
import { claimsDone, completionStatus } from './workflow/status.ts';
import { PLAN_CHANGED } from './workflow/complete.ts';
import { protectedPatterns } from './guard/protected.ts';
import { pluginRoot, quote } from './shared/plugin.ts';

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

// A hand-written task without workflow metadata has no recorded approval to protect.
function planStands(project: Project, file: string) {
  try {
    return planIntact(readTask(project, file));
  } catch {
    return true;
  }
}
