import type { FactoryJob, Receipt, ReviewRecord } from './types.ts';
import { spawnSync } from 'node:child_process';
import { matches } from './project.ts';

export interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

// The runner's own commands: they keep its credentials, unlike anything that runs
// repository or agent code.
export function exec(command: string, args: string[], cwd: string, timeout = 120000): Run {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.error ? null : result.status,
    stdout: result.stdout ?? '',
    stderr: result.error ? result.error.message : (result.stderr ?? ''),
  };
}

export function check(command: string, args: string[], cwd: string, timeout?: number) {
  const run = exec(command, args, cwd, timeout);
  if (run.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${(run.stderr || run.stdout).trim().slice(-2000)}`,
    );
  }
  return run.stdout;
}

// Repository hooks are code the agent could have changed; the runner never runs them.
export const gitRunner = (cwd: string, args: string[], timeout?: number) =>
  check(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    cwd,
    timeout,
  );

export const hasOrigin = (root: string) =>
  exec('git', ['remote', 'get-url', 'origin'], root).status === 0;

// The base the job starts from: the remote's branch after a fetch, or the local branch
// in a repository without a remote.
export function baseRef(root: string, branch: string) {
  if (!hasOrigin(root)) return branch;
  gitRunner(root, ['fetch', '--quiet', 'origin', branch], 300000);
  return `origin/${branch}`;
}

export function changedFiles(worktree: string, base: string) {
  return [
    ...new Set(
      [
        // Without rename detection a move lists its old path too, so a file moved out of a
        // risk path or a job's scope still counts there.
        ...gitRunner(worktree, ['diff', '--name-only', '--no-renames', '-z', base, '--']).split(
          '\0',
        ),
        ...gitRunner(worktree, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
      ].filter(Boolean),
    ),
  ].sort();
}

export function riskLevel(files: string[], riskPaths: string[]) {
  const risky = files.filter((file) => matches(file, riskPaths));
  return { level: risky.length ? ('high' as const) : ('normal' as const), risky };
}

export interface HoldoutResult {
  name: string;
  passed: boolean;
  blocking: boolean;
}

export interface Evidence {
  job: FactoryJob;
  base: string;
  gate: Receipt;
  review: ReviewRecord;
  files: string[];
  diffStat: string;
  risk: { level: 'high' | 'normal'; risky: string[] };
  holdout: HoldoutResult[];
  change: { class: string | null; lines: number; firstTry: boolean };
}

// The pull request body: what was asked, what checked it, and what a reviewer should read.
export function evidenceMarkdown({
  job,
  base,
  gate,
  review,
  files,
  diffStat,
  risk,
  holdout,
  change,
}: Evidence) {
  const findings = review.findings.length
    ? review.findings.map((f) => `- ${f.severity} at \`${f.location}\`: ${f.problem}`).join('\n')
    : '- None.';
  return [
    job.issue ? `Closes #${job.issue.number}.` : `Factory job \`${job.id}\`.`,
    '',
    `Built by the Halvard factory: author ${job.author}, reviewed by ${review.reviewer}. Merging stays with a human.`,
    '',
    '## Plan',
    '',
    job.plan
      ? `Approved by ${job.plan.approvedBy} at ${job.plan.at}; plan digest \`${job.plan.digest.slice(0, 16)}\`. The task file holds the approved plan.`
      : 'Small task: built from the brief without a plan stage.',
    '',
    '## Gate',
    '',
    `Passed at ${gate.at ?? 'unknown time'} on tree \`${gate.tree.slice(0, 16)}\`, run by the factory runner with its own session key.`,
    '',
    '```',
    JSON.stringify(gate.command),
    '```',
    '',
    '## Independent review',
    '',
    `Round ${review.round} by ${review.reviewer} (model ${review.model}): **${review.verdict}** on tree \`${review.tree.slice(0, 16)}\`.`,
    '',
    findings,
    '',
    '<details><summary>Standards and spec evidence</summary>',
    '',
    review.standards,
    '',
    review.spec,
    '',
    '</details>',
    '',
    ...(holdout.length
      ? [
          '## Holdout checks',
          '',
          'Checks kept outside the repository, run by the runner after the gate. Their output stays with the runner.',
          '',
          ...holdout.map(
            (check) =>
              `- ${check.name}: ${check.passed ? 'passed' : 'failed'}${check.blocking ? '' : ' (not blocking)'}`,
          ),
          '',
        ]
      : []),
    '## Change',
    '',
    `Base \`${base}\`. Risk: **${risk.level}**${risk.risky.length ? `; touches ${risk.risky.map((file) => `\`${file}\``).join(', ')}` : ''}. Class: ${change.class ? `\`${change.class}\`` : 'none'}; ${Number.isFinite(change.lines) ? `${change.lines} lines` : 'binary files'}; ${change.firstTry ? 'gate and review passed first time' : 'needed fixes'}.`,
    '',
    '```',
    diffStat.trim() || `${files.length} files`,
    '```',
    '',
    `Cost reported by the agent runs: $${job.costUsd.toFixed(2)}. Fix passes: ${job.fixPasses}.`,
    '',
  ].join('\n');
}

// gh runs with the runner's own login; it never reaches the agent.
export const gh = (root: string, args: string[]) => exec('gh', args, root, 120000);
