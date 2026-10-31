#!/bin/sh
# Remove Halvard from every harness found on PATH, together with the earlier
# agent-workflow install under the ghulando and agent-workflow-local marketplace
# names, with its caches and workflow state. Settings files are backed up before anything changes.
#
#   sh uninstall.sh             keep personal.json and the task workspace
#   sh uninstall.sh --purge     also remove them and the workspace permission entries
#   sh uninstall.sh --verbose   also show every command and its full output

set -e

purge=
verbose=
for arg in "$@"; do
  case "$arg:$purge:$verbose" in
    --purge::*) purge=1 ;;
    --verbose:*:) verbose=1 ;;
    *)
      echo "usage: uninstall.sh [--purge] [--verbose]" >&2
      exit 2
      ;;
  esac
done
[ -n "$verbose" ] || verbose=${HALVARD_VERBOSE-}

command -v node > /dev/null || {
  echo "Node is required to edit harness settings." >&2
  exit 1
}

home=${HOME:?HOME is not set}
# Each id is plugin@marketplace; the agent-workflow ids are the earlier name.
ids="halvard@ghulando agent-workflow@ghulando agent-workflow@agent-workflow-local"
markets="ghulando agent-workflow-local"
pi_sources="git:github.com/ghulando/halvard git:github.com/ghulando/agent-workflow"
claude_dir=${CLAUDE_CONFIG_DIR:-$home/.claude}
codex_dir=${CODEX_HOME:-$home/.codex}
pi_dir=${PI_CODING_AGENT_DIR:-$home/.pi/agent}
cursor_dir=${CURSOR_CONFIG_DIR:-$home/.cursor}
personal=${HALVARD_HOME:-$home/.config/halvard}
old_personal=$home/.config/agent-workflow
workspace=${HALVARD_WORKSPACE:-$home/.halvard}

