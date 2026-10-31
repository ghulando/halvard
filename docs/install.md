# Install, update and uninstall

## Before you start

You need Node 22.18 or newer, Git, a POSIX shell, and the CLI of each harness you want to use. Check Node first, because an older Node cannot run the hooks and every tool call will be refused:

```sh
node --version   # must print v22.18.0 or newer
git --version
```

## Install

Install in whichever harnesses you use. Each one installs straight from GitHub.

The install script does this for every harness it finds on your `PATH`, and running it again updates them:

```sh
curl -fsSL https://raw.githubusercontent.com/ghulando/halvard/main/scripts/install.sh | sh
```

It also removes an install under the earlier `agent-workflow` name. It prints one colored section per harness with one line per step, and a summary at the end. A harness's own command output stays hidden unless a step fails; then the script shows that output and stops, leaving the harnesses after it unchanged. Add `--verbose` (`... | sh -s -- --verbose`, or `HALVARD_VERBOSE=1`) to see every command and its output. Then follow "After installing". The sections below are the same steps by hand.

### Claude Code

```sh
claude plugin marketplace add ghulando/halvard
claude plugin install halvard@ghulando
```

The first command registers this repository as a plugin marketplace named `ghulando`. The second installs the plugin from it.

### Codex

```sh
codex plugin marketplace add ghulando/halvard
codex plugin add halvard@ghulando
```

Codex reads the same marketplace file as Claude Code, so the marketplace has the same name.

### Pi

```sh
pi install git:github.com/ghulando/halvard
```

Pi needs no marketplace. It loads the package's extension and skills directly.

### Grok

```sh
grok plugin install ghulando/halvard --trust
```

Grok installs Halvard straight from GitHub. It lists the `ghulando` marketplace that Claude Code registers, but does not install Halvard from it. `--trust` grants the plugin's hooks trust, so the install script asks before it installs Halvard in Grok. When Grok refuses the GitHub install, the script installs from a clone in `~/.config/halvard/grok` instead and says why Grok refused. Without a terminal to ask on, it prints the command instead. Grok also loads Claude Code plugins and `~/.cursor/hooks.json`. Every Halvard entry it loads guards as Grok, and one approval covers all of them.

### Cursor

The Cursor CLI (`cursor-agent`) has no plugin command. Use the install script. It clones this repository to `~/.config/halvard/cursor`, adds Halvard's entries to `~/.cursor/hooks.json` and links the skills into `~/.cursor/skills`. Entries and skill folders of your own stay. The hooks file is backed up as `hooks.json.halvard.bak` first.

### After installing

1. Restart every open Claude Code, Codex, Pi, Grok and Cursor session. A running session keeps its old hooks.
2. Approve the hook trust prompt in Claude Code and Codex when it appears.
3. Make the task workspace writable. Team briefs and reviews go to `~/.halvard`, outside your projects. Add its absolute path to `~/.claude/settings.json`:

   ```json
   { "permissions": { "additionalDirectories": ["/Users/you/.halvard"] } }
   ```

   and to `~/.codex/config.toml`:

   ```toml
   [sandbox_workspace_write]
   writable_roots = ["/Users/you/.halvard"]
   ```

   Merge these into any settings you already have, and replace `/Users/you` with your home directory.
4. Optionally create `~/.config/halvard/personal.json` for personal reviewers and read commands, as described in [configuration](configuration.md).

Start a new session to check the install. A working install shows "Halvard is active" in the startup context.

## Update

Run the install script again, or by hand:

```sh
claude plugin marketplace update ghulando
claude plugin uninstall halvard@ghulando
claude plugin install halvard@ghulando

codex plugin marketplace upgrade ghulando
codex plugin remove halvard@ghulando
codex plugin add halvard@ghulando

pi update --extension git:github.com/ghulando/halvard

grok plugin update halvard
```

For Cursor, run the install script again. It pulls the clone and rewrites Halvard's hook entries.

