#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
root=$PWD
snapshot=$(mktemp -d "${TMPDIR:-/tmp}/pi-pre-commit.XXXXXX")
trap 'rm -rf "$snapshot"' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

git checkout-index --all --ignore-skip-worktree-bits --prefix="$snapshot/"

npx biome migrate --write
npx biome check --write packages
npx biome format --write packages
(
  cd "$snapshot"
  if ! "$root/node_modules/.bin/biome" check . --error-on-warnings; then
    printf '%s\n' 'Staged files failed Biome checks. Review and stage the fixes, then retry.' >&2
    exit 1
  fi
  uvx zizmor --pedantic .github
)
node ./scripts/run-typechecks.mjs --staged
