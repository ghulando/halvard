# Changelog

## Unreleased

- Halvard keeps all its data in one hidden folder, `~/.halvard`: `config/` for personal settings and installed copies, `workspace/` for task folders and `workspace/retro-logs/`, and `factory/` for factory jobs. `HALVARD_DATA` moves the folder; the earlier variables still move one part each.
- The guard denies agent file-tool writes and patches to Halvard's data outside the workspace, and a shell redirect there stops for approval. Only `~/.halvard/workspace` belongs in a harness sandbox grant.
- A run log records solo and team work for good in `~/.halvard/logs/<repo>/[<task>/]events.jsonl`: session starts, guard denials and asks, approvals, gate runs, reviews, and task start, handoff and done, each with harness, session key, branch, task and mode. `task-start --team` records a team task. `retro-events` reads the log, so retros cover Grok and Cursor and count asks answered in a native dialog.
- `halvard migrate [--apply]` moves `~/.config/halvard`, `~/.halvard-factory` and an earlier `~/.halvard` workspace into the new layout and repairs factory worktrees. It runs only from your own terminal. Until then the earlier folders stay in use, and `doctor`, the session start and the installer say so.

## 0.0.1

First release: one workflow engine with three modes (solo, team, factory) and native adapters for five harnesses (Pi, Claude Code, Codex, Grok Build, Cursor CLI). It adds portable task records, a configurable gate, and independent review by a different harness.
