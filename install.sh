#!/usr/bin/env bash
# install.sh — wire decently-coordinated-loops (DCL) into this machine's agent
# harnesses.
#
# Default (no args):
#   - Symlinks each skills/<name>/ into ~/.claude/skills/ (read by Claude Code)
#     and ~/.agents/skills/ (read by other skill-aware harnesses). A path that
#     already exists and is not a link to this repo is left untouched and
#     reported.
#
# --seed <dir> [seed args...]: additionally stand up (or join) a data repo by
#   chaining setup/seed.ts, which also installs the agent-config block into the
#   harness global configs (block content carries the data-repo path and owner).
#
# Idempotent — re-run after every `git pull` of this repo. If you move this
# clone, re-run install.sh and `setup/seed.ts <data-repo> --join` (or set
# DCL_HOME in your environment to override the paths baked into a data repo's
# package.json).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

link_skills() {
  local target_root="$1"
  mkdir -p "$target_root"
  local linked=0 current=0
  for skill_dir in "$REPO_DIR"/skills/*/; do
    [ -d "$skill_dir" ] || continue
    local name link
    name="$(basename "$skill_dir")"
    link="$target_root/$name"
    if [ -L "$link" ] && [ "$(readlink -f "$link")" = "$(readlink -f "$skill_dir")" ]; then
      current=$((current + 1))
    elif [ -e "$link" ] || [ -L "$link" ]; then
      echo "  ! $link exists and is not a link to this repo — left untouched"
    else
      ln -s "${skill_dir%/}" "$link"
      linked=$((linked + 1))
    fi
  done
  echo "  $target_root: $linked newly linked, $current already current"
}

echo "Linking DCL skills:"
link_skills "$HOME/.claude/skills"
link_skills "$HOME/.agents/skills"

if [ "${1:-}" = "--seed" ]; then
  shift
  if ! command -v bun >/dev/null 2>&1; then
    echo "bun is required for seeding (https://bun.sh) — install it, or run:"
    echo "  node --experimental-strip-types setup/seed.ts $*"
    exit 1
  fi
  bun "$REPO_DIR/setup/seed.ts" "$@"
else
  echo
  echo "Next: stand up (or join) a data repo:"
  echo "  ./install.sh --seed <data-repo-dir> [--owner NAME] [--branch BRANCH] [--join]"
fi
