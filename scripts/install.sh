#!/bin/sh
# Install or update Halvard from GitHub in every harness found on PATH.
# Run it again to update. It also removes an install under the earlier
# agent-workflow name, which would otherwise run the guard twice.
#
#   sh install.sh             one line per step; a failing step shows its output
#   sh install.sh --verbose   also show every command and its full output

set -e

verbose=${HALVARD_VERBOSE-}
case "$#:${1-}" in
  0:) ;;
  1:--verbose) verbose=1 ;;
  *)
    echo "usage: install.sh [--verbose]" >&2
    exit 2
    ;;
esac

repo=ghulando/halvard
market=ghulando
plugin=halvard
pi_source=git:github.com/$repo
# The earlier agent-workflow plugin, under this marketplace or its own old one.
old_market=agent-workflow-local
old_ids="agent-workflow@$market agent-workflow@$old_market"
old_pi=git:github.com/ghulando/agent-workflow
halvard_home=${HALVARD_HOME:-$HOME/.config/halvard}

node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`Node ${process.versions.node} is too old; Halvard needs 22.18 or newer.`);
  process.exit(1);
}'

# Colors and questions only on a terminal; NO_COLOR turns colors off.
color=
interactive=
if [ -t 1 ]; then
  [ -n "${NO_COLOR-}" ] || color=1
  { : < /dev/tty; } 2> /dev/null && interactive=1
fi
paint() {
  if [ -n "$color" ]; then printf '\033[%sm%s\033[0m' "$1" "$2"; else printf '%s' "$2"; fi
}
section() { printf '\n%s\n' "$(paint "1;$1" "■ $2")"; }
ok() { printf '  %s %s\n' "$(paint 32 '✓')" "$1"; }
skip() { printf '  %s %s\n' "$(paint 2 '-')" "$(paint 2 "$1")"; }
note() { printf '  %s %s\n' "$(paint 33 '!')" "$1"; }
fail() { printf '  %s %s\n' "$(paint 31 '✗')" "$1" >&2; }
tilde() { case $1 in "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;; *) printf '%s' "$1" ;; esac; }

# One color per harness, used for its section and its summary line.
c_claude='38;5;208'
c_codex='38;5;42'
c_pi='38;5;177'
c_grok='38;5;45'
c_cursor='38;5;33'

out=$(mktemp "${TMPDIR:-/tmp}/halvard-install.XXXXXX")
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

# ask <question>: true when the user answers yes on the terminal.
ask() {
  printf '  %s %s [y/N] ' "$(paint 36 '?')" "$1" > /dev/tty
  read -r answer < /dev/tty || answer=
  case $answer in [yY] | [yY][eE][sS]) return 0 ;; esac
  return 1
}

# clone_or_pull <dir> <message>: keep a shallow clone of Halvard at dir.
clone_or_pull() {
  command -v git > /dev/null || {
    fail "Git is required for $2."
    exit 1
  }
  if [ -d "$1/.git" ]; then
    step "pulled the latest Halvard into $(tilde "$1")" git -C "$1" pull --ff-only --quiet
  else
    mkdir -p "$(dirname "$1")"
    step "cloned Halvard into $(tilde "$1")" git clone --quiet --depth 1 "https://github.com/$repo.git" "$1"
  fi
}

r_claude=
r_codex=
r_pi=
r_grok=
r_cursor=

section "$c_claude" "Claude Code"
if command -v claude > /dev/null; then
  markets=$(listing claude plugin marketplace list --json)
  plugins=$(listing claude plugin list --json)
  expect "$markets" "Array.isArray(j) && j.every((m) => typeof m?.name === 'string')" "claude plugin marketplace list"
  expect "$plugins" "Array.isArray(j) && j.every((p) => typeof p?.id === 'string' && typeof p.scope === 'string')" "claude plugin list"
  for id in $old_ids; do
    if has "$plugins" "j.some((p) => p.id === '$id' && p.scope === 'user')"; then
      step "removed the earlier $id" claude plugin uninstall "$id"
    fi
  done
  if has "$markets" "j.some((m) => m.name === '$old_market')"; then
    step "removed the earlier $old_market marketplace" claude plugin marketplace remove "$old_market"
  fi
  if has "$markets" "j.some((m) => m.name === '$market')"; then
    step "refreshed the $market marketplace" claude plugin marketplace update "$market"
  else
    step "added the $market marketplace from github.com/$repo" claude plugin marketplace add "$repo"
  fi
  r_claude=installed
  if has "$plugins" "j.some((p) => p.id === '$plugin@$market' && p.scope === 'user')"; then
    step "removed the previous $plugin@$market" claude plugin uninstall "$plugin@$market"
    r_claude=updated
  fi
  step "installed $plugin@$market for your user" claude plugin install "$plugin@$market"
  for id in $old_ids; do
    if has "$plugins" "j.some((p) => p.id === '$id' && p.scope === 'project')"; then
      note "Projects still enable $id. In each one run: claude plugin uninstall $id --scope project"
    fi
  done
