# Changelog

## Unreleased

Renamed from agent-workflow to Halvard. The package, command, plugin, skills (`/halvard`, `halvard-<step>`), configuration file (`.halvard.json`), personal directory (`~/.config/halvard`), task workspace (`~/.halvard`), environment variables (`HALVARD_*`) and approval phrase (`approve halvard <id>`) use the new name. The old names are not read; [install](docs/install.md) lists the steps to move. The install and uninstall scripts also remove an earlier agent-workflow install.

Added Grok Build and the Cursor CLI as harnesses. Both run the guard and the skills, author tasks and review headless (`grok`, `cursor-agent -p --mode ask`). The install and uninstall scripts handle both; the Grok plugin install is left to you because it grants hook trust. Cursor approvals use `halvard approve <session-key> <request-id>` from your own terminal.

The Herdr team is configurable per repository. `halvard-team` asks for the lead, dev, reviewer and optional investigator from all five harnesses, and for what the lead may do with the other panes, and saves the answers in a new `team` section of `.halvard.json` with `team set`.

Added factory mode, phase 1. `halvard factory plan|approve|build|run|status` takes a GitHub issue or a brief through a read-only plan run, your approval, a headless build in its own worktree, the runner's own gate and cross-harness review, and a draft pull request with the evidence. The runner sets `HALVARD_UNATTENDED=1`, which turns every guard ask into a denial, and `HALVARD_READONLY=1` for plan runs. Agents get no push credentials. `task-start` takes `--brief`, `--base`, and `--plan` with `--approved-by`. An approved plan is frozen by its digest: changing it blocks completion. The new `task-done` verb marks a task done with the hook's completion checks. Task files gain Out of scope and Assumptions sections. See [factory](docs/factory.md).

## 0.0.1

First release: shared workflow engine, native adapters for Pi, Claude Code and Codex, portable task records, configurable gate and independent review.
