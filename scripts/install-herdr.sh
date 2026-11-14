#!/bin/sh
# Install or update the Halvard layout for Herdr App: the halvard layout and theme and
# the halvard-watch and halvard-session mods, copied from herdr-app/ into the app's home
# folder ($HERDR_APP_HOME, else ~/.config/herdr-app). It never switches the layout.
#
#   sh scripts/install-herdr.sh           stops before copying if a file there differs
#   sh scripts/install-herdr.sh --force   replaces files that differ
#   sh scripts/install-herdr.sh --remove  removes the files that match this copy

set -e

force=
remove=
case "$#:${1-}" in
  0:) ;;
  1:--force) force=1 ;;
  1:--remove) remove=1 ;;
  *)
    echo "usage: install-herdr.sh [--force | --remove]" >&2
    exit 2
    ;;
esac

source=$(cd "$(dirname "$0")/../herdr-app" && pwd)
home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
if [ ! -d "$home" ]; then
  echo "No Herdr App home at $home; start Herdr App once, or set HERDR_APP_HOME." >&2
  exit 1
fi
# An absolute path with no trailing slash, so the folder walk below reaches it exactly.
home=$(cd "$home" && pwd -P)

files="layouts/halvard.json layouts/halvard.svg themes/halvard.json"
for mod in halvard-watch halvard-session; do
  for file in "$source/mods/$mod"/*; do
    files="$files mods/$mod/${file##*/}"
  done
done

# A file of the same name that differs may be someone else's; check them all before
# copying any, so a refusal leaves the home as it was. A directory, link or other entry
# where a file or folder goes is never replaced: cp would copy into it or through it.
# Each folder between the home and a file must be a real folder or not exist yet; a link
# to one would send the copy outside the home.
folders_clear() {
  folder=$(dirname "$1")
  while [ "$folder" != "$home" ]; do
    if [ -L "$folder" ] || { [ -e "$folder" ] && [ ! -d "$folder" ]; }; then
      return 1
    fi
    folder=$(dirname "$folder")
  done
}

differ=
blocked=
for file in $files; do
  target=$home/$file
  if [ -L "$target" ] || { [ -e "$target" ] && [ ! -f "$target" ]; } ||
    ! folders_clear "$target"; then
    blocked="$blocked
  $target"
  elif [ -e "$target" ] && ! cmp -s "$source/$file" "$target"; then
    differ="$differ
  $target"
  fi
done
# Removal deletes only regular files that match this copy, so a file someone changed stays;
# then the mod folders, if nothing else is left in them.
if [ -n "$remove" ]; then
  removed=0
  for file in $files; do
    target=$home/$file
    if [ -f "$target" ] && [ ! -L "$target" ] && folders_clear "$target" &&
      cmp -s "$source/$file" "$target"; then
      rm "$target"
      removed=$((removed + 1))
    fi
  done
  for mod in halvard-watch halvard-session; do
    if [ -d "$home/mods/$mod" ] && [ ! -L "$home/mods/$mod" ]; then
      rmdir "$home/mods/$mod" 2>/dev/null || true
    fi
  done
  echo "Removed $removed of $(echo $files | wc -w | tr -d ' ') files from $home."
  if [ -n "$differ$blocked" ]; then
    echo "These differ from this copy and were left in place:$differ$blocked" >&2
  fi
  echo "If the halvard layout is active, switch away first: ctrl-shift-l."
  exit 0
fi

if [ -n "$blocked" ]; then
  echo "Something other than a file is in the way; move it and run this again:$blocked" >&2
  exit 1
fi
if [ -n "$differ" ] && [ -z "$force" ]; then
  echo "These files already exist and differ:$differ" >&2
  echo "Rerun with --force to replace them." >&2
  exit 1
fi

copied=0
for file in $files; do
  if [ -e "$home/$file" ] && cmp -s "$source/$file" "$home/$file"; then
    continue
  fi
  mkdir -p "$home/$(dirname "$file")"
  cp "$source/$file" "$home/$file"
  copied=$((copied + 1))
done
echo "Copied $copied of $(echo $files | wc -w | tr -d ' ') files into $home."

if command -v herdr-app >/dev/null 2>&1; then
  for mod in halvard-watch halvard-session; do
    herdr-app check "$home/mods/$mod"
  done
else
  echo "herdr-app is not on PATH; the mods were not checked."
fi
echo "Switch to the layout with: herdr-app do layout.switch --name halvard"
echo "ctrl-shift-l switches back to your previous layout."
