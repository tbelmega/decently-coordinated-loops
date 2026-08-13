#!/usr/bin/env bash
# install.sh — wire decently-coordinated-loops (DCL) into this machine's agent
# harnesses.
#
# Default (no args):
#   - Symlinks each skills/<name>/ into every destination listed in
#     setup/skill-dirs.txt, the generated mirror of setup/harnesses.ts. This script
#     stays bash-only (no bun on the plain path), so it reads the list rather than
#     the registry; setup/harnesses.test.ts fails if the two drift apart. A path
#     that already exists and is not a link to this repo is left untouched and
#     reported.
#
# --config-dir <dir> (repeatable): also symlink the skills into <dir>/skills.
#   Use it for each extra Claude profile / CLAUDE_CONFIG_DIR you run — e.g. a
#   machine with several profiles wires them all in one invocation:
#     ./install.sh --config-dir ~/.claude-work --config-dir ~/.claude-personal
#   The default ~/.claude and ~/.agents targets are always linked as well.
#   (Config-block seeding via --seed still targets the default config only.)
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

# Canonical absolute path of a directory, portably. `readlink -f` is GNU-only: stock
# macOS ships BSD readlink, which has no -f, so both sides of a comparison would fail to
# the empty string and any existing symlink would read as already current. `cd -P` plus
# `pwd -P` resolves symlinks with the shell alone, and both operands here are directories.
canonical_dir() {
  (cd -P "$1" 2>/dev/null && pwd -P)
}

link_skills() {
  local target_root="$1"
  mkdir -p "$target_root"
  local linked=0 current=0
  for skill_dir in "$REPO_DIR"/skills/*/; do
    [ -d "$skill_dir" ] || continue
    local name link
    name="$(basename "$skill_dir")"
    link="$target_root/$name"
    if [ -L "$link" ] && [ -n "$(canonical_dir "$link")" ] &&
       [ "$(canonical_dir "$link")" = "$(canonical_dir "$skill_dir")" ]; then
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

# Pull optional --config-dir values out of the args; everything else (notably
# --seed and its arguments) passes through unchanged.
extra_config_dirs=()
passthrough_args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --config-dir)
      if [ "$#" -lt 2 ]; then
        echo "--config-dir requires a directory argument" >&2
        exit 1
      fi
      extra_config_dirs+=("$2")
      shift 2
      ;;
    *)
      passthrough_args+=("$1")
      shift
      ;;
  esac
done
set -- ${passthrough_args[@]+"${passthrough_args[@]}"}

echo "Linking DCL skills:"
skill_dirs_file="$REPO_DIR/setup/skill-dirs.txt"
if [ ! -f "$skill_dirs_file" ]; then
  echo "missing $skill_dirs_file — cannot tell where skills belong" >&2
  exit 1
fi
# Comments and blank lines skipped; every other line is a home-relative destination.
#
# Destinations this run creates are recorded and handed to the seeder. A harness whose
# config home contains nothing but a skills tree we just made is not evidence that the
# harness is installed, and without this the two halves of `./install.sh --seed` would
# conspire: link first, then read our own directory back as detection.
created_skill_dirs=""
while IFS= read -r skill_dir || [ -n "$skill_dir" ]; do
  case "$skill_dir" in ""|\#*) continue ;; esac
  [ -d "$HOME/$skill_dir" ] || created_skill_dirs="$created_skill_dirs$skill_dir
"
  link_skills "$HOME/$skill_dir"
done < "$skill_dirs_file"
export DCL_CREATED_SKILL_DIRS="$created_skill_dirs"
for extra_dir in ${extra_config_dirs[@]+"${extra_config_dirs[@]}"}; do
  link_skills "$extra_dir/skills"
done

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
