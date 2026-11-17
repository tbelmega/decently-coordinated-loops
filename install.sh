#!/usr/bin/env bash
# install.sh - wire decently-coordinated-loops (DCL) into this machine's agent
# harnesses.
#
# Default (no args):
#   - Installs the operating guide (guide/OPERATING-GUIDE.md) into every detected
#     harness config via setup/install-guide.ts, which needs bun; without bun the
#     skills are still linked and the guide is skipped with a warning.
#   - Symlinks each skills/<name>/ into every destination listed in
#     setup/skill-dirs.txt, the generated mirror of setup/harnesses.ts. Skills are
#     linked in bash alone, so a machine without bun still gets them; that is why this
#     reads the list rather than the registry, and setup/harnesses.test.ts fails if
#     the two drift apart. A path
#     that already exists and is not a link to this repo is left untouched and
#     reported, except a link a decently-capable-powers install made to a skill this
#     repo now carries, which is repointed here.
#
# --config-dir <dir> (repeatable): also symlink the skills into <dir>/skills.
#   Use it for each extra Claude profile / CLAUDE_CONFIG_DIR you run - e.g. a
#   machine with several profiles wires them all in one invocation:
#     ./install.sh --config-dir ~/.claude-work --config-dir ~/.claude-personal
#   The default skill-dirs.txt targets are always linked as well.
#   (Config-block seeding via --seed already reaches every ~/.claude-* profile on
#   its own - --config-dir adds skill links only, not config-block targets.)
#
# --seed <dir> [seed args...]: additionally stand up (or join) a data repo by
#   chaining setup/seed.ts, which also installs the agent-config block into the
#   harness global configs (block content carries the data-repo path and owner).
#
# Idempotent - re-run after every `git pull` of this repo, then run
# `bun setup/seed.ts <data-repo> --join` to add newly generated data-repo commands.
# If you move this clone, the join also refreshes paths baked into the data repo's
# package.json; DCL_HOME may override them.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Canonical absolute path of a directory, portably. `readlink -f` is GNU-only: stock
# macOS ships BSD readlink, which has no -f, so both sides of a comparison would fail to
# the empty string and any existing symlink would read as already current. `cd -P` plus
# `pwd -P` resolves symlinks with the shell alone, and both operands here are directories.
canonical_dir() {
  (cd -P "$1" 2>/dev/null && pwd -P)
}

# Is $1 a link an earlier decently-capable-powers (DCP) install made: one into
# <checkout>/skills/<name>, where <checkout> is a DCP clone (its installer says so) or, if
# that clone is gone, a directory named decently-capable-powers? DCL now carries skills that
# came from DCP, and without this its install would report those links and leave them.
is_dcp_skill_link() {
  local destination skills checkout
  destination="$(readlink "$1")"
  case "$destination" in /*) ;; *) destination="$(dirname "$1")/$destination" ;; esac
  skills="$(dirname "$destination")"
  [ "$(basename "$skills")" = skills ] || return 1
  checkout="$(dirname "$skills")"
  if [ -f "$checkout/install.sh" ]; then
    grep -q "deploy decently-capable-powers" "$checkout/install.sh"
  else
    [ ! -e "$checkout" ] && [ "$(basename "$checkout")" = decently-capable-powers ]
  fi
}

link_skills() {
  local target_root="$1"
  mkdir -p "$target_root"
  local linked=0 current=0 taken=0
  for skill_dir in "$REPO_DIR"/skills/*/; do
    [ -d "$skill_dir" ] || continue
    local name link
    name="$(basename "$skill_dir")"
    link="$target_root/$name"
    if [ -L "$link" ] && [ -n "$(canonical_dir "$link")" ] &&
       [ "$(canonical_dir "$link")" = "$(canonical_dir "$skill_dir")" ]; then
      current=$((current + 1))
    elif [ -L "$link" ] && is_dcp_skill_link "$link"; then
      rm -f "$link"
      ln -s "${skill_dir%/}" "$link"
      echo "  ~ $link taken over from decently-capable-powers"
      taken=$((taken + 1))
    elif [ -e "$link" ] || [ -L "$link" ]; then
      echo "  ! $link exists and is not a link to this repo - left untouched"
    else
      ln -s "${skill_dir%/}" "$link"
      linked=$((linked + 1))
    fi
  done
  echo "  $target_root: $linked newly linked, $taken taken over, $current already current"
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
  echo "missing $skill_dirs_file - cannot tell where skills belong" >&2
  exit 1
fi
# Comments and blank lines skipped; every other line is a home-relative destination.
#
# Destinations this run creates are recorded and handed to the seeder. A harness whose
# config home contains nothing but a skills tree we just made is not evidence that the
# harness is installed, and without this the two halves of `./install.sh --seed` would
# conspire: link first, then read our own directory back as detection.
#
# The top-level home directory (`.kiro` for `.kiro/skills`) is recorded the same way when
# this run creates it: a harness detected by that directory's mere existence must not
# read a home the installer just made as proof the harness is installed.
created_skill_dirs=""
while IFS= read -r skill_dir || [ -n "$skill_dir" ]; do
  case "$skill_dir" in ""|\#*) continue ;; esac
  top_dir="${skill_dir%%/*}"
  [ -d "$HOME/$top_dir" ] || created_skill_dirs="$created_skill_dirs$top_dir
"
  [ -d "$HOME/$skill_dir" ] || created_skill_dirs="$created_skill_dirs$skill_dir
"
  link_skills "$HOME/$skill_dir"
done < "$skill_dirs_file"
export DCL_CREATED_SKILL_DIRS="$created_skill_dirs"
for extra_dir in ${extra_config_dirs[@]+"${extra_config_dirs[@]}"}; do
  link_skills "$extra_dir/skills"
done

# The operating guide goes onto every machine, data repo or not. A --seed run installs it
# itself, ahead of the board section that extends it.
if [ "${1:-}" != "--seed" ]; then
  echo
  if command -v bun >/dev/null 2>&1; then
    bun "$REPO_DIR/setup/install-guide.ts"
  else
    echo "! bun not found (https://bun.sh) - skills are linked, but the operating guide was not installed"
  fi
fi

if [ "${1:-}" = "--seed" ]; then
  shift
  if ! command -v bun >/dev/null 2>&1; then
    echo "bun is required for seeding (https://bun.sh) - install it, or run:"
    echo "  node --experimental-strip-types setup/seed.ts $*"
    exit 1
  fi
  bun "$REPO_DIR/setup/seed.ts" "$@"
else
  echo
  echo "Next: stand up (or join) a data repo:"
  echo "  ./install.sh --seed <data-repo-dir> [--owner NAME] [--branch BRANCH] [--join]"
fi
