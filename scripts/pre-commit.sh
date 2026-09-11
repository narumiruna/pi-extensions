#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

./node_modules/.bin/biome migrate --write
./node_modules/.bin/biome format --write
./node_modules/.bin/biome check --write
node ./scripts/run-typechecks.mjs --staged