else
  skip "not on PATH, skipped"
fi

section "$c_codex" "Codex"
if command -v codex > /dev/null; then
  markets=$(listing codex plugin marketplace list --json)
  plugins=$(listing codex plugin list --json)
  expect "$markets" "Array.isArray(j.marketplaces) && j.marketplaces.every((m) => typeof m?.name === 'string')" "codex plugin marketplace list"
  expect "$plugins" "Array.isArray(j.installed) && j.installed.every((p) => typeof p?.pluginId === 'string')" "codex plugin list"
  for id in $old_ids; do
    if has "$plugins" "j.installed.some((p) => p.pluginId === '$id')"; then
      step "removed the earlier $id" codex plugin remove "$id"
    fi
  done
  if has "$markets" "j.marketplaces.some((m) => m.name === '$old_market')"; then
    step "removed the earlier $old_market marketplace" codex plugin marketplace remove "$old_market"
  fi
  if has "$markets" "j.marketplaces.some((m) => m.name === '$market')"; then
    step "refreshed the $market marketplace" codex plugin marketplace upgrade "$market"
  else
    step "added the $market marketplace from github.com/$repo" codex plugin marketplace add "$repo"
  fi
  r_codex=installed
  if has "$plugins" "j.installed.some((p) => p.pluginId === '$plugin@$market')"; then
    step "removed the previous $plugin@$market" codex plugin remove "$plugin@$market"
    r_codex=updated
  fi
  step "installed $plugin@$market" codex plugin add "$plugin@$market"
else
  skip "not on PATH, skipped"
fi

section "$c_pi" "Pi"
if command -v pi > /dev/null; then
  packages=$(listing pi list)
  if printf '%s\n' "$packages" | grep -qxF "  $old_pi"; then
    step "removed the earlier $old_pi" pi remove "$old_pi"
  fi
  if printf '%s\n' "$packages" | grep -qxF "  $pi_source"; then
    step "updated $pi_source" pi update "$pi_source"
    r_pi=updated
  else
    step "installed $pi_source" pi install "$pi_source"
    r_pi=installed
  fi
else
  skip "not on PATH, skipped"
fi

# Grok's plugin list shape: an array, or one under plugins or installed.
grok_plugins='(Array.isArray(j) ? j : j.plugins ?? j.installed)'
grok_root=$halvard_home/grok

# Installs from the marketplace, then straight from GitHub, then from a local clone,
# reporting why each earlier source was refused.
grok_install() {
  if quietly grok plugin install "$plugin" --trust; then
    ok "installed $plugin from the $market marketplace, hooks trusted"
    return
  fi
  note "Grok refused the $market marketplace: $(sed -n 1p "$out")"
  if quietly grok plugin install "$repo" --trust; then
    ok "installed $plugin from github.com/$repo, hooks trusted"
    return
  fi
  note "Grok refused github.com/$repo: $(sed -n 1p "$out")"
  clone_or_pull "$grok_root" "the Grok install"
  step "installed $plugin from $(tilde "$grok_root"), hooks trusted" grok plugin install "$grok_root" --trust
}

section "$c_grok" "Grok"
if command -v grok > /dev/null; then
  plugins=$(listing grok plugin list --json)
  expect "$plugins" "Array.isArray($grok_plugins) && $grok_plugins.every((p) => typeof (p?.name ?? p?.id) === 'string')" "grok plugin list"
  if quietly grok plugin marketplace update "$market"; then
    ok "refreshed the $market marketplace"
  else
    step "added the $market marketplace from github.com/$repo" grok plugin marketplace add "$repo"
  fi
  if has "$plugins" "$grok_plugins.some((p) => (p.name ?? p.id) === '$plugin' || (p.name ?? p.id) === '$plugin@$market')"; then
    # An install from the local clone updates from that clone.
    if [ -d "$grok_root/.git" ]; then clone_or_pull "$grok_root" "the Grok update"; fi
    step "updated $plugin" grok plugin update "$plugin"
    r_grok=updated
  elif [ -n "$interactive" ] && ask "Grok installs a plugin only by trusting its hooks, which then check every Grok tool call. Install Halvard in Grok?"; then
    # Installing a Grok plugin grants it hook trust, so it waits for the user's yes.
    grok_install
    r_grok=installed
  else
    note "not installed: Grok installs a plugin only with hook trust, which stays your decision"
    r_grok=waiting
  fi
else
  skip "not on PATH, skipped"
fi

section "$c_cursor" "Cursor"
if command -v cursor-agent > /dev/null; then
  cursor_root=$halvard_home/cursor
  clone_or_pull "$cursor_root" "the Cursor install"
  cursor_dir=${CURSOR_CONFIG_DIR:-$HOME/.cursor}
  # Cursor has no CLI plugins: merge Halvard's entries into the user hooks file and
  # link the skills. Entries from an earlier install are replaced, others are kept.
  node -e '
