# Codex approval dialog check

Run this check by hand after installing or updating Halvard in Codex. It confirms that your Codex version shows Halvard's approval form, that Approve once allows exactly one operation, and that anything else leaves the operation blocked. Automated tests drive the MCP server with a scripted client; only a live Codex session shows what you will see.

Use a throwaway repository. Do not run this in a project with real remotes.

## Setup

```bash
mkdir -p /tmp/halvard-codex-check && cd /tmp/halvard-codex-check && git init -q -b feature/check && echo one > a.txt && git add a.txt
```

```bash
codex --version
```

Start Codex in that folder with the default approval policy (`on-request`), not `codex exec`. Run `/mcp` and confirm that `halvard` is listed with the tool `halvard_request_approval`. If it is missing, restart Codex after the plugin update.

## Steps

1. Ask Codex: "Commit a.txt with the message check." Halvard denies `git commit` and names a request id.
2. The agent calls `halvard_request_approval`. Codex may first ask you to allow the tool call; allow it. That only lets the tool run.
3. Codex shows a form headed `Halvard approval request` with the repository path, branch `feature/check`, the exact command, the request's expiry, and the choices Approve once and Reject. Expected: the form appears, and nothing has been committed yet (`git log` in another terminal shows no commits).
4. Choose Approve once. The agent retries the commit, and it succeeds.
5. Ask Codex to commit again with `--allow-empty -m again`. The new command asks again: the approval was used once.
6. In the new form, choose Reject. Expected: the agent reports the rejection, and `git log` shows no new commit.
7. Ask once more and press Esc to dismiss the form. Expected: the operation stays blocked, and the reply names `approve halvard <id>` as the fallback.
8. Send `approve halvard <id>` as a chat message with the id from step 7. The agent's retry then succeeds once.
9. Optional: run `codex exec "commit a.txt again with --allow-empty"`. Codex cancels elicitations in exec mode, so the tool returns the text fallback and nothing is approved.

## What to record

Note your `codex --version`, which steps matched, and anything that differed, such as the form not appearing, choices shown differently, or a step 7 dismissal that approved. Check the run log for the outcomes:

```bash
tail -n 20 ~/.halvard/logs/halvard-codex-check*/events.jsonl
```

Expected: `ask` events with a `request` field, then `outcome` events: `approved` with `via` `codex-elicitation`, then `rejected`, then `cancelled` (or `declined`, if your Codex sends a decline when you press Esc), then `approved` with `via` `prompt`. No command text appears in the log. A dialog that never answered logs no outcome.

If Codex never shows the form, the session id Codex sends to MCP tools may differ from the one it sends to hooks, or be missing. The tool then says the request belongs to another session, or that Codex did not say which session called it, and falls back to the text approval. Report which message you saw.
