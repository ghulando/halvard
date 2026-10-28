import type { FactoryJob } from '../types.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { options } from '../cli.ts';
import { metrics, writeBoard } from './board.ts';
import { activeRun, lockHolder, jobFile, listJobs, loadJob, lockJob } from './store.ts';
import { say, catchStops, type Context, context } from './context.ts';
import { park, source, newJob, ACTIVE, DONE, blocker } from './jobs.ts';
import { plan, whoAmI, approve, replan } from './plan.ts';
import { build } from './build.ts';
import { shipJob } from './deliver.ts';

// A running job stops at its next check, within seconds while its agent runs; a waiting
// job parks at once.
function stopJob(ctx: Context, id: string) {
  const job = loadJob(ctx.root, id);
  if (job.stage === 'parked' || DONE.includes(job.stage)) {
    throw new Error(`job ${id} is ${job.stage}; there is nothing to stop`);
  }
  writeFileSync(jobFile(ctx.root, id, 'stop'), new Date().toISOString() + '\n', { mode: 0o600 });
  if (lockHolder(jobFile(ctx.root, id, 'runner.lock'))) {
    say(`${id}: asked its runner to stop`);
    return job;
  }
  const unlock = lockJob(ctx.root, id);
  try {
    return park(ctx, loadJob(ctx.root, id), 'stopped-by-human', 'stopped with factory stop');
  } finally {
    unlock();
  }
}

const usage = `halvard factory commands, run from the repository's main checkout in your own terminal:
  factory plan --issue <n> [--id <slug>] [--fix]
  factory plan --brief <file> --title <text> --id <slug> [--fix]
                                Read-only plan run; posts the plan on the issue
  factory approve <job> [--by <name>]
                                Approve the job's plan (or label the issue factory:approved)
  factory build <job> [--no-push] [--retry [--checked]]
                                Build an approved job, run gate and review, open the PR;
                                --retry restarts a parked or interrupted job, --checked
                                confirms you checked a job parked after tampering
  factory run --issue <n> | --brief <file> --title <text> --id <slug> [--fix] [--no-push]
                                Small task: build directly without a plan stage
  factory ship <job>            Push a job built with --no-push and open its PR
  factory rework <job> --note <file>
                                Build a parked job again, with your note for the agent
  factory replan <job>          Plan a job again that has no approved plan
  factory stop <job>            Stop a job: a running one at its next step
  factory serve [--once]        Poll labeled issues and work them until stopped
  factory board [--out <file>]  Write the HTML board and job pages, and print the board's path
  factory metrics               Print the factory's numbers
  factory automerge             Dry run: which pull requests would have merged by themselves
  factory retro [--since <days>] [--no-push]
                                Turn recurring findings into a job that edits guidance
  factory status [<job>]        Print job state
`;

const SPECS: Record<string, { count: [number, number]; options: string[] }> = {
  plan: { count: [0, 0], options: ['issue', 'brief', 'title', 'id', 'fix'] },
  approve: { count: [1, 1], options: ['by'] },
  build: { count: [1, 1], options: ['no-push', 'retry', 'checked'] },
  run: { count: [0, 0], options: ['issue', 'brief', 'title', 'id', 'fix', 'no-push'] },
  status: { count: [0, 1], options: [] },
  rework: { count: [1, 1], options: ['note', 'no-push', 'checked'] },
  replan: { count: [1, 1], options: [] },
  stop: { count: [1, 1], options: [] },
  serve: { count: [0, 0], options: ['once'] },
  board: { count: [0, 0], options: ['out'] },
  metrics: { count: [0, 0], options: [] },
  automerge: { count: [0, 0], options: [] },
  retro: { count: [0, 0], options: ['since', 'no-push'] },
  ship: { count: [1, 1], options: [] },
};

// Commands that only report, or only stop work, run while a job is running.
const REPORTS = ['status', 'board', 'metrics', 'stop'];
// serve checks running jobs and blockers itself on every pass, and keeps polling meanwhile.
const UNCHECKED = [...REPORTS, 'serve'];
// Commands that change a job write the board when they finish; serve writes it after each step.
const BOARDED = ['plan', 'approve', 'build', 'run', 'rework', 'replan', 'stop', 'retro', 'ship'];

// Boolean options the shared parser does not already know.
const FLAGS = new Set(['no-push', 'retry', 'checked', 'once']);