# Colors only on a terminal; NO_COLOR turns them off.
color=
if [ -t 1 ] && [ -z "${NO_COLOR-}" ]; then color=1; fi
paint() {
  if [ -n "$color" ]; then printf '\033[%sm%s\033[0m' "$1" "$2"; else printf '%s' "$2"; fi
}
section() { printf '\n%s\n' "$(paint "1;$1" "■ $2")"; }
ok() { printf '  %s %s\n' "$(paint 32 '✓')" "$1"; }
skip() { printf '  %s %s\n' "$(paint 2 '-')" "$(paint 2 "$1")"; }
note() { printf '  %s %s\n' "$(paint 33 '!')" "$1"; }
fail() { printf '  %s %s\n' "$(paint 31 '✗')" "$1" >&2; }
tilde() { case $1 in "$home"/*) printf '~%s' "${1#"$home"}" ;; *) printf '%s' "$1" ;; esac; }

# One color per harness, the same as install.sh.
c_claude='38;5;208'
c_codex='38;5;42'
c_pi='38;5;177'
c_grok='38;5;45'
c_cursor='38;5;33'
c_files='38;5;250'

out=$(mktemp "${TMPDIR:-/tmp}/halvard-uninstall.XXXXXX")
trap 'rm -f "$out"' EXIT

# quietly <command...>: run a harness command and keep its output in $out.
quietly() {
  if [ -n "$verbose" ]; then printf '    %s\n' "$(paint 2 "\$ $*")"; fi
  if "$@" > "$out" 2>&1; then
    if [ -n "$verbose" ]; then sed 's/^/      /' "$out"; fi
    return 0
  fi
  return 1
}

stop() {
  sed -n '1,20p' "$out" | sed 's/^/      /' >&2
  printf '\nStopped. Harnesses above this one are done; the rest are unchanged. Fix this and run the script again.\n' >&2
  exit 1
}

# step <message> <command...>: run the command and print the message, or its output and stop.
step() {
  message=$1
  shift
  if quietly "$@"; then
    ok "$message"
    changed=1
  else
    fail "$message: failed ($*)"
    stop
  fi
}

# listing <command...>: print a harness listing; on failure report it and stop.
listing() {
  "$@" 2> "$out" || {
    fail "$* failed"
    stop
  }
}

# done_section: say so when a harness section found nothing to remove.
changed=
done_section() {
  [ -n "$changed" ] || skip "no Halvard install found"
  changed=
}

# has <json> <expression>: true when the expression, applied to the parsed JSON as j, is truthy.
has() {
  printf '%s' "$1" | node -e '
let raw = "";
process.stdin.on("data", (c) => (raw += c)).on("end", () => {
  const j = JSON.parse(raw);
  process.exit(eval(process.argv[1]) ? 0 : 1);
});' "$2"
}

# A predicate called from an if cannot stop the script, so check the shape first.
expect() {
  has "$1" "$2" || {
    fail "Unexpected output from $3; nothing was changed for this harness."
    exit 1
  }
}

# Harness CLIs edit these files too, so copy them before any command runs.
section "$c_files" "Backups"
for file in "$claude_dir/settings.json" "$codex_dir/config.toml" "$cursor_dir/hooks.json"; do
  if [ -f "$file" ]; then
    cp "$file" "$file.halvard.bak"
    ok "backed up $(tilde "$file") to $(basename "$file").halvard.bak"
    changed=1
  fi
done
[ -n "$changed" ] || skip "no harness settings files to back up"
changed=

section "$c_claude" "Claude Code"
if command -v claude > /dev/null; then
  list=$(listing claude plugin marketplace list --json)
  plugins=$(listing claude plugin list --json)
  expect "$list" "Array.isArray(j) && j.every((m) => typeof m?.name === 'string')" "claude plugin marketplace list"
  expect "$plugins" "Array.isArray(j) && j.every((p) => typeof p?.id === 'string' && typeof p.scope === 'string')" "claude plugin list"
  for id in $ids; do
    if has "$plugins" "j.some((p) => p.id === '$id' && p.scope === 'user')"; then
      step "uninstalled $id" claude plugin uninstall "$id"
    fi
    # Project-scope installs live in each project's own settings, which this script leaves alone.
    printf '%s' "$plugins" | node -e '
let raw = "";
process.stdin.on("data", (c) => (raw += c)).on("end", () => {
  for (const p of JSON.parse(raw)) {
    if (p.id === process.argv[1] && p.scope !== "user" && p.projectPath) {
      console.log(`  ! ${p.projectPath} still enables ${p.id}; there run: claude plugin uninstall ${p.id} --scope ${p.scope}`);
    }
  }
});' "$id"
  done
  for market in $markets; do
    if has "$list" "j.some((m) => m.name === '$market')"; then
      step "removed the $market marketplace" claude plugin marketplace remove "$market"
    fi
  done
  done_section
else
  skip "not on PATH, skipped"
fi

section "$c_codex" "Codex"
if command -v codex > /dev/null; then
  list=$(listing codex plugin marketplace list --json)
  plugins=$(listing codex plugin list --json)
  expect "$list" "Array.isArray(j.marketplaces) && j.marketplaces.every((m) => typeof m?.name === 'string')" "codex plugin marketplace list"
  expect "$plugins" "Array.isArray(j.installed) && j.installed.every((p) => typeof p?.pluginId === 'string')" "codex plugin list"
  for id in $ids; do
    if has "$plugins" "j.installed.some((p) => p.pluginId === '$id')"; then
      step "removed $id" codex plugin remove "$id"
    fi
  done
  for market in $markets; do
    if has "$list" "j.marketplaces.some((m) => m.name === '$market')"; then
      step "removed the $market marketplace" codex plugin marketplace remove "$market"
    fi
  done
  done_section
else
  skip "not on PATH, skipped"
fi

section "$c_pi" "Pi"
if command -v pi > /dev/null; then
  packages=$(listing pi list)
  # A GitHub install, or the package copied by install-user.
  for source in $pi_sources "$personal/package" "$old_personal/package"; do
    if printf '%s\n' "$packages" | grep -qxF "  $source"; then
      step "removed $(tilde "$source")" pi remove "$source"
    fi
  done
  done_section
else
  skip "not on PATH, skipped"
fi

section "$c_grok" "Grok"
if command -v grok > /dev/null; then
  plugins=$(listing grok plugin list --json)
  grok_plugins='(Array.isArray(j) ? j : j.plugins ?? j.installed)'
  expect "$plugins" "Array.isArray($grok_plugins) && $grok_plugins.every((p) => typeof (p?.name ?? p?.id) === 'string')" "grok plugin list"
  # Grok names an installed plugin by its own name, without the marketplace.
  for plugin in halvard agent-workflow; do
    if has "$plugins" "$grok_plugins.some((p) => (p.name ?? p.id ?? '').split('@')[0] === '$plugin')"; then
      step "uninstalled $plugin" grok plugin uninstall "$plugin" --confirm
    fi
  done
  # Grok removes a marketplace by name; earlier releases took the repository. Grok also
  # lists Claude Code's marketplaces, so removing Claude's can remove this one already.
  if quietly grok plugin marketplace remove ghulando || quietly grok plugin marketplace remove ghulando/halvard; then
    ok "removed the ghulando marketplace"
    changed=1
  elif ! grep -qi 'not found' "$out"; then
    note "Grok could not remove the ghulando marketplace: $(sed -n 1p "$out")"
    changed=1
  fi
  done_section
else
  skip "not on PATH, skipped"
fi

section "$c_files" "Harness settings"
node -e '
const fs = require("node:fs");
const [claudeDir, codexDir, workspace, purge] = process.argv.slice(1);
const ids = process.argv[5].split(" ");
const markets = process.argv[6].split(" ");
const [color, home] = process.argv.slice(7);
const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const tilde = (p) => (p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);

function edit(path, change) {
  if (!fs.existsSync(path)) return;
  const before = fs.readFileSync(path, "utf8");
  const after = change(before);
  if (after === before) return;
  fs.writeFileSync(path, after);
  console.log(`  ${paint(32, "✓")} removed Halvard entries from ${tilde(path)}`);
}

edit(`${claudeDir}/settings.json`, (text) => {
  const settings = JSON.parse(text);
  const original = JSON.stringify(settings);
  for (const id of ids) delete settings.enabledPlugins?.[id];
  for (const market of markets) delete settings.extraKnownMarketplaces?.[market];
  const dirs = settings.permissions?.additionalDirectories;
  if (purge && Array.isArray(dirs)) {
    settings.permissions.additionalDirectories = dirs.filter((dir) => dir !== workspace);
  }
  return JSON.stringify(settings) === original ? text : JSON.stringify(settings, null, 2) + "\n";
});

// Node has no TOML parser, so this splits on table header lines. A header may be
// indented, use either quote style and carry a trailing comment.
const header = /^[ \t]*\[\[?[^\]\n]*\]\]?[ \t]*(?:#[^\n]*)?$/m;
const tablesOf = (text) => text.split(/(?=^[ \t]*\[\[?[^\]\n]*\]\]?[ \t]*(?:#[^\n]*)?$)/m);
const keyOf = (table) => {
  const match = table.match(header);
  return match && table.startsWith(match[0]) ? match[0].replace(/#.*$/, "").replace(/["\x27\s]/g, "") : "";
};
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Removes the workspace from a writable_roots array, single- or multi-line.
function withoutWorkspace(table) {
  const start = table.search(/^[ \t]*writable_roots[ \t]*=[ \t]*\[/m);
  if (start < 0) return table;
  let i = table.indexOf("[", start) + 1;
  let depth = 1;
  while (i < table.length && depth) {
    const ch = table[i];
    if (ch === "\"") {
      for (i++; i < table.length && table[i] !== "\""; i += table[i] === "\\" ? 2 : 1);
    } else if (ch === "\x27") {
      i = table.indexOf("\x27", i + 1);
      if (i < 0) i = table.length;
    } else if (ch === "#") {
      i = table.indexOf("\n", i);
      if (i < 0) i = table.length;
      continue;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
    }
    i++;
  }
  const values = [JSON.stringify(workspace), `\x27${workspace}\x27`].map(escape).join("|");
  const array = table.slice(start, i).replace(new RegExp(`(?:${values})[ \\t]*,?[ \\t]*(?:#[^\\n]*)?`, "g"), "");
  return table.slice(0, start) + array + table.slice(i);
}

// Codex keeps hook trust per plugin id; drop those tables and the plugin and marketplace tables.
edit(`${codexDir}/config.toml`, (text) => {
  const owned = (key) =>
    ids.some((id) => key.startsWith(`[hooks.state.${id}:`) || key === `[plugins.${id}]`) ||
    markets.some((market) => key === `[marketplaces.${market}]`);
  return tablesOf(text)
    .filter((table) => !owned(keyOf(table)))
    .map((table) => (purge && keyOf(table) === "[sandbox_workspace_write]" ? withoutWorkspace(table) : table))
    .join("");
});
' "$claude_dir" "$codex_dir" "$workspace" "$purge" "$ids" "$markets" "$color" "$home"

# Cursor: drop Halvard's entries from the user hooks file and its skill links.
node -e '
const fs = require("node:fs");
const path = require("node:path");
const [dir, root, color, home] = process.argv.slice(1);
const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const tilde = (p) => (p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
const ours = (entry) =>
  typeof entry?.command === "string" && entry.command.includes("/bin/hook.ts\"") && entry.command.includes("\"$f\" cursor");
const file = path.join(dir, "hooks.json");
if (fs.existsSync(file)) {
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  let changed = false;
  for (const [event, entries] of Object.entries(config?.hooks ?? {})) {
    if (!Array.isArray(entries) || !entries.some(ours)) continue;
    config.hooks[event] = entries.filter((entry) => !ours(entry));
    if (!config.hooks[event].length) delete config.hooks[event];
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
    console.log(`  ${paint(32, "✓")} removed Halvard hooks from ${tilde(file)}`);
  }
}
const skills = path.join(dir, "skills");
let unlinked = 0;
for (const name of fs.existsSync(skills) ? fs.readdirSync(skills) : []) {
  const link = path.join(skills, name);
  if (fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link).startsWith(`${root}/`)) {
    fs.rmSync(link);
    unlinked++;
  }
}
if (unlinked) console.log(`  ${paint(32, "✓")} removed ${unlinked} Halvard skill links from ${tilde(skills)}`);
' "$cursor_dir" "$personal/cursor" "$color" "$home"

section "$c_files" "Files"
tmp=$(node -p 'require("node:os").tmpdir()')
remove() {
  if [ -e "$1" ]; then
    rm -rf "$1"
    ok "removed $(tilde "$1")"
    changed=1
  fi
}
for id in $ids; do
  plugin=${id%@*}
  market=${id#*@}
  remove "$claude_dir/plugins/cache/$market/$plugin"
  remove "$claude_dir/plugins/data/$plugin-$market"
  remove "$codex_dir/plugins/cache/$market/$plugin"
done
for market in $markets; do
  remove "$codex_dir/.tmp/marketplaces/$market"
  for parent in "$claude_dir/plugins/cache/$market" "$codex_dir/plugins/cache/$market"; do
    if [ -d "$parent" ] && [ -z "$(ls -A "$parent")" ]; then
      rmdir "$parent"
    fi
  done
done
remove "$pi_dir/git/github.com/ghulando/halvard"
remove "$pi_dir/git/github.com/ghulando/agent-workflow"
remove "$personal/package"
remove "$personal/cursor"
remove "$personal/grok"
remove "$personal/.agents"
remove "$old_personal/package"
remove "$old_personal/.agents"
remove "$tmp/halvard-$(id -u)"
remove "$tmp/agent-workflow-$(id -u)"
if [ -n "$purge" ]; then
  remove "$personal"
  remove "$workspace"
fi
[ -n "$changed" ] || skip "no Halvard files left to remove"

printf '\n%s\n' "$(paint 1 'Done.') Restart every open Claude Code, Codex, Pi, Grok and Cursor session."
printf '%s\n' 'Repositories set up with "halvard.ts install <repo>" keep their own plugins/halvard copy and settings; remove those in each repository.'
if [ -z "$purge" ]; then
  echo "Kept $(tilde "$personal")/personal.json and $(tilde "$workspace"); run with --purge to remove them too."
fi
