# Usage

Halvard has two parts. The engine is code that runs on every tool call whether or not you mention it. The skills are instructions that tell the agent how to work. Solo and team runs use the same engine and the same skills; the team run adds the `halvard-team` skill on top.

## Solo

Use one agent for most work: docs, one-file fixes, small features.

1. Open Claude Code, Codex, Pi, Grok or Cursor in the repository and describe the task, or call `/halvard` with it.
2. The agent runs `task-start`, which needs a clean tree and creates `feature/<id>` and `docs/tasks/<id>.md`. Keep one task per branch. A second task on the same branch puts the first task's commits into the second task's review.
3. For anything beyond a small fix, the agent writes acceptance criteria and a plan into the task file and stops. Read them. This is the cheapest place to correct a wrong assumption.
4. The agent implements, runs the gate and updates the task notes.
5. The agent runs one recorded review. A pass completes the task. A blocked review gets one fix pass and one re-review. The re-review checks the earlier findings, and only a new issue serious enough to block a first review can block it; smaller new issues come back as follow-ups, which the agent lists for you and keeps in the task workspace. Anything still open comes to you.
6. The agent shows the diff and offers a retro. On your yes, `halvard-retro` reads the task's workflow events, grills you on each finding and appends the result to `~/.halvard/<harness>-retro-log.md`. A finding seen in two or more retros is marked actionable.
7. The agent asks before committing. Merge and push each need a separate yes.

Skills you call yourself: `halvard-bootstrap` to give a new repository its stack rules and skills from your [stack records](stacks.md), `halvard-setup` once per new repository, `halvard-debug` for a bug or slowdown, `halvard-handoff` to move a task to another tool, `halvard-retro` to review a finished task, `halvard-correct` to make a mistake agents keep repeating impossible, for example an actionable retro finding, `halvard-write` to rewrite text so an agent reads it one way, and `clean-history` to prune session history. `clean-history` deletes task workspaces and transcripts, so run a pending retro first; the retro logs themselves survive it. The `halvard` skill loads `halvard-spec`, `halvard-understand`, `halvard-design`, `halvard-implement`, `halvard-test`, `halvard-verify`, `halvard-review` and `halvard-write` when a step needs them; `halvard-debug` and `halvard-verify` load `halvard-benchmark` to check a measured performance number. The [flow diagram](flow.md) shows the steps.

## Team

Use the Herdr team for multi-file code changes where a second pair of eyes before the brief is worth the coordination. For docs or one-file fixes, solo is faster.

1. Open Herdr with one pane per team harness in the repository.
2. In the lead's pane, ask for the team and give the task, for example: "use halvard-team. Task: ...".
3. The first time in a repository, the lead asks you who leads, who develops, who reviews, whether an investigator takes part, and how far the lead may go with the other panes: watch and report, nudge, and answer permission prompts for reads, edits and the gate. It saves the answers in the `team` section of `.halvard.json`. Later runs show the saved team and ask whether to keep or change it.
4. The lead runs preflight and reports everything missing in one message. It then creates the branch and task, and for risky code sends the investigator to read before writing the brief. If the investigation shows a design choice, the lead asks you.
5. The lead briefs the dev with the acceptance criteria, known limits and the rule to stop when an existing test fails. It watches the panes and answers prompts inside the brief and the saved scope, one time each.
6. The dev runs the gate as its last action and reports its session key. The lead briefs the reviewer to review in its pane; the reviewer writes `<reviewer>-verdict-round1.json` in the task workspace, and the lead records it with `review ... --pane` and the dev's key.
7. After done, the lead offers a retro and runs it in its own pane over the Claude, Codex and Pi transcripts and the team files.
8. You answer only what reaches you: a design choice, an out-of-scope request, a second blocked review, the retro questions, and commit, merge or push. On `main` the guard accepts only plain `git merge --ff-only` and `git branch -d` for shipping, each after your yes.

Requirements: `HERDR_ENV=1` in the panes, the Herdr read commands in your personal `readCommands`, and the task workspace (`~/.halvard`) writable by every team harness. [Configuration](configuration.md) lists the exact entries.

## Engine

The engine is the hooks, the shell guard, the gate and the review runner. It enforces the rules below in every harness and does not depend on the agent remembering them.

Hooks run at session start, on each prompt, and before and after each tool call. The session-start hook injects the session key, the gate and review commands and the path to the `halvard` skill.

The guard keeps a small set of rules. On a protected branch (`main` and `master` by default) it allows only reads: built-in readers and entries in `readCommands`. Built-in readers run in any directory, while Git and `readCommands` entries count as reads only inside the project. A plain `>` or `>>` from a read to an absolute or `~/` path outside the project passes, like a file edit there. Plan mode is read-only in the same way. Commit, merge, push and publish commands ask in every harness, as do edits to Git metadata, harness settings (`.claude`, `.codex`, `.pi`), `.halvard.json` and the gate, review and extension scripts. Everything else on a feature or fix branch runs under the harness's own permissions. Claude Code and Grok show their own dialog for an ask; Codex and Pi print `approve halvard <request-id>`, which you send as a chat message, and Pi also shows a dialog. Cursor prints a `halvard approve` command that you run in your own terminal.

The gate is the command in `.halvard.json`. Run it exactly as the session context prints it. It prints a line per step and the tail of a failing step, and keeps the full output in a log file it names. A pass records a receipt for that exact tree. The receipt is lost when the tree changes.

The review runner sends the task and diff to a reviewer with no tools, from another harness unless [configuration](configuration.md) assigns the author's own harness with an explicit model for solo review. Every round after the first uses the reviewer of the round before it. A passing review records a completion receipt for the tree. Each task allows two rounds unless `reviewExceptions` raises the limit for that task.

The task is marked done by a separate edit that changes only its status line. The guard allows that edit only when both a gate receipt and a review receipt match the current tree. Commit, merge, push and publish always wait for your explicit yes.
