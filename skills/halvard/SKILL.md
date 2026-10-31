---
name: halvard
description: Run the shared application-development flow from requirements and branch creation through verification and independent review. Use for starting, resuming, or finishing implementation tasks.
---

Project instructions and user choices override workflow defaults. Keep replies short and code consistent with its surroundings. Technology decisions belong in the project.

Use [halvard-team](../halvard-team/SKILL.md) only when the user explicitly asks to run a multi-agent team through Herdr.

## Start or resume

Read AGENTS.md, CLAUDE.md if present, .halvard.json and the task. Inspect the branch and existing changes. In your first message on a new task, restate the user's goal and the smallest change you expect to meet it, without waiting for confirmation. If the user gave an issue reference, fetch it and state its title; ask when the reference is ambiguous. If the evidence rules out the requested change, show it and stop. Never stash, reset, restore, clean or switch a dirty tree to manufacture a baseline.

Substantial tasks use [halvard-spec](../halvard-spec/SKILL.md) for observable acceptance criteria and a short plan before coding. Small, clear fixes proceed directly. Use `node <plugin-root>/bin/halvard.ts task-start <id> '<title>' --author <pi|codex|claude|grok|cursor>`; add `--fix` for fixes and `--small` for small tasks. The command creates the configured branch from the configured base only on a clean tree. Preserve existing work and ask how tasks should be separated when it blocks a new branch.

For existing work, use `task-resume <task-file>` and [halvard-handoff](../halvard-handoff/SKILL.md). Recorded progress is context to verify, not proof.

A task with an Approved plan section was approved before this session: implement that plan without stopping for another approval, and never edit the section, because a changed section voids the approval and blocks completion. When the prompt says this is an unattended factory run, nobody can answer: do not ask questions or request approvals, record decisions in the task, stop after the gate passes, and leave review, completion and commits to the factory runner. End the final message with `STATUS: READY`, or `STATUS: BLOCKED: <reason>` when a requirement contradicts itself, needs a product decision or the environment fails.

## Implement

Load [halvard-understand](../halvard-understand/SKILL.md) for unfamiliar code, [halvard-design](../halvard-design/SKILL.md) for consequential interface choices, and [halvard-implement](../halvard-implement/SKILL.md) for implementation slices. Use [halvard-debug](../halvard-debug/SKILL.md) for defects and [halvard-test](../halvard-test/SKILL.md) when writing tests. Use [halvard-write](../halvard-write/SKILL.md) for text another agent or a program reads. Read required and relevant project stack skills before editing. Name only skills actually loaded; do not read the whole catalog.

Update task decisions, progress and next step at meaningful checkpoints. Keep credentials and machine-specific settings out of task files.

## Finish every task

Use [halvard-verify](../halvard-verify/SKILL.md), run the session-context full gate, and walk project invariants. Then use [halvard-review](../halvard-review/SKILL.md) for independent review. This applies to small fixes too.

A passing recorded review, including round 1, supplies the review receipt for completion. After a blocked review, fix once, record fixes in the task, rerun affected checks and run one re-review. Remaining blocking findings keep the task unfinished; do not manufacture extra review cycles. The full gate and passing review must both cover the final tree. Update task notes before final checks so documentation edits do not stale them. Mark done with a file-edit tool after both receipts exist. Checks passing does not prove acceptance criteria.

Show what changed, why, and verification evidence. Before asking to commit, offer a [halvard-retro](../halvard-retro/SKILL.md) and run it only on the user's yes. Commit, merge, push, publish, deploy and external ticket/chat updates require explicit authorization. An implementation plan is not shipping approval. Never approve your own workflow request.

On the user's yes to commit, stage code and tests by name: never `git add -A`, `git add .` or `git commit -a`. Ask separately whether to include the task files under the configured `taskDirectory`, and whether to include the `.halvard.json` changes, naming any change to `reviewExceptions` or `reviewDeferrals`. Stage each only on its own yes. Show `git status --short` before committing so the user sees what goes in and what stays out.

New repos use [halvard-bootstrap](../halvard-bootstrap/SKILL.md) for stack rules and skills, then [halvard-setup](../halvard-setup/SKILL.md). Use halvard-bootstrap too when an existing repository lacks stack skills. Plan/review sessions are read-only; exit native plan mode (Pi: /plan) before implementation or running checks.

Adapted from Pstack poteto-mode and Matt Pocock implement. See ../../UPSTREAM.md for pinned sources and licenses.
