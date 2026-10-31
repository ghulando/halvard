---
name: halvard-retro
description: Grill the user about a finished task, logs first, and log workflow improvements that recur across retrospectives. Use after a task is marked done, when the user accepts the offered retro or asks for one.
---

Run the retro in the session that finished the task; in a team run, the lead runs it alone and briefs no worker. It is read-only apart from one append to this harness's retro log. It never edits skills, engine code or configuration, and it does not create tasks.

## Evidence first

Run `node <plugin-root>/bin/halvard.ts retro-events <task-id>` from the repository root. It prints the task workspace files, recorded review verdicts, the paths of earlier retro logs and, per harness, the sessions found, guard denials and asks grouped by reason, `approve halvard` prompts, and gate passes and failures. It reads Claude, Codex and Pi transcripts whose cwd is the repository, between ten minutes before the earliest workspace file and an hour after the latest. Claude asks answered in the native dialog leave no record and are not counted. Say so instead of claiming none happened.

Read every file in `retroLogs`, then the task file and the workspace briefs, reports, findings and verdicts. A solo run also uses its own session: corrections the user made and steps that were repeated.

Turn the evidence into findings. A finding is a cause, not a count: "Pi was denied five times on `$` variables after a brief that showed a shell loop" rather than "five denials". Repeated denials with one reason, a gate that failed before passing, a blocked review round, a round beyond two, an approval the user had to send, and a brief whose acceptance criteria the report or review contradicted are all candidates. Give each finding a short kebab-case id that names its cause, and reuse the id of a matching finding from an earlier log.

## Grill

Ask about one finding at a time, most frequent or most costly first, with the harness's question tool where it has one and in plain chat otherwise. State the evidence, say how many earlier retros logged the same id ("this is the third time"), and recommend one classification: guard bug, skill gap, project config gap, personal config gap or expected. Move on only when the user has classified the finding and named its target: Halvard skills, Halvard engine, project config or personal config. Push back when an answer contradicts the evidence. Treat an unclear match with an earlier finding as a question for the user, not as a repeat.

When the findings run out, ask one open question: what slowed or annoyed the user that the logs do not show. Grill the answer like a finding.

## Log

Append one entry to `<harness>-retro-log.md` in the workspace root, the directory that holds the retro logs and repository folders. Write only this harness's file. The entry has a heading with the date, repository name and task id, a line of event counts per harness, a line of review verdicts, and one line per finding: id, classification, target, one-sentence cause, times seen including this retro, and `actionable` when seen in two or more retros, otherwise `note`. Record the user's closing answer the same way.

Never copy transcript text, commands, file contents, credentials or customer data into the log. Guard reasons from `retro-events` and short summaries of the user's answers are the only quoted material.

Finish by showing the entry and listing the actionable findings as candidate Halvard tasks. For an actionable finding about a mistake agents repeat in this project, name [halvard-correct](../halvard-correct/SKILL.md) as the way to make it impossible. Starting one is the user's call.
