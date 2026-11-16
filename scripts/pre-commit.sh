#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

npx biome migrate --write
npx biome check --write packages
npx biome format --write packages
uvx zizmor --pedantic .github
node ./scripts/run-typechecks.mjs --staged
