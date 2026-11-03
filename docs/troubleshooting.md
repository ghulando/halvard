# Troubleshooting

Start with `doctor --author <author>` from the project root, using the runner path printed at session start. Doctor checks configuration and package content. It cannot tell whether a provider is logged in or whether hooks are running.

## No Halvard context or guards

Register the plugin with the commands in [install](install.md), restart the harness and approve hook trust. A working install shows "Halvard is active" in the startup context.

Codex loads the hooks named in `.codex-plugin/plugin.json`. Do not add a root `plugin.json`: it shadows those hooks. References: [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins), [Claude plugin reference](https://code.claude.com/docs/en/plugins-reference), [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md).

"halvard hook is missing" means the plugin was updated or removed while the session was open. Restart the harness.

"halvard hook could not run" on every tool call, with `ERR_UNKNOWN_FILE_EXTENSION` from `node`, means the harness found a Node older than 22.18, which cannot run TypeScript. Check `node --version` in the environment the harness starts from.

"Worktree too large to verify within the hook time budget" means fingerprinting tracked and non-ignored files took over 40 seconds. Ignore large or generated files, or move them out of the repository. The hook denies here because past the 60-second harness timeout, Claude Code and Codex would run the tool without a decision.

Grok and Cursor hooks fail open when a hook crashes or times out. Halvard's Grok entries exit with code 2 on an error, which Grok treats as a denial, and its Cursor entries set `failClosed`. Cursor's CLI sends shell commands to `beforeShellExecution`; Halvard reads them there and skips them in `preToolUse`. If your Cursor CLI version does not send `preToolUse`, file edits are not guarded before they run. Check with a write on `main`, which must be denied.

Cursor's edit tool can send a sketch with "existing code" markers instead of exact text. The guard cannot preview that edit. It still checks the path, and it denies such an edit to a task file, because the task file carries the done marker. Ask the agent to use an exact replacement or a whole-file write there.

Register the package either per user or per project in each harness, not both. Installation does not remove old guards; remove superseded ones yourself.

## A command is denied on main or in plan mode

Protected branches and plan mode allow only reads. Start a feature or fix branch, or exit plan mode. For a read that is still denied, use literal paths, known read options and globs with a directory prefix. `node -e`, Python snippets and unknown wrappers count as code execution even when the snippet only reads. For your own read-only tools, add a narrow `readCommands` rule ([configuration](configuration.md#read-commands)).

## Approval does not take

Only commit, merge, push, publish and edits to protected workflow files ask. Pi shows a dialog, Claude Code and Grok use their native approval, and Codex shows Halvard's approval form when the agent calls `halvard_request_approval`, or accepts `approve halvard <request-id>` as a chat message. The Cursor CLI does not enforce an ask and sends no prompt hook, so Halvard denies the call and prints a command such as `node <runner> approve <session-key> <request-id>`. Run it in the repository from your own terminal, then ask the agent to retry. The guard denies that command when an agent runs it. Approve a request within ten minutes of its issue, and retry within ten minutes of the approval. The retry must be the same operation in the same session on the same tree; anything else needs a new request. The approval reply says which case applies: no request waiting, a different request waiting, an expired request, a request replaced after it expired, or a changed tree. After an expiry, retry the operation and approve the new id it shows.

If Codex does not show the approval form, check that the Halvard plugin's MCP server is enabled (`/mcp` lists `halvard`), that `approval_policy` is `on-request` or `untrusted`, and that no automatic approval reviewer is configured. The tool then says why and falls back to the text approval.

## The gate passed but completion is blocked

Run the exact gate command from the session context, with no file changes running alongside it. The runner reports whether the checks failed or the tree changed during the run. Finish task notes before the final gate, because editing the task file afterwards invalidates the receipt. With review required, a passing recorded round 1 on the final tree is enough for the status-only edit that marks the task done. After a blocked review, fix once, rerun the gate and run one re-review. Remaining issues go to the user; tree changes invalidate the receipts.

Gate and review commands must come from the same package build as the running hook. Matching version numbers are not enough.

The fingerprint covers tracked and non-ignored files, file modes, symlink targets, the index, HEAD, the branch, personal settings and initialized nested Git checkouts. Ignored files and anything reached only through a symlink are not covered, so keep check inputs out of them. Initializing a submodule or repairing a broken nested repository changes the fingerprint and invalidates earlier receipts.

## Review has no usable provider

Run `doctor --author <author>`, configure an eligible reviewer in project or personal settings, and install and log in to that provider yourself. Task start refuses a configuration that requires review but has no eligible reviewer.

## A review stopped but still says it is running

Check `review-status`, and stop the coordinator and reviewer in the harness that started them. Then run:

```sh
node <installed-runner> review-recover docs/tasks/task.md
```

Recovery checks that the recorded processes are gone, keeps reports and verdicts, and clears the interrupted run. It kills nothing and grants no pass. Rerun the gate and retry the round.

If the launch record has a coordinator PID but no reviewer PID, for example after a spawn failure, first confirm by hand that the reviewer and its process group are gone, then run `review-recover <task-file> --stopped-reviewer`. Records with only a UUID, or with no process identity, cannot be recovered automatically. Do not delete private review state or hand off the task to escape failed rounds.

## Package content differs

Preview `install-user --repair`, then run `install-user --repair --apply`. For a vendored copy use `install-plan --repair` and `install --repair`. Save any intentional local edits first. Restart afterwards and approve hook trust again, since a running session keeps its original plugin copy.
