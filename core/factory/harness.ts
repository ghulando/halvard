import type { FactoryConfig, Harness } from '../types.ts';
import { spawn } from 'node:child_process';
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODEL_KEY_NAMES } from '../flow-config.ts';
import { pluginRoot } from '../shared/plugin.ts';
import { hostResult } from '../workflow/review.ts';

export type Stage = 'plan' | 'build';

// Everything a runner started that must not outlive it: agent and child process groups and
// their containers. An exit, including the second Ctrl-C, ends them all.
const live = new Set<() => void>();
process.on('exit', () => {
  for (const end of live) end();
});

// Children run detached in their own process group, so a signal reaches everything they
// started. The group may already be gone.
function signalGroup(pid: number | undefined, signal: NodeJS.Signals) {
  try {
    process.kill(-pid!, signal);
  } catch {}
}

// Model credentials the harnesses need. Every other variable that looks like a credential
// is removed, so an agent does not use one by accident; this is not a boundary against
// an agent that reads the user's files, which needs the containers of a later phase.
const MODEL_KEYS = new Set(MODEL_KEY_NAMES);
const CREDENTIAL =
  /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_API_KEY$|_ACCESS_KEY|^AWS_|^AZURE_|^NPM_CONFIG__?AUTH|^NODE_AUTH/i;

// Credentials the agent must never hold: the runner alone pushes and talks to GitHub.
const SECRETS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'SSH_AUTH_SOCK',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'HALVARD_REVIEW',
  'PI_REVIEW',
];

