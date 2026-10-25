# Configuration

## Project and personal settings

Project settings live in `.halvard.json` at the Git repository root. A file in a subdirectory is ignored, and the guard protects it from edits; the root file applies. Personal settings live in `~/.config/halvard/personal.json`, and `HALVARD_HOME` points to another directory. Project settings win over personal ones, except that reviewers merge by provider and read-command lists add up.

Start from [examples/project.json](../examples/project.json), or run `setup` to get a proposal for your project. The example gate is for a Node project, so replace it for other stacks. Neither install nor setup runs the checks it detects or installs a toolchain.

With no configuration, the hooks protect `main` and `master` and find skills in `.agents/skills`. There is no default gate or reviewer, so no task can be marked done until you set them.

| Setting | Purpose |
| --- | --- |
| `version` | Schema version. Use `1`. |
| `protectedBranches` | Branches where the agent may only read. |
| `taskFiles` | Patterns that match task Markdown files. |
| `doneMarker` | Completion text. Default `**Status:** done.`; bare text is placed after `**Status:**`. |
| `gate` | Executable and argument array that runs every project check, or a list of such arrays run in order as steps. |
| `review` | Optional review wrapper, see [Review wrapper](#review-wrapper). |
| `skillRoots` | Directories holding `<name>/SKILL.md`. |
| `requiredSkills` | Skills whose full text is loaded at session start. |
| `readCommands` | Commands trusted as reads on protected branches and in plan mode. |
| `readOnlyTools` | Host tool names or `*` patterns that never change project files. MCP tools (`mcp__*`) stay under the host's own permissions. |
| `extensions` | Repository JavaScript modules exporting `pre`, `post` or both. |
| `stack` | Written by `bootstrap-apply`: the stack record name, the stacks commit, whether the record differed from it, and the stack gate that `setup` proposes while no gate is set. See [Stack records](stacks.md). |
| `team` | The Herdr team, see [Team](#team). |
| `factory` | Factory mode: author, reviewer order, setup, budgets and limits. See [Factory](factory.md). |
| `workflow` | Task, branch and review preferences. |

An unknown key, an invalid value or unreadable state makes the guard deny rather than guess. In patterns, `*` matches within one path segment and `**` across segments. File-tool edits to Git metadata, workflow and harness configuration, and the configured gate, review and extension files ask you first.

## Workflow settings

| Setting | Default |
| --- | --- |
| `taskDirectory` | `docs/tasks` |
| `baseBranch` | `main` |
| `featurePrefix`, `fixPrefix` | `feature/`, `fix/` |
| `requireReview` | `true` |
| `reviewers` | `{}`, so you must choose providers |
| `reviewTimeout` | `900` seconds, from 1 to 3600 |
| `reviewContext`, `reviewExclude` | Empty pattern lists |
| `reviewExceptions` | Empty, see [Review exceptions](#review-exceptions) |
| `reviewDeferrals` | Empty, see [Review deferrals](#review-deferrals) |
| `stacks` | `null`. An absolute or `~/` path to a local clone of your [stack records](stacks.md) |

List only reviewers you can run, because each one starts a CLI on your machine. An empty object for Claude, Codex, Grok or Cursor uses that harness's default model. Ollama needs a model name.

```json
{
  "workflow": {
    "reviewers": {
      "claude": {},
      "codex": {},
      "grok": {},
      "cursor": {},
      "ollama": {"model": "your-installed-model"}
    }
  }
}
```

The reviewer must come from a different harness than the author:

| Task author | Eligible reviewers |
| --- | --- |
| Pi | Claude, Codex, Grok or Cursor |
| Codex | Claude, Grok, Cursor or Ollama |
| Claude | Codex, Grok, Cursor or Ollama |
| Grok | Claude, Codex, Cursor or Ollama |
| Cursor | Claude, Codex, Grok or Ollama |

A Grok review runs `grok --prompt-file` with the edit, shell and web tools turned off. A Cursor review runs `cursor-agent -p --mode ask`, Cursor's read-only mode.

Run `doctor --author codex` to check this before you start. Two harnesses can run the same model family, so a different harness does not guarantee a different model. `requireReview: false` drops the review requirement, but the gate still has to pass.

Without further settings the author picks one of its eligible reviewers. To decide it yourself, key an entry by the author and name its reviewer:

```json
{
  "workflow": {
    "reviewers": {
      "claude": {"reviewer": "claude", "model": "opus"},
      "codex": {"reviewer": "ollama", "model": "your-installed-model", "transport": "pi"},
      "pi": {"reviewer": "codex"}
    }
  }
}
```

Claude's work is then reviewed by a headless Claude on Opus, Codex's by Ollama through Pi, and Pi's by Codex on its default model. The runner refuses any other reviewer for that author, and session context prints the review command with the reviewer filled in. An author without such an entry chooses among the entries that have no `reviewer`, as above. A repo entry replaces a personal entry with the same key.

An author may review its own work only with an explicit `model`, and only in a solo run, because the headless reviewer has no tools and its verdict comes from its output. The workflow cannot see which model the author's session runs, so a same-harness review is only as independent as the two models you choose. Team runs ignore these entries: the lead picks the pane reviewer, which is never the author.

Every round after the first must use the reviewer of the round before it.

With `transport: "pi"`, Ollama runs through Pi with tools, extensions, skills and context discovery turned off. `reviewContext` adds unchanged files the reviewer needs to understand the change. `reviewExclude` keeps generated files out of what the reviewer sees but leaves them in the tree fingerprint, so the reviewer never approves a file it did not read.

### Review wrapper

`review` is a one-element array naming an executable inside the repository, such as `["scripts/review.sh"]`. The guard recognises it only when run from the project root exactly as `REVIEW_GATE_SESSION=<session key> scripts/review.sh <task-file> <author> <reviewer> [round]`, where the reviewer is `claude`, `codex` or `ollama` and the round is 1 to 10. The wrapper has to call the runner's `review` command itself. The runner sits in a different place for each harness install, so session context prints the wrapper call with `HALVARD_RUNNER=<runner>` after the session key, and the wrapper runs `node "$HALVARD_RUNNER" review ...`. The guard accepts that variable only when it names the session's own runner. Because the guard recognises the call, the wrapper can run on protected branches, and edits to it ask first. `doctor` reports a wrapper that is missing or not executable.

Most projects need no wrapper. Without one, session context prints the runner's `review` command ready to run. CI and Git hooks should run the project's checks directly, because gate and review receipts live in the local session state.

### Review exceptions

A task gets two recorded review rounds. To allow more for one task, add an entry keyed by its repository-relative task file:

```json
{"workflow": {"reviewExceptions": {"docs/tasks/login.md": {"maxRound": 4, "reason": "Reviewer timed out twice; approved by the maintainer"}}}}
```

`maxRound` is 3 to 10 and `reason` cannot be empty. The reason is stored with every extra round.

### Review deferrals

When you decide that a review finding belongs to later work, record the decision so the next round does not hold the task open for it. Each recorded round numbers its findings in `<reviewer>-review-round<N>.md`, and a deferral names one as `round<N>#<position>`:

```json
{"workflow": {"reviewDeferrals": {"docs/tasks/login.md": [{"finding": "round1#2", "approvedBy": "Andranik", "reason": "Moved to the session-expiry task"}]}}}
```

The next round's reviewer is told the finding is deferred and, if it still applies, reports it with `"deferral": "round1#2"` and the same severity, location and problem. The runner refuses a citation that does not repeat the deferred finding exactly. A deferred finding does not block a pass, and the receipt and round summary list every deferral with its approver. A blocking finding is deferred only when the entry also has `"override": true`; without it, the runner warns and the finding stays open. Deferrals belong in project configuration because the guard asks you before an agent edits it. Personal settings reject them.

## Gate steps

A gate given as a list of commands runs them in order and stops at the first failure:

```json
{"gate": [["npm", "run", "format:check"], ["npm", "test"]]}
```

The full output of each run goes to its own `gate-<session key prefix>-<run>.log` in the task workspace of the current branch's task, or in `~/.halvard/<repo>/` when the branch has no task. The runner prints one pass, fail or skip line per step, the last 40 lines of a failing step and the log path. A single command array works as one step.

## Read commands

On a protected branch, and in plan or review mode, the guard runs only reads and denies everything else, because a script can write files even when its name sounds harmless. On a feature branch it does not classify commands.

To trust a fixed prefix followed by positional arguments:

```json
{"readCommands": [["inspect", "list"]]}
```

Any flag after that prefix is rejected. For a command with options, describe exactly what it accepts:

```json
{
  "readCommands": [{
    "prefix": ["inspect", "read"],
    "options": {"--lines": "positiveInteger", "--source": "string", "--quiet": "flag"},
    "positionals": {"min": 1, "max": 1}
  }]
}
```

A test run or query can still write files such as caches, and the guard cannot see what its code does. A project that accepts that can trust it as a read, so it runs on a protected branch:

```json
{
  "readCommands": [{
    "prefix": ["uv", "run", "pytest"],
    "options": {"-q": "flag"},
    "positionals": {"min": 0, "max": 0}
  }]
}
```

Option values must be separate arguments. The guard rejects unknown options, abbreviations, combined short flags and `--name=value`. It also rejects `--` unless the prefix includes it, because programs may forward whatever follows. Trust only executables whose options you understand. Personal entries apply in every repository.

To query an existing graphify graph, add these entries to the personal `readCommands` in `~/.config/halvard/personal.json`:

```json
{
  "readCommands": [
    {
      "prefix": ["graphify", "query"],
      "options": {"--budget": "positiveInteger", "--dfs": "flag"},
      "positionals": {"min": 1, "max": 1}
    },
    {
      "prefix": ["graphify", "explain"],
      "options": {},
      "positionals": {"min": 1, "max": 1}
    },
    {
      "prefix": ["graphify", "path"],
      "options": {},
      "positionals": {"min": 2, "max": 2}
    },
    {
      "prefix": ["graphify", "affected"],
      "options": {"--depth": "positiveInteger"},
      "positionals": {"min": 1, "max": 1}
    }
  ]
}
```

They allow reads only. Halvard never builds, updates or installs graphify. Add `graphify-out/` to the project's `.gitignore`.

The built-in classifier also accepts pipes between readers and discard redirects such as `2>/dev/null`. Variables, `$(...)`, backticks, loops and output redirections other than a plain `>` or `>>` to a literal path make a command unclassifiable, so the guard denies it wherever only reads may run. A read whose plain `>` or `>>` target is an absolute or `~/` path outside the project and the team workspace passes; a relative target, a target with a `..` component or any other path is a change. A glob needs a literal directory prefix. `git -C` counts as a read only when it names the project root by absolute path. Built-in readers count as reads after a `cd` anywhere. Git and `readCommands` entries count as reads only inside the project and outside nested repositories, because the directory they run in can supply executable configuration. A `cd` moves later commands only inside an unbroken `&&` chain from the start of the command, and a relative `cd` may not climb above the starting directory. After the first `;`, `||`, `&` or newline that follows a `cd`, the guard treats the directory as unknown. `--help` and `--version` count as reads only for the built-in readers and for `git`, `rg`, `grep`, `find`, `sed`, `jq`, `node`, `npm` and `herdr`.

Older files may still contain `protectedPaths` or `workflow.shellApproval`. The guard accepts and ignores both. On a feature branch, shell commands never ask except commit, merge, push and anything containing `publish`, `push`, `deploy`, `release` or `upload`. The guard reads the command text. It catches ordinary spellings, including `/usr/bin/git`, Git global options, chains, line continuations and `sh -c` scripts. It misses a command built in a variable or run from a script file, and shell commands can still write protected files. The hooks are guardrails for the workflow and give no OS-level protection; use the harness sandbox when you need that.

## Team

`halvard-team` asks for the team the first time and saves it here with `team set`. You can also write it yourself:

```json
{
  "team": {
    "lead": "claude",
    "dev": "codex",
    "reviewer": "pi",
    "investigator": "pi",
    "monitor": {"watch": true, "nudge": true, "approve": "reads-edits-gate"}
  }
}
```

`lead`, `dev` and `reviewer` are required, and each is `pi`, `claude`, `codex`, `grok` or `cursor`. The lead and the dev must differ, and the reviewer must not be the dev. `investigator` is optional; leave it out or set `null` for none. `monitor` defaults to the values above:

| Setting | Effect |
| --- | --- |
| `watch` | The lead reads the other panes and reports progress, stalls and errors to you. |
| `nudge` | The lead may send one short prompt to an idle worker that stopped without a report. |
| `approve` | `reads-edits-gate`: the lead answers a worker's prompt for a read, an edit inside the repository or task workspace, or the gate. Everything else comes to you. `none`: every prompt comes to you. |

Commit, merge, push and publish always come to you. `team show` prints the saved team. `team set --dev cursor` changes only the roles you name; it asks before it writes, like any edit to `.halvard.json`.

## Task workspace

Each task gets a private folder outside the repository for team files: `~/.halvard/<repository folder name>/<task id>/`, or the same path under `HALVARD_WORKSPACE` when it is set. `task-start`, `task-resume` and `task-handoff` create it with mode 0700 and print its path. They refuse an existing folder that is a symlink or that other users can read. A `.repo` file records which repository owns the folder, so a second repository with the same folder name gets an error.

Briefs, reports and findings go there, never in a harness's own scratch directory. Name each file `<writer>-<topic>.md`, where the writer is `claude`, `codex`, `pi`, `grok` or `cursor`, for example `claude-brief-codex.md` or `pi-findings-1.md`. The guard denies a file-tool write or Codex patch to a file carrying another writer's prefix, and rejects a patch that touches both the workspace and the repository. Every agent can read every file. Shell writes to the workspace are not checked. Recorded reviews add `<reviewer>-review-round<N>.md`. The task note itself stays in the repository.

Claude Code and Codex may still ask before writing outside the project. `install-user` prints the settings to add: the workspace path in `permissions.additionalDirectories` for Claude, and in `writable_roots` under `[sandbox_workspace_write]` for Codex.

## Project-local installation

From the package checkout, preview and then install into an application:

```sh
node bin/halvard.ts install-plan /path/to/app
node bin/halvard.ts install /path/to/app
```

When the package sits outside the application, `install` copies it into `plugins/halvard`. It creates new settings and instruction files with mode 0600 and keeps the mode of existing ones. It merges settings, keeping existing plugins, hooks, permissions and model choices, and stops before writing anything if a registration conflicts. You still register the plugin, restart and approve hook trust in each harness. Pick either project-local or personal install per harness, or the guard runs twice.

Halvard used to be called `agent-workflow`. Before running `install` in a project installed under that name, delete `plugins/agent-workflow`, the `agent-workflow@<marketplace>` entry from `enabledPlugins` in its `.claude/settings.json`, the `agent-workflow` entry from `.agents/plugins/marketplace.json` and the `[plugins."agent-workflow@<marketplace>"]` table from `.codex/config.toml`. Rename `.agent-workflow.json` to `.halvard.json`. Otherwise both plugins stay enabled and the guard runs twice. `install` keeps the name of an existing `.agents/plugins/marketplace.json`, because that file can list the repository's other plugins.

To repair a vendored copy you have reviewed:

```sh
node bin/halvard.ts install-plan /path/to/app --repair
node bin/halvard.ts install /path/to/app --repair
```

The installer stages package and settings changes and rolls them back when an IO error is reported. If the rollback fails, the backups stay and the command reports an error. A crash mid-install can leave staging or backup directories behind, so inspect them before deleting.

## Extensions

An extension may export `pre({root, config, action})`, which returns a reason to deny, and `post({root, config, action})`, which returns feedback. Either may be async. File actions carry `{path, before, after}` previews, with `after: null` for a deletion. Shell actions carry the command and working directory.

Extensions are trusted project code, and a `post` hook cannot undo what a tool already did. Language-specific formatters and structural checks belong in extensions, not in the shared engine.
