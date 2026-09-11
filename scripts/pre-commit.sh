#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

./node_modules/.bin/biome check --staged --no-errors-on-unmatched
node ./scripts/run-typechecks.mjs --staged