// The environment for everything that runs repository or agent code: agent runs, setup,
// the gate and the reviewer. Git can still read and commit locally but cannot push.
export function scrubbedEnv(
  ghConfig: string,
  extra: Record<string, string> = {},
  base: NodeJS.ProcessEnv = process.env,
) {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of SECRETS) delete env[key];
  for (const key of Object.keys(env)) {
    if (CREDENTIAL.test(key) && !MODEL_KEYS.has(key)) delete env[key];
  }
  delete env.HALVARD_UNATTENDED;
  delete env.HALVARD_READONLY;
  const offset = Number(base.GIT_CONFIG_COUNT) || 0;
  const overrides = [
    ['credential.helper', ''],
    ['remote.origin.pushurl', 'no-push://factory-agent'],
    ['core.askPass', ''],
  ];
  overrides.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${offset + i}`] = key!;
    env[`GIT_CONFIG_VALUE_${offset + i}`] = value!;
  });
  env.GIT_CONFIG_COUNT = String(offset + overrides.length);
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_SSH_COMMAND = 'false';
  // An empty gh configuration directory leaves the gh CLI without a stored login.
  env.GH_CONFIG_DIR = ghConfig;
  return { ...env, ...extra };
}

export const agentEnv = (stage: Stage, ghConfig: string, base: NodeJS.ProcessEnv = process.env) =>
  scrubbedEnv(
    ghConfig,
    { HALVARD_UNATTENDED: '1', ...(stage === 'plan' ? { HALVARD_READONLY: '1' } : {}) },
    base,
  );

// The headless command line for one agent run. The prompt is in promptFile as well, for
// hosts that read it from a file; output names Codex's last-message file.
export function agentCommand(
  harness: Harness,
  stage: Stage,
  {
    prompt,
    promptFile,
    output,
    workspace,
    budgetUsd,
    config,
  }: {
    prompt: string;
    promptFile: string;
    output: string;
    workspace: string;
    budgetUsd: number;
    config: FactoryConfig;
  },
) {
  const extra = config.harnessArgs[harness] ?? [];
  const auth = config.auth[harness] ?? 'subscription';
  if (harness === 'claude') {
    return [
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
    ];
  }
  if (harness === 'grok') {
    // Grok's headless mode reads the prompt from a file, not stdin.
    return [
      'grok',
      '--prompt-file',
      promptFile,
      '--output-format',
      'json',
      '--no-auto-update',
      ...extra,
    ];
  }
  if (harness === 'cursor') {
    return [
      'cursor-agent',
      '-p',
      '--output-format',
      'json',
      ...(stage === 'plan' ? ['--mode', 'ask'] : ['--force']),
      ...extra,
      prompt,
    ];
  }
  if (harness === 'codex') {
    return [
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
    ];
  }
  return ['pi', '-p', ...extra, `@${promptFile}`];
}

export interface AgentResult {
  text: string;
  costUsd: number;
  exitCode: number | null;
  timedOut: boolean;
  error: string | null;
}

// The final message and the reported cost. Hosts other than Claude report no dollars.
export function agentResult(harness: Harness, stdout: string, output: string) {
  if (harness === 'claude') {
    const envelope = JSON.parse(stdout) as {
      result?: unknown;
      is_error?: unknown;
      total_cost_usd?: unknown;
    };
    const costUsd = typeof envelope.total_cost_usd === 'number' ? envelope.total_cost_usd : 0;
    if (envelope.is_error || typeof envelope.result !== 'string') {
      return { text: '', costUsd, error: `Claude reported an error: ${String(envelope.result)}` };
    }
    return { text: envelope.result, costUsd, error: null };
  }
  if (harness === 'grok' || harness === 'cursor') {
    try {
      return { text: hostResult(harness, stdout), costUsd: 0, error: null };
    } catch (err) {
      return { text: '', costUsd: 0, error: (err as Error).message };
    }
  }
  if (harness === 'codex') return { text: readFileSync(output, 'utf8'), costUsd: 0, error: null };
  return { text: stdout, costUsd: 0, error: null };
}

// Runs one agent in its own process group, kills the group at the deadline, and logs
// stdout and stderr to log.
export function runAgent(
  harness: Harness,
  stage: Stage,
  {
    cwd,
    prompt,
    workspace,
    budgetUsd,
    config,
    env,
    log,
    timeoutSeconds,
    shouldStop = () => false,
    wrap,
  }: {
    cwd: string;
    prompt: string;
    workspace: string;
    budgetUsd: number;
    config: FactoryConfig;
    env: NodeJS.ProcessEnv;
    log: string;
    timeoutSeconds: number;
    // Polled every few seconds; true stops the agent as an interruption.
    shouldStop?: () => boolean;
    // Runs the command somewhere else, such as a container, given the prompt folder that
    // must be reachable there; cleanup ends whatever the wrapper started.
    wrap?: ((argv: string[], scratch: string) => Wrapped) | undefined;
  },
): Promise<AgentResult> {
  const scratch = mkdtempSync(join(tmpdir(), 'halvard-factory-'));
  const promptFile = join(scratch, 'prompt.md');
  const output = join(scratch, 'last-message.txt');
  writeFileSync(promptFile, prompt, { mode: 0o600 });
  writeFileSync(output, '', { mode: 0o600 });
  const command = agentCommand(harness, stage, {
    prompt,
    promptFile,
    output,
    workspace,
    budgetUsd,
    config,
  });
  const { argv, cleanup } = wrap ? wrap(command, scratch) : { argv: command, cleanup: () => {} };
  const fd = openSync(log, 'a', 0o600);
  writeSync(fd, `$ ${argv.map((part) => (part === prompt ? '<prompt>' : part)).join(' ')}\n`);
  return new Promise<AgentResult>((resolvePromise) => {
    let stdout = '';
    let timedOut = false;
    let interrupted = false;
    let settled = false;
    const finish = (result: AgentResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(kill);
      clearInterval(poll);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      live.delete(end);
      // Nothing the agent started may keep running after its turn, let alone change the
      // tree after the review.
      signal('SIGKILL');
      cleanup();
      closeSync(fd);
      rmSync(scratch, { recursive: true, force: true });
      resolvePromise(result);
    };
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const signal = (name: NodeJS.Signals) => signalGroup(child.pid, name);
    let kill: NodeJS.Timeout | undefined;
    // The agent runs in its own group, so the operator's Ctrl-C reaches only the runner,
    // which stops the agent and parks the job instead of leaving it working alone.
    const stop = () => {
      interrupted = true;
      signal('SIGKILL');
    };
    const end = () => {
      signal('SIGKILL');
      cleanup();
    };
    live.add(end);
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    const poll = setInterval(() => {
      if (shouldStop()) stop();
    }, 5000);
    // SIGINT lets the host end its turn; the group is killed if it does not stop.
    const timer = setTimeout(() => {
      timedOut = true;
      signal('SIGINT');
      kill = setTimeout(() => signal('SIGKILL'), 30000);
    }, timeoutSeconds * 1000);
    child.stdout.on('data', (data: Buffer) => {
      writeSync(fd, data);
      if (stdout.length < 32 * 1024 * 1024) stdout += data;
    });
    child.stderr.on('data', (data: Buffer) => writeSync(fd, data));
    child.stdin.on('error', () => {});
    child.stdin.end(harness === 'codex' || harness === 'claude' ? prompt : '');
    child.on('error', (error) =>
      finish({ text: '', costUsd: 0, exitCode: null, timedOut, error: error.message }),
    );
    child.on('close', (code) => {
      let parsed: { text: string; costUsd: number; error: string | null };
      try {
        parsed = agentResult(harness, stdout, output);
      } catch (err) {
        parsed = {
          text: '',
          costUsd: 0,
          error: `unreadable ${harness} output: ${(err as Error).message}`,
        };
      }
      let error = parsed.error ?? (code === 0 ? null : `${harness} exited ${code}`);
      if (timedOut) error = 'agent run timed out';
      if (interrupted) error = 'interrupted';
      finish({ ...parsed, exitCode: code, timedOut, error });
    });
  });
}

export interface Wrapped {
  argv: string[];
  cleanup: () => void;
}

export interface ChildResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Runs a setup step, the gate, a review or task-done without blocking the runner, so jobs
// that run side by side keep reading their agents' output. The process group, and whatever
// cleanup names, ends at the deadline.
export function runChild(
  argv: string[],
  {
    cwd,
    env,
    timeoutMs,
    log,
    cleanup = () => {},
    shouldStop = () => false,
  }: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    log: string;
    cleanup?: () => void;
    // Polled every few seconds; true ends the child as if it had failed.
    shouldStop?: () => boolean;
  },
): Promise<ChildResult> {
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const end = () => {
      signalGroup(child.pid, 'SIGKILL');
      cleanup();
    };
    const timer = setTimeout(end, timeoutMs);
    const poll = setInterval(() => {
      if (shouldStop()) end();
    }, 5000);
    live.add(end);
    child.stdout.on('data', (data: Buffer) => {
      if (stdout.length < 32 * 1024 * 1024) stdout += data;
    });
    child.stderr.on('data', (data: Buffer) => {
      if (stderr.length < 32 * 1024 * 1024) stderr += data;
    });
    let finished = false;
    const done = (status: number | null, error?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(poll);
      live.delete(end);
      end();
      writeFileSync(log, `$ ${argv.join(' ')}\n${stdout}${stderr}${error ? error + '\n' : ''}\n`, {
        flag: 'a',
        mode: 0o600,
      });
      resolvePromise({ status, stdout, stderr: error ? `${stderr}${error}` : stderr });
    };
    child.on('error', (error) => done(null, error.message));
    child.on('close', (code) => done(code));
  });
}

// The agent's verdict on its own run: the first STATUS line of its final message.
export function agentStatus(text: string) {
  const match = text.match(/^\s*STATUS:\s*(READY|BLOCKED)\b(.*)$/m);
  if (!match)
    return { status: 'BLOCKED' as const, reason: 'the agent ended without a STATUS line' };
  const rest = text.slice(text.indexOf(match[0]) + match[0].length).trim();
  return {
    status: match[1] as 'READY' | 'BLOCKED',
    reason: (match[2]!.replace(/^[\s:.-]+/, '') || rest).slice(0, 2000),
  };
}
