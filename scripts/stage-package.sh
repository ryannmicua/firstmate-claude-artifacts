#!/usr/bin/env bash
# Copy the adapter package to a new directory outside every Git project, with
# the canonical modes Firstmate's `fm-extension.sh bind` and `remote-bind`
# accept (directories 0755, the entrypoint 0755, other files 0644).
#
# Usage: scripts/stage-package.sh <absent-destination-directory>
set -eu

usage() {
  sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  '') usage >&2; exit 2 ;;
esac

dest=$1
src=$(cd "$(dirname "$0")/../package" && pwd -P)
case "$dest" in
  /*) ;;
  *) echo "stage-package: destination must be an absolute path" >&2; exit 2 ;;
esac
if [ -e "$dest" ] || [ -L "$dest" ]; then
  echo "stage-package: destination already exists: $dest (stage each version into a new directory)" >&2
  exit 1
fi
parent=$(dirname "$dest")
mkdir -p "$parent"
if git -C "$parent" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "stage-package: destination is inside a Git work tree; Firstmate refuses to bind from there" >&2
  exit 1
fi

umask 022
mkdir "$dest"
(cd "$src" && find . -type d ! -name . -print) | while IFS= read -r dir; do mkdir -m 0755 "$dest/$dir"; done
(cd "$src" && find . -type f -print) | while IFS= read -r file; do
  cp "$src/$file" "$dest/$file"
  chmod 0644 "$dest/$file"
done
chmod 0755 "$dest" "$dest/bin/claude-doc-comments"
version=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$dest/firstmate-extension.json")
printf 'staged claude-doc-comments %s at %s\n' "$version" "$dest"
