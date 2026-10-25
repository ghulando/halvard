# Factory

Factory mode runs one task end to end without you at the keyboard. It is the third way to use Halvard, next to solo and team. A runner, which is plain code and not a model, starts a harness headless in its own worktree. The runner runs the gate and the cross-harness review itself, commits, pushes the branch and opens a pull request. You approve the plan for larger tasks, decide parked jobs and merge every pull request.

You can start jobs from your terminal, or let `factory serve` pick up labeled GitHub issues. Jobs run one at a time, each in a worktree on your machine. Containers come in a later phase.

## Flow

```mermaid
flowchart TD
    src["GitHub issue or brief file"] --> small{"Small task?"}
    small -- "no: factory plan" --> plan["Plan run, read-only: criteria, plan, out of scope, assumptions"]
    plan --> post["Plan saved and posted on the issue"]
    post --> ok{"You approve: factory approve, or label factory:approved"}
    ok --> build
    small -- "yes: factory run" --> build["Build run, headless and unattended, in a fresh worktree"]
    build --> gate{"Runner's gate passes?"}
    approved["Optional: another harness writes frozen acceptance tests"] -.-> build
    gate -- "no, fix pass left" --> build
    gate -- yes --> review{"Independent review passes?"}
    review -- "blocked round 1, fix pass left" --> build
    review -- pass --> ship["Runner marks done, commits, pushes, opens a draft PR with evidence"]
    ship --> merge["You review and merge"]
    gate -- "no fix pass left" --> park["Parked: comment on the issue"]
    review -- "blocked round 2" --> park
    build -- "STATUS: BLOCKED, timeout, budget" --> park
```

## Configure

Add a `factory` block to `.halvard.json`. Every key is optional:

```json
{
  "workflow": {"reviewers": {"grok": {}, "claude": {}, "cursor": {}}},
  "factory": {
    "author": "claude",
    "reviewers": ["grok", "cursor"],
    "setup": [["npm", "ci", "--omit=peer"]],
    "auth": {"claude": "subscription", "grok": "api"},
    "harnessArgs": {"grok": []},
    "timeouts": {"plan": 900, "build": 2700},
    "budgetUsd": 5,
    "maxFixPasses": 2,
    "draft": true,
    "riskPaths": ["deploy/**"],
    "monthlyUsd": 200,
    "pollSeconds": 300,
    "tests": {"by": "grok", "dir": "tests/acceptance"}
  }
}
```

| Key | Default | Effect |
| --- | --- | --- |
| `author` | `claude` | The harness that plans and builds. |
| `reviewers` | eligible reviewers in `workflow.reviewers` | Reviewer order for round 1. The first one whose CLI answers `--version` reviews. Round 2 always uses the round 1 reviewer, so a job parks if that reviewer stops answering. Keep these entries without a `reviewer` assignment, because an assignment allows only one reviewer. |
| `setup` | none | Commands run in the fresh worktree after the task branch exists, such as installing dependencies. |
| `auth` | `subscription` | Claude only: `api` runs `claude --bare --plugin-dir <halvard>` and needs `ANTHROPIC_API_KEY`; `subscription` runs a normal startup, which reads `CLAUDE_CODE_OAUTH_TOKEN` or your login and also loads your own Claude settings. Other harnesses use whatever credentials their CLI finds. |
| `harnessArgs` | none | Extra arguments per harness. |
| `timeouts` | 900 s plan, 2700 s build | Wall-clock limit per agent run, 60 to 14400 seconds. The runner sends SIGINT, then kills the process group 30 seconds later. |
| `budgetUsd` | 5 | Total agent spend per job. Claude gets the remainder as `--max-budget-usd`; other hosts report no cost, so only their timeouts apply. |
| `maxFixPasses` | 2 | Agent runs after the first build that fix a failed gate or a blocked review round 1, 0 to 3. |
| `draft` | true | Open the pull request as a draft. |
| `riskPaths` | CI and harness settings | Extra patterns that mark a pull request high risk. CI, `.halvard.json` and the harness settings directories are always included. |
| `monthlyUsd` | 200 | Agent spend per calendar month (UTC), summed from the cost each agent run reports. Reviewer runs report no cost, so their spend is not counted. `factory serve` starts no new work, approved builds or retries once 90% of it is spent. |
| `pollSeconds` | 300 | How often `factory serve` checks GitHub, 60 to 3600 seconds. |
| `tests` | none | Frozen acceptance tests. Before the build, the harness named in `by` writes tests for the task's acceptance criteria under `<dir>/<job>/` and nowhere else. The builder must make them pass and may not change them. It must be a different harness from `author`, and your gate must run the tests in that folder. Only that folder is frozen: the builder can still change the test runner's configuration or scripts, so add them to `riskPaths` and read them in the pull request. |

