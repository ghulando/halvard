#!/usr/bin/env node
import { parseCommand } from '../core/cli.ts';
import { readFileSync } from 'node:fs';
import { approveFromTerminal } from '../core/runtime.ts';
import { runGate } from '../core/workflow/gate.ts';

const help = `halvard commands (<harness> is pi, claude, codex, grok or cursor):
  install-plan <repo> [--repair]    Preview project installation
  install <repo> [--repair]         Install repo adapters, preserving settings
  install-user                    Preview personal installation
  install-user --repair            Preview same-version content repair
  install-user --repair --apply    Repair a same-version content mismatch
  install-user --apply             Apply the personal installation
  setup <repo>                     Print a read-only setup proposal as JSON
  setup-apply <repo> <proposal>     Apply a reviewed, current proposal
  bootstrap <repo>                 Print stack records and repo state as JSON
  bootstrap-apply <repo> <plan>     Apply a confirmed, current bootstrap plan
  task-start <id> <title> --author <harness> [--fix] [--small]
             [--brief <file>] [--base <ref>] [--plan <file> --approved-by <name>]
  task-done <task-file> --gate-session <session-key> [--plan <digest>|none]
                                    Mark done when the session's gate and the review cover this tree
  task-resume <task-file>           Read portable task and current worktree
  task-handoff <task-file> --author <harness>
  review <task-file> --author <harness> --reviewer claude|codex|grok|cursor|ollama --round <number> --gate-session <session-key>
  review <task-file> --author <harness> --reviewer <harness> --round <number> --gate-session <session-key> --pane
                                    Record a team pane's <reviewer>-verdict-round<N>.json
  doctor [--author <harness>]      Diagnose configuration and install drift
  review-recover <task-file>       Recover a stopped review without erasing reports
  review-recover <task-file> --stopped-reviewer  Attest a stopped reviewer with missing PID
  review-status <task-file>         Show recorded independent reviews
  gate <session-key>               Run configured checks for this session
  approve <session-key> <request>  Approve one guarded operation; run it in your own terminal
  factory <plan|approve|build|run|status> ...
                                    Run the software factory; see docs/factory.md
  history-plan --harness claude,pi,codex|all  Preview history and save a private plan
  history-digest --harness claude,pi,codex|all  Print compact session digests
  history-clean <plan-file> --confirm DELETE  Delete reviewed entries, skipping changed ones
  retro-events <task-id>           Print a task's workspace files and workflow events
  team show                        Print this repository's Herdr team
  team set --lead <harness> --dev <harness> --reviewer <harness> [--investigator <harness>|none]
           [--watch on|off] [--nudge on|off] [--approve reads-edits-gate|none]
                                    Save the team in .halvard.json
`;

const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');