const fs = require("node:fs");
const path = require("node:path");
const [root, dir, color, home] = process.argv.slice(1);
const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const tilde = (p) => (home && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
if (/["$`\\]/.test(root)) throw new Error(`unsupported characters in ${root}`);
const ours = (entry) =>
  typeof entry?.command === "string" && entry.command.includes("/bin/hook.ts\"") && entry.command.includes("\"$f\" cursor");
const template = JSON.parse(fs.readFileSync(path.join(root, "hooks/cursor.json"), "utf8"));
const file = path.join(dir, "hooks.json");
const existed = fs.existsSync(file);
const config = existed ? JSON.parse(fs.readFileSync(file, "utf8")) : { version: 1, hooks: {} };
if (!config || typeof config.hooks !== "object" || Array.isArray(config.hooks)) {
  throw new Error(`unexpected shape in ${file}; nothing was changed for Cursor`);
}
if (existed) fs.copyFileSync(file, `${file}.halvard.bak`);
for (const [event, entries] of Object.entries(config.hooks)) {
  if (Array.isArray(entries)) config.hooks[event] = entries.filter((entry) => !ours(entry));
}
for (const [event, entries] of Object.entries(template.hooks)) {
  config.hooks[event] = [
    ...(config.hooks[event] ?? []),
    ...entries.map((entry) => ({ ...entry, command: entry.command.replaceAll("${HALVARD_ROOT}", root) })),
  ];
}
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
const backup = existed ? ` (backup: ${path.basename(file)}.halvard.bak)` : "";
console.log(`  ${paint(32, "✓")} wrote Halvard hooks for ${Object.keys(template.hooks).length} events into ${tilde(file)}${backup}`);
const skills = path.join(dir, "skills");
fs.mkdirSync(skills, { recursive: true });
let linked = 0;
for (const name of fs.readdirSync(path.join(root, "skills"))) {
  const link = path.join(skills, name);
  const target = path.join(root, "skills", name);
  const stat = fs.lstatSync(link, { throwIfNoEntry: false });
  if (stat && !stat.isSymbolicLink()) {
    console.log(`  ${paint(33, "!")} kept your own ${tilde(link)}; Halvard did not link its ${name} skill`);
    continue;
  }
  if (stat) fs.rmSync(link);
  fs.symlinkSync(target, link);
  linked++;
}
console.log(`  ${paint(32, "✓")} linked ${linked} skills into ${tilde(skills)}`);
' "$cursor_root" "$cursor_dir" "$color" "$HOME"
  r_cursor=installed
else
  skip "not on PATH, skipped"
fi

# summary <color> <name> <result>
summary() {
  case $3 in
    installed | updated) state=$(paint 32 "$3") ;;
    waiting) state=$(paint 33 'not installed: waiting for your yes, run this script again in a terminal') ;;
    *) state=$(paint 2 'skipped, not on PATH') ;;
  esac
  printf '  %s %s\n' "$(paint "1;$1" "$(printf '%-12s' "$2")")" "$state"
}

printf '\n%s\n' "$(paint 1 'Summary')"
summary "$c_claude" "Claude Code" "$r_claude"
summary "$c_codex" "Codex" "$r_codex"
summary "$c_pi" "Pi" "$r_pi"
summary "$c_grok" "Grok" "$r_grok"
summary "$c_cursor" "Cursor" "$r_cursor"

printf '\n%s\n' "Next: restart every open Claude Code, Codex, Pi, Grok and Cursor session, and approve hook trust when asked."

# The workspace note names only the settings that still lack the task workspace.
workspace=${HALVARD_WORKSPACE:-$HOME/.halvard}
missing=$(node -e '
const fs = require("node:fs");
const [claude, codex, workspace, claudeDir, codexDir] = process.argv.slice(1);
const read = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } };
if (claude) {
  let dirs = [];
  try { dirs = JSON.parse(read(`${claudeDir}/settings.json`) || "{}").permissions?.additionalDirectories ?? []; } catch {}
  if (!Array.isArray(dirs) || !dirs.includes(workspace)) {
    console.log(`  ~/.claude/settings.json  permissions.additionalDirectories: ["${workspace}"]`);
  }
}
if (codex && !read(`${codexDir}/config.toml`).includes(workspace)) {
  console.log(`  ~/.codex/config.toml     [sandbox_workspace_write] writable_roots = ["${workspace}"]`);
}
' "$r_claude" "$r_codex" "$workspace" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}")
if [ -n "$missing" ]; then
  printf '%s\n%s\n' "Team runs need the task workspace writable. Add:" "$missing"
fi
if [ "$r_grok" = waiting ]; then
  printf '%s\n  %s\n' "To install Halvard in Grok, run this script in a terminal and answer yes, or run:" "grok plugin install $plugin --trust"
fi