`gh` must be logged in on your machine for issues and pull requests. Without an `origin` remote, the runner builds from the local base branch and only commits.

## Commands

Run these from the repository's main checkout, in your own terminal. The guard denies them in agent sessions, and the runner refuses to start inside an agent run. The examples use a shell alias for the runner in your Halvard install or clone:

```sh
alias halvard='node /path/to/halvard/bin/halvard.ts'
halvard factory plan --issue 42                 # read-only plan run; the plan goes on the issue
halvard factory approve issue-42                # or add the label factory:approved to the issue
halvard factory build issue-42                  # build, gate, review, commit, push, draft PR
halvard factory run --issue 43                  # a small task: build without a plan stage
halvard factory run --brief task.md --title "Fix the parser" --id fix-parser --no-push
halvard factory build issue-42 --retry          # start a parked job again from its brief and plan
halvard factory stop issue-42                   # stop a job; a running one stops within seconds
halvard factory rework issue-42 --note note.md  # build a parked job again, with your note for the agent
halvard factory replan issue-42                 # plan again a job that has no approved plan
halvard factory serve                           # work labeled issues until Ctrl-C; --once for one pass
halvard factory board                           # write the HTML board and print its path
halvard factory metrics
halvard factory status [issue-42]
```

`--no-push` stops after the commit, which leaves the branch in the job's worktree. The main checkout is never switched or edited.

## Serve

`factory serve` runs in your terminal, or as a systemd user service or launchd agent, and works from GitHub labels. It needs no webhook and opens no port. Each pass:

1. Starts nothing while a job is parked for tampering or a job file does not read. It logs why and keeps polling, so fixing the cause is enough.
2. Parks jobs that wait for approval and whose issue is labeled `factory:stop`. A running job checks for that label before each step.
3. Builds again, or plans again, a parked job whose issue got `factory:retry` after it parked, or a job whose runner died mid-run.
4. Builds jobs whose plan got `factory:approved` after it was posted, and approved jobs that no runner is working on.
5. Claims new open issues labeled `factory`, `priority:high` first, then by number. `factory:small` skips the plan stage, and `bug` gives the branch the fix prefix.

Every label counts only if someone with write access to the repository added it; the runner reads the issue's label events and that person's permission. A triager's label does nothing. Steps 3 to 5 stop once 90% of `monthlyUsd` is spent this month. `serve` regenerates the board after every step. An issue that already has a job under any id is not claimed again. Ctrl-C or SIGTERM parks the current job as `stopped-by-human` and exits; a second Ctrl-C quits at once, even in the middle of the gate. While `serve` works a job, `factory approve` and `build` refuse to start, so approve with the label. `serve` also builds a job you approved with `factory approve`, and it always pushes and opens the pull request; stop `serve` first if you want `factory build --no-push` for that job.

| Label | Who adds it | Effect |
| --- | --- | --- |
| `factory` | you | The issue enters the factory |
| `factory:small` | you | Build without a plan stage |
| `priority:high` | you | Claimed before other issues |
| `factory:approved` | you | Approves the plan posted on the issue |
| `factory:stop` | you | Parks the job at its next step |
| `factory:retry` | you | Starts a parked job again |
| `factory:parked` | the runner | The job is parked; the comment says why |

## Board and metrics

`factory board` writes `~/.halvard-factory/<repo>/board.html`: one static page, no script, that your browser reloads every 30 seconds. It shows every job by stage, its reviewer and round, cost, pull request and why it parked, under a row of numbers. `factory metrics` prints the same numbers as JSON:

| Number | Meaning |
| --- | --- |
| `firstGatePassRate` | Jobs whose first runner gate passed, in percent |
| `firstReviewBlockRate` | Jobs whose round 1 review blocked, in percent |
| `parkRate` | Jobs that are parked, in percent |
| `parked` | Parked jobs by reason |
| `meanCostPerFinishedUsd` | Mean agent cost of committed and pull-request jobs |
| `medianHoursToCommit` | Median time from job creation to the runner's commit |
| `monthSpendUsd` | Agent spend this calendar month |

## What keeps an unattended run safe