The first command for each harness fetches the latest `main`. Claude Code and Codex cache plugins by version, so the uninstall and reinstall pick up new code even when the version number has not changed. Restart each harness afterwards, and approve hook trust again if it asks.

### Moving from agent-workflow

Halvard used to be called `agent-workflow`. An install under that name stays enabled next to Halvard, and the guard then runs twice. The install script removes it for you, under both the `ghulando` and the older `agent-workflow-local` marketplace names. By hand, remove the old install once, then install as described above:

```sh
claude plugin uninstall agent-workflow@ghulando
claude plugin uninstall agent-workflow@agent-workflow-local
claude plugin marketplace remove agent-workflow-local

codex plugin remove agent-workflow@ghulando
codex plugin remove agent-workflow@agent-workflow-local
codex plugin marketplace remove agent-workflow-local

pi remove git:github.com/ghulando/agent-workflow
```

A project that enabled the plugin in its own `.claude/settings.json` needs `claude plugin uninstall agent-workflow@<marketplace> --scope project`, run in that project. Codex keeps hook trust per plugin name, so it asks for trust again.

Halvard does not read the old names. Move your data by hand:

- Rename `.agent-workflow.json` to `.halvard.json` in each repository.
- Move `~/.config/agent-workflow/personal.json` to `~/.config/halvard/personal.json`.
- Move the task workspace `~/.agent-workflow` to `~/.halvard`, and update its path in `permissions.additionalDirectories` and `writable_roots`.
- Rename the `AGENT_WORKFLOW_HOME` and `AGENT_WORKFLOW_WORKSPACE` environment variables to `HALVARD_HOME` and `HALVARD_WORKSPACE`.
- Call `/halvard` instead of `/workflow`, and `halvard-<step>` instead of `flow-<step>`.
- Approve operations with `approve halvard <request-id>`.

Task files created before the rename carry an `agent-workflow` marker, so start their tasks again or change the marker to `halvard`.

## Uninstall

```sh
curl -fsSL https://raw.githubusercontent.com/ghulando/halvard/main/scripts/uninstall.sh | sh
```

The script runs on macOS and Linux. It removes the plugin from Claude Code, Codex, Pi and Grok, Halvard's entries and skill links from `~/.cursor`, and the earlier `agent-workflow` install under both of its marketplace names, together with its caches, the local-clone package and the workflow state in the temp directory. It also removes Codex's hook trust entries. Settings files are backed up as `<file>.halvard.bak` before they are edited. Your personal config and the task workspace stay; add `--purge` (`... | sh -s -- --purge`) to remove them as well, along with the workspace entries in `additionalDirectories` and `writable_roots`. The script lists project-scope Claude installs and leaves them alone. Grok also lists Claude Code's marketplaces, so the `ghulando` marketplace is often gone from Grok once Claude Code's is removed; the script treats that as done. `--verbose` works as for the install script. Restart every session afterwards.

## Install from a local clone

Use this to run your own changes. It copies the package to `~/.config/halvard/package` and installs every harness from there. Do not combine it with the GitHub install: both use the marketplace name `ghulando`, so remove the GitHub install first.

```sh
node bin/halvard.ts install-user
node bin/halvard.ts install-user --apply

claude plugin marketplace add ~/.config/halvard/package
claude plugin install halvard@ghulando

codex plugin marketplace add ~/.config/halvard
codex plugin add halvard@ghulando
```

`install-user` previews the changes and `--apply` writes them. It registers the package with Pi in `~/.pi/agent/settings.json`, creates `personal.json` and prints the workspace settings from step 3 above. Then follow "After installing".

To update a local install:

```sh
git pull

node bin/halvard.ts install-user --repair
node bin/halvard.ts install-user --repair --apply

claude plugin uninstall halvard@ghulando
claude plugin install halvard@ghulando

codex plugin remove halvard@ghulando
codex plugin add halvard@ghulando
```

`--repair` refreshes the package even when the version has not changed.
