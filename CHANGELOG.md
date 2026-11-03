# Changelog

## Unreleased

- Codex: a denied operation names a request that the agent can turn into an approval form through Halvard's `halvard_request_approval` MCP tool. Only the user's Approve once answer, sent by Codex, approves it, once. The text approval remains.
- Approval requests get a new id when they are issued again after expiring, show their issue and expiry times, and say whether an answer was late, replaced, for another request or for a changed tree. An approval allows a retry for ten minutes from the approval rather than from the request.
- The run log records approval outcomes with their request: approved, rejected, declined, cancelled, expired and host-allowed. A dialog that never answered records nothing. Metrics count each asked operation once and report unknown outcomes; older logs keep the session-based count.
- Shipping detection treats quoted text, heredoc bodies written to readers, and the operands of read commands as data, checks inline scripts for commands that ship, and labels requests it cannot classify as uncertain.
- `git branch` queries such as `--merged main` and `--no-merged main` read on protected branches and in review; other `git branch` forms stay changes.

## 0.0.1

First release: one workflow engine with three modes (solo, team, factory) and native adapters for five harnesses (Pi, Claude Code, Codex, Grok Build, Cursor CLI). It adds portable task records, a configurable gate, and independent review by a different harness.
