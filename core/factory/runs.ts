import type { FactoryJob } from './store.ts';
import type { Harness } from '../types.ts';
import { resolve } from 'node:path';
import { pluginRoot } from '../shared/plugin.ts';
import {
  agentStatus,
  runAgent,
  runChild,
  type ChildResult,
  type AgentResult,
  type Stage,
  agentEnv,
} from './harness.ts';
import { boxed, ghShield, runnerBox, runnerEnv, checkoutMounts, listedEnv } from './isolation.ts';
import { jobFile, recordEvent, saveJob } from './store.ts';
import { say, type Context } from './context.ts';
import { Parked, halted, stopAsked } from './jobs.ts';

const runner = () => resolve(pluginRoot, 'bin/halvard.ts');

export const SETUP_TIMEOUT_MS = 20 * 60 * 1000;
export const GATE_TIMEOUT_MS = 21 * 60 * 1000;
export const HOLDOUT_TIMEOUT_MS = 30 * 60 * 1000;
export const TASK_DONE_TIMEOUT_MS = 5 * 60 * 1000;
export const PUSH_TIMEOUT_MS = 5 * 60 * 1000;

export async function agent(
  ctx: Context,
  job: FactoryJob,
  stage: Stage,
  cwd: string,
  workspace: string,
  prompt: string,
  harness: Harness = job.author,
): Promise<AgentResult> {
  const remaining = ctx.factory.budgetUsd - job.costUsd;
  if (remaining < 0.05) {
    return { text: '', costUsd: 0, exitCode: null, timedOut: false, error: 'budget spent' };
  }
  const started = Date.now();
  say(`${job.id}: ${stage} run with ${harness}`);
  const result = await runAgent(harness, stage, {
    cwd,
    prompt,
    workspace,
    budgetUsd: remaining,
    config: ctx.factory,
    env: { ...agentEnv(stage, ghShield(ctx, job)), ...listedEnv(ctx) },
    log: jobFile(ctx.root, job.id, 'agent.log'),
    timeoutSeconds: ctx.factory.timeouts[stage],
    wrap: ctx.factory.container
      ? (argv, scratch) =>
          boxed(ctx, job, `${stage}-${harness}`, argv, {
            workdir: cwd,
            mounts: [
              ...checkoutMounts(cwd),
              { path: scratch, readonly: false },
              ...(workspace !== cwd ? [{ path: workspace, readonly: false }] : []),
            ],
            env: ['HALVARD_UNATTENDED', ...(stage === 'plan' ? ['HALVARD_READONLY'] : [])],
          })
      : undefined,
    shouldStop: stopAsked(ctx, job),
  });
  job.costUsd += result.costUsd;
  saveJob(ctx.root, job);
  recordEvent(ctx.root, job.id, 'agent', {
    stage,
    harness,
    costUsd: result.costUsd,
    seconds: Math.round((Date.now() - started) / 1000),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    error: result.error,
  });
  return result;
}

// An agent run that ended without an answer parks the job.
export function checkAgentRun(ctx: Context, job: FactoryJob, result: AgentResult) {
  if (result.error === 'interrupted') {
    throw new Parked('stopped-by-human', halted(ctx, job) ?? 'the agent was stopped');
  }
  if (result.error === 'budget spent') {
    throw new Parked('budget-usd', `spent $${job.costUsd.toFixed(2)}`);
  }
  if (result.error) throw new Parked(result.timedOut ? 'budget-time' : 'infra', result.error);
}

export function checkReady(result: AgentResult) {
  const status = agentStatus(result.text);
  if (status.status === 'BLOCKED') throw new Parked('agent-blocked', status.reason);
}

// The gate, the review and task-done run in child processes, in a container in container
// mode, with the scrubbed environment, because they execute code the agent may have written.
export function runnerChild(
  ctx: Context,
  job: FactoryJob,
  checkout: string,
  args: string[],
  timeoutMs: number,
): Promise<ChildResult> {
  const { argv, cleanup } = ctx.factory.container
    ? boxed(
        ctx,
        job,
        args[0]!,
        ['node', ctx.factory.container.runner, ...args],
        runnerBox(ctx, job, checkout),
      )
    : { argv: [process.execPath, runner(), ...args], cleanup: () => {} };
  return runChild(argv, {
    cwd: checkout,
    env: runnerEnv(ctx, job),
    timeoutMs,
    log: jobFile(ctx.root, job.id, 'runner.log'),
    cleanup,
    shouldStop: stopAsked(ctx, job),
  });
}

// Docker itself failing is not the agent's failure: no daemon, no image, a clash.
export const dockerFailed = (ctx: Context, run: ChildResult) =>
  Boolean(ctx.factory.container) && (run.status === null || run.status === 125);