export async function factoryCommand(cwd: string, args: string[]) {
  const [verb, ...rest] = args;
  if (!verb || verb === 'help' || verb === '--help') {
    process.stdout.write(usage);
    return;
  }
  const spec = Object.hasOwn(SPECS, verb) ? SPECS[verb]! : null;
  if (!spec) throw new Error(`unknown factory command: ${verb}`);
  // Boolean options take no value; the shared parser handles the rest.
  const values = rest.flatMap((arg) =>
    FLAGS.has(arg.slice(2)) && arg.startsWith('--') ? [arg, 'yes'] : [arg],
  );
  const { positional, flags } = options(values, spec.options);
  if (positional.length < spec.count[0] || positional.length > spec.count[1]) {
    throw new Error(`factory ${verb} takes ${spec.count[1]} positional argument(s)`);
  }
  const ctx = context(cwd);
  const print = (value: unknown) => {
    // The board is a view of the job files; failing to write it never fails the command.
    if (BOARDED.includes(verb)) {
      try {
        say(`board at ${writeBoard(ctx.root)}`);
      } catch (err) {
        say(`board: ${(err as Error).message}`);
      }
    }
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
    // Scripts can tell a parked job from a shipped one; status is only a report.
    if (!REPORTS.includes(verb) && (value as FactoryJob | null)?.stage === 'parked') {
      process.exitCode = 3;
    }
  };
  // An agent inside a run inherits the user's shell; it must not approve or start work.
  // The auto-merge dry run only reads, but it fetches the base with your credentials, so it
  // waits for a tampered job to be checked like the commands that start work.
  const running = UNCHECKED.includes(verb) || verb === 'automerge' ? null : activeRun(ctx.root);
  if (running) {
    throw new Error(`factory job ${running} is running; wait until its runner exits`);
  }
  // A tampered run may have left Git configuration that would run with the runner's
  // credentials on the next fetch, so nothing starts until a human has looked.
  const checked = ['build', 'rework'].includes(verb) && flags.checked ? positional[0] : undefined;
  const blocked = UNCHECKED.includes(verb) ? null : blocker(ctx.root, checked);
  if (blocked) {
    throw new Error(
      `${blocked}. Check your Git configuration, personal settings and the job file, then run factory build <job> --retry --checked, or remove the job's folder`,
    );
  }
  if (verb === 'board') {
    process.stdout.write(
      writeBoard(ctx.root, typeof flags.out === 'string' ? resolve(flags.out) : undefined) + '\n',
    );
    return;
  }
  if (verb === 'metrics') {
    print(metrics(ctx.root));
    return;
  }
  if (verb === 'stop') {
    print(stopJob(ctx, positional[0]!));
    return;
  }
  if (verb === 'ship') {
    print(shipJob(ctx, positional[0]!));
    return;
  }
  if (verb === 'automerge') {
    const { autoMergeReport } = await import('./outcomes.ts');
    print(autoMergeReport(ctx.root, ctx.project.config.workflow.baseBranch, ctx.factory.autoMerge));
    return;
  }
  if (verb === 'retro') {
    const { retroSource } = await import('./retro.ts');
    let days: number | undefined;
    if (flags.since !== undefined) {
      if (typeof flags.since !== 'string' || !/^[1-9][0-9]{0,2}$/.test(flags.since)) {
        throw new Error('--since takes a number of days, 1..999');
      }
      days = Number(flags.since);
    }
    const { source: retro, reason } = retroSource(ctx, new Date(), days);
    if (!retro) throw new Error(`no retro: ${reason}`);
    const job = newJob(ctx, retro, true, false);
    print(await build(ctx, job.id, !flags['no-push']));
    return;
  }
  // Long-running commands park their job on Ctrl-C instead of dying mid-step.
  catchStops();
  if (verb === 'serve') {
    const { serve } = await import('./serve.ts');
    await serve(ctx, { once: Boolean(flags.once) });
    return;
  }
  if (verb === 'replan') {
    print(await replan(ctx, positional[0]!));
    return;
  }
  if (verb === 'rework') {
    if (typeof flags.note !== 'string') throw new Error('rework needs --note <file>');
    const note = readFileSync(flags.note, 'utf8').trim();
    if (!note || note.length > 64 * 1024)
      throw new Error('the rework note must be 1 byte to 64 KiB');
    const target = loadJob(ctx.root, positional[0]!);
    if (target.stage !== 'parked' && !ACTIVE.includes(target.stage)) {
      throw new Error(
        `job ${target.id} is ${target.stage}; rework takes a parked or interrupted job`,
      );
    }
    writeFileSync(jobFile(ctx.root, positional[0]!, `rework-${Date.now()}.md`), note + '\n', {
      mode: 0o600,
    });
    print(await build(ctx, positional[0]!, !flags['no-push'], { retry: true, note }));
    return;
  }
  if (verb === 'status') {
    print(
      positional[0]
        ? loadJob(ctx.root, positional[0])
        : listJobs(ctx.root).map(({ id, stage, title, pr, parked }) => ({
            id,
            stage,
            title,
            pr,
            parked,
          })),
    );
    return;
  }
  if (verb === 'approve') {
    print(
      approve(
        ctx,
        loadJob(ctx.root, positional[0]!),
        typeof flags.by === 'string' ? flags.by : whoAmI(ctx.root),
      ),
    );
    return;
  }
  if (verb === 'build') {
    print(await build(ctx, positional[0]!, !flags['no-push'], { retry: Boolean(flags.retry) }));
    return;
  }
  const job = newJob(ctx, source(ctx, flags), verb === 'run', Boolean(flags.fix));
  print(verb === 'plan' ? await plan(ctx, job) : await build(ctx, job.id, !flags['no-push']));
}