try {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') {
    process.stdout.write(help);
  } else if (command === 'factory') {
    // The factory has its own subcommand grammar.
    const { factoryCommand } = await import('../core/factory/command.ts');
    await factoryCommand(process.cwd(), args);
  } else {
    const { positional, flags } = parseCommand(command, args);
    switch (command) {
      case 'history-plan':
      case 'history-digest':
      case 'history-clean': {
        const { planClean, saveCleanPlan, digestHistory, applyClean, historyHarnesses } =
          await import('../core/workflow/clean-history.ts');
        if (command === 'history-clean') {
          print(applyClean(positional[0]!, flags.confirm as string));
        } else if (command === 'history-digest') {
          print(await digestHistory({ harnesses: historyHarnesses(flags.harness as string) }));
        } else {
          const plan = planClean({ harnesses: historyHarnesses(flags.harness as string) });
          print({ ...plan, planFile: saveCleanPlan(plan) });
        }
        break;
      }
      case 'gate':
        await runGate(process.cwd(), positional[0]!);
        break;
      case 'approve':
        process.stdout.write(
          (await approveFromTerminal(process.cwd(), positional[0]!, positional[1]!)) + '\n',
        );
        break;
      case 'team': {
        const { setTeam, showTeam } = await import('../core/workflow/team.ts');
        if (positional[0] === 'show') print(showTeam(process.cwd()));
        else if (positional[0] === 'set') print(setTeam(process.cwd(), flags));
        else throw new Error('team takes show or set');
        break;
      }
      case 'retro-events': {
        const { retroEvents } = await import('../core/workflow/retro.ts');
        print(await retroEvents(process.cwd(), positional[0]!));
        break;
      }
      case 'install':
      case 'install-plan': {
        const { install, installPlan } = await import('../core/install/install.ts');
        if (command === 'install-plan') {
          print(installPlan(positional[0]!, flags));
        } else {
          install(positional[0]!, flags);
        }
        break;
      }
      case 'install-user': {
        const { personalInstallPlan, installPersonal } =
          await import('../core/install/personal.ts');
        const options = { repair: flags.repair as boolean | undefined };
        print(
          flags.apply
            ? installPersonal(undefined, undefined, options)
            : personalInstallPlan(undefined, undefined, options),
        );
        break;
      }
      case 'setup': {
        const { proposeSetup } = await import('../core/setup/setup.ts');
        print(proposeSetup(positional[0]!));
        break;
      }
      case 'setup-apply': {
        const { applySetup } = await import('../core/setup/setup.ts');
        print(applySetup(positional[0]!, positional[1]!));
        break;
      }
      case 'bootstrap': {
        const { bootstrapReport } = await import('../core/setup/bootstrap.ts');
        print(bootstrapReport(positional[0]!));
        break;
      }
      case 'bootstrap-apply': {
        const { applyBootstrap } = await import('../core/setup/bootstrap.ts');
        print(applyBootstrap(positional[0]!, positional[1]!));
        break;
      }
      case 'doctor': {
        const { doctor } = await import('../core/setup/doctor.ts');
        const result = doctor(process.cwd(), flags.author as string);
        print(result);
        if (result.issues.length) process.exitCode = 1;
        break;
      }
      case 'task-start': {
        const { startTask } = await import('../core/workflow/tasks.ts');
        const text = (name: string) =>
          typeof flags[name] === 'string' ? readFileSync(flags[name], 'utf8') : undefined;
        print(
          startTask(process.cwd(), {
            id: positional[0]!,
            title: positional[1]!,
            author: flags.author as string,
            fix: flags.fix === true,
            small: flags.small === true,
            brief: text('brief'),
            base: flags.base as string | undefined,
            plan: text('plan'),
            approvedBy: flags['approved-by'] as string | undefined,
          }),
        );
        break;
      }
      case 'task-done': {
        const { completeTask } = await import('../core/workflow/complete.ts');
        // A runner passes the approved plan's digest it holds, or none for a task without one.
        const plan = flags.plan as string | undefined;
        if (plan !== undefined && plan !== 'none' && !/^[a-f0-9]{64}$/.test(plan)) {
          throw new Error('--plan takes a plan digest or none');
        }
        print(
          await completeTask(
            process.cwd(),
            positional[0]!,
            flags['gate-session'] as string,
            plan === undefined ? undefined : { plan: plan === 'none' ? null : plan },
          ),
        );
        break;
      }
      case 'task-resume': {
        const { resumeTask } = await import('../core/workflow/tasks.ts');
        print(resumeTask(process.cwd(), positional[0]!));
        break;
      }
      case 'task-handoff': {
        const { handoffTask } = await import('../core/workflow/tasks.ts');
        print(handoffTask(process.cwd(), positional[0]!, flags.author as string));
        break;
      }
      case 'review': {
        const { runReview } = await import('../core/workflow/review.ts');
        const result = await runReview(process.cwd(), positional[0]!, {
          ...flags,
          author: flags.author as string,
          reviewer: flags.reviewer as string,
          round: Number(flags.round),
          gateSession: flags['gate-session'] as string,
        });
        print(result);
        if (result.verdict !== 'pass') process.exitCode = 2;
        break;
      }
      case 'review-recover': {
        const { recoverReview } = await import('../core/workflow/review.ts');
        print(
          await recoverReview(process.cwd(), positional[0]!, {
            stoppedReviewer: flags['stopped-reviewer'] as boolean | undefined,
          }),
        );
        break;
      }
      case 'review-status': {
        const { loadProject } = await import('../core/project.ts');
        const { readTask } = await import('../core/workflow/tasks.ts');
        const { reviewKey } = await import('../core/workflow/review.ts');
        const { withState } = await import('../core/state.ts');
        const project = loadProject(process.cwd());
        const task = readTask(project, positional[0]!);
        print(
          await withState(project.root, reviewKey(task), (state) => ({
            first: state.first ?? null,
            second: state.second ?? null,
            history: state.history ?? [],
            extraReviews: state.extraReviews ?? [],
            additionalReviewAuthorization: state.additionalReviewAuthorization ?? null,
            running: state.running ?? null,
          })),
        );
        break;
      }
    }
  }
} catch (err) {
  process.stderr.write(`halvard: ${(err as Error).message}\n`);
  process.exitCode = 1;
}
