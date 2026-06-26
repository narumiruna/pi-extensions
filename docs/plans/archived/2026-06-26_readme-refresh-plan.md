## Goal

Refresh the root `README.md` so it matches the current active extension workspaces, npm scripts, just recipes, and package publication state.

## Context

`README.md` was missing the active `pi-plan-mode` and `pi-wait-what` packages, and its new-package publishing example still named already-published `@narumitw/pi-subagents`.

## Plan

- [x] Update the package summary and package table in `README.md` to include `@narumitw/pi-plan-mode` and `@narumitw/pi-wait-what`; verified by the package/link comparison command reporting 14 active packages covered.
- [x] Add concise use-case sections for plan mode and wait-what in `README.md`; verified by the use-case link check for `extensions/pi-plan-mode` and `extensions/pi-wait-what`.
- [x] Add local try and pack commands for `pi-plan-mode` and `pi-wait-what`; verified by the README/package.json/`just --list` command check for 14 active packages.
- [x] Update the publishing note so the brand-new scoped package example is not `@narumitw/pi-subagents`; verified by README search and `npm view @narumitw/pi-subagents version --silent` returning `0.9.1`.
- [x] Update the repository structure tree to include `pi-plan-mode` and `pi-wait-what`; verified by the tree comparison reporting 14 active and 5 deprecated extension directories.
- [x] Run `npm run biome:check` after editing `README.md`; verified by successful command output: `Checked 64 files in 26ms. No fixes applied.`

## Completion Checklist

- [x] Root `README.md` lists every active package under `extensions/pi-*`, verified by the package/link comparison command reporting 14 active packages covered.
- [x] Development commands in `README.md` match root `package.json` scripts and `justfile` recipes, verified by the README/package.json/`just --list` command check for 14 active packages.
- [x] Stale `@narumitw/pi-subagents` brand-new-package wording is removed or replaced, verified by README search reporting no stale wording remains.
- [x] Formatting/linting for the README change passes, verified by `npm run biome:check`.
