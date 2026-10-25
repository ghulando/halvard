# Halvard

<p align="center">
  <img src="assets/halvard-mascot.png" alt="Halvard mascot: a bearded guardian in a rune-marked hood" width="240">
</p>

Halvard is a personal development assistant for Claude Code, Codex, Pi, Grok Build and the Cursor CLI. The name is Old Norse for "rock guardian": it guards your repositories and runs the work with you. The agent works on a feature or fix branch and keeps notes in a task file. A task counts as done only after it passes your project's checks and a review by a different agent.

## How it works

There are two parts. The engine is a set of hooks that run at session start, on each prompt and around every tool call. Its guard allows only reads on `main`. It asks you before any commit, merge, push or publish. It refuses to mark a task done until the gate (the check command in `.halvard.json`) and the review have both passed on the current tree. Everything else runs under the harness's own permissions. The skills are instructions that tell the agent how to plan, implement, test and review.

## Install

You need Node 22.18 or newer, Git and a POSIX shell.

```sh
curl -fsSL https://raw.githubusercontent.com/ghulando/halvard/main/scripts/install.sh | sh
```

The script installs the plugin into every harness on your `PATH`. Restart open sessions and approve hook trust. For Grok it prints the one install command you run yourself, because that command grants hook trust. [Install](docs/install.md) covers manual steps, updates, uninstalling and local clones. In a new repository, run `halvard-bootstrap` and then `halvard-setup`.

## Solo

Open one agent in the repository and describe the task, or call `/halvard`. The agent creates a branch and `docs/tasks/<id>.md`. For anything bigger than a small fix, it writes acceptance criteria and a plan, then stops so you can read them. Next it implements, runs the gate and sends the diff to a reviewer from another harness. A blocked review gets one fix pass and one re-review. Finally the agent shows the diff, offers a retro and asks before committing.

## Team with Herdr

For multi-file changes, open Herdr with a pane per harness and ask the lead's pane for `halvard-team`. The first time in a repository it asks you who leads, who develops, who reviews, whether an investigator takes part, and how far the lead may watch, nudge and answer the other panes. It saves the team in `.halvard.json` and asks whether to keep it on later runs. The lead writes the brief, the dev implements, and the reviewer reviews in its own pane. The lead records the verdict under the same gate and review rules. You answer design questions and handle a second blocked review. Commits still wait for your yes. The team needs `~/.halvard` writable by every team harness.

## Factory

`halvard factory` runs a task from a GitHub issue or a brief without you at the keyboard. A larger task first gets a read-only plan run, and you approve its plan. A headless agent then builds in its own worktree, with every approval request turned into a denial and no push credentials. The runner runs the gate and a review by another harness, commits, pushes and opens a draft pull request with the evidence. Merging stays with you. See [factory](docs/factory.md).

See [usage](docs/usage.md), the [flow diagram](docs/flow.md) and [configuration](docs/configuration.md).
