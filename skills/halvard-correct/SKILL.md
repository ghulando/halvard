---
name: halvard-correct
description: Find the mistakes agents keep repeating in a repository and make each one impossible to repeat, preferring structure, then types, then a lint that names the fix, then a test, with docs last. Use only when the user asks for it, including for an actionable halvard-retro finding; ordinary corrections do not trigger this skill.
---

The user keeps correcting agents in this repository for the same mistakes. Change the repository so the next agent cannot make them. Run this as a normal Halvard task on its own branch: [halvard](../halvard/SKILL.md) owns branch, gate, review and commit approval.

Assume every contributor is an agent that sees only the files it opened, copies the nearest example and takes the shortest path that compiles. A change that looks right from one file must be right for the whole repository.

## Find the mistake classes

Read recent commits, reverts, review findings, agent instruction files, comments that explain workarounds and the retro logs in the task workspace (`<harness>-retro-log.md`). Group the mistakes into classes. A class counts once it has happened twice. Cite the evidence for each class: commit, review round, retro finding id or file and line. Do not copy transcript text, credentials or customer data.

Show the classes and the level you propose for each, then stop for the user's choice of which to fix. This is the plan step of the task.

## Fix each class at the highest level that works

1. **Architecture.** Give each piece of state one owner and each task one supported way. Hide internals so the wrong import fails. Replace hand-synced lists with one source of truth. Delete old ways and dead code an agent would copy.
2. **Types.** Make the bad state impossible to write. If bad code still compiles, add a lint or check whose error names the file, type or function to use instead. If the pattern is already common, fail only when a change adds more.
3. **Tests.** Fix or delete tests that pass when the behavior they check breaks, or fail when only the internals change; see [halvard-test](../halvard-test/SKILL.md).
4. **Docs or agent rules, last,** and only for judgment calls. Nothing fails when an agent skips them.

A new check runs through the configured gate, so the same command runs locally and in CI. Changing the gate, CI or `.halvard.json` needs the user's yes; the guard asks.

## Prove each check

Fix one class per slice. Prove each new check fails on a real past mistake: apply the old mistake as a scratch change, watch the check fail with its message, then drop the scratch change and confirm the check passes again. A check you never saw fail proves nothing. An exception goes on the offending line with a reason and an expiry date, and only with the user's approval.

## Keep the rule table

Keep a table in the project's agent instruction file that pairs each rule with what enforces it. When a correction repeats a rule that is already in the table and nothing enforces it, fix it at a higher level in the same task. Drop a rule once its mistake cannot happen.

Report each class with its evidence, the level you picked and why a higher level did not work.

Adapted from Pstack correct; see ../../UPSTREAM.md.