- **No approvals.** The runner sets `HALVARD_UNATTENDED=1` for the agent. Every guard ask becomes a denial that tells the agent the runner ships, and chat approvals are refused. So commit, push, publish and edits to workflow settings never run through the guard, whatever the harness does with an ask headless.
- **Read-only planning.** The plan run also gets `HALVARD_READONLY=1`, which makes the guard allow only reads in every harness.
- **Nothing outside the worktree.** In both runs the guard denies file edits outside the worktree and the task workspace. That covers the main checkout, the shared Git directory and the factory's job files. In a plan run it also denies shell redirects there.
- **No credentials in the agent's environment.** Agents, setup commands, the gate and the reviewer run without `GH_TOKEN`, `GITHUB_TOKEN`, an SSH agent or any other variable that looks like a token, secret, password or cloud credential. Model API keys stay, because the harness needs them. Git gets an empty credential helper and a push URL that cannot connect, and `gh` gets an empty configuration directory. A gate that needs a secret in its environment does not get one.
- **The runner checks before it trusts the tree.** After setup and after each agent run, the runner parks the job if any Git configuration it reads changed, in any scope, or your personal Halvard settings changed. It also parks the job if the branch changed `.halvard.json`, harness settings, extensions, or the gate's or review's scripts. The runner's own Git commands skip repository hooks and fsmonitor, and push to the URL it read before any agent ran.
- **The runner's own receipts.** The runner runs `halvard gate` with its own session key and records the review against that receipt. It marks the task done with `halvard task-done`, which applies the hook's completion checks. It also compares the approved plan with the digest the runner itself holds, not the one in the task file. The commit holds exactly the reviewed tree plus the status line, and the agent's process group is killed before the runner commits.
- **Approvals bound to the plan.** Posting a plan removes any old `factory:approved` label. The label then counts only while it is on the issue and only if someone with write access to the repository added it after the plan was posted. While a job's runner is alive, `factory approve`, `plan`, `build` and `run` refuse to start.
- **Same limits as solo.** A blocked review gets one re-review with the same reviewer. A second block parks the job for you.

- **Tests the builder did not write.** With `tests` set, another harness writes the acceptance tests first, inside their folder only. The runner records a digest of them and parks the job if they change.

### What a run on your machine does not protect against

Until the container phase, the agent runs as you, with a shell, on your machine. The guard and the runner's checks catch mistakes and an agent that follows a misleading instruction. They are not a boundary against an agent that sets out to do harm. Such an agent could read your `gh` login, `~/.git-credentials` or SSH keys from disk, rewrite your other branches through Git, or edit job files with a shell command. Run the factory only on repositories and issues whose authors you trust, and use each harness's own sandbox where it has one. Containers with only model credentials come in a later phase.

Before you use Grok as the author, run the headless probes from the factory research: whether a Grok hook decision holds headless, and with `--always-approve`, is not yet verified. Add `--always-approve` to `harnessArgs.grok` only after those probes pass.

## Files

| Path | Holds |
| --- | --- |
| `~/.halvard-factory/<repo>/jobs/<job>/job.json` | The job's state, written only by the runner |
| `…/events.jsonl` | One line per step: agent runs with cost and time, gate, review, commit, PR |
| `…/brief.md`, `…/plan.md` | The brief and the plan as proposed and approved |
| `…/agent.log`, `…/runner.log`, `…/setup.log` | Agent output, gate and review output, setup output |
| `…/evidence.md`, `…/evidence.json` | The pull request body and the receipts behind it |
| `…/stop`, `…/rework-<time>.md` | A stop request from `factory stop`, and your rework notes |
| `~/.halvard-factory/<repo>/worktrees/<repo>-<job>` | The job's worktree on its task branch |
| `~/.halvard-factory/<repo>/board.html` | The board |

`HALVARD_FACTORY_HOME` moves the whole folder. Team files and review summaries stay in the task workspace, `~/.halvard/<repo>-<job>/<job>/`.

## Parked jobs

`factory plan`, `build` and `run` exit with status 3 when the job parks, so a script can tell it from a shipped one. A job parks when the agent reports `STATUS: BLOCKED`, a run times out or spends the budget, the gate still fails with no fix pass left, the review blocks round 2, the reviewer stops answering, the branch conflicts with the base, the runner finds tampering, you stop the runner with Ctrl-C, or setup or `gh` fails. The runner records the reason in `job.json`, comments on the issue and adds the `factory:parked` label. The worktree stays for you to inspect. `factory build <job> --retry`, `factory rework <job> --note <file>` or the `factory:retry` label removes that worktree and the job's own branch and builds again from the same brief and approved plan. It also restarts a job left mid-build by a runner that died. A job that parked before its plan was approved, or whose plan run died, gets `factory replan <job>`. After a job parks for tampering, or while a job file does not read, no factory command starts work until you have checked your Git configuration, personal settings and the job file: then run `factory build <job> --retry --checked`, or delete the job's folder. `factory status` never fails on a parked job.
