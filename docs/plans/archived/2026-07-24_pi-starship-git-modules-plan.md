# pi-starship Git modules plan

## Goal

Add native `git_branch`, `git_commit`, `git_state`, `git_metrics`, and `git_status` modules to pi-starship, using the vendored Starship behavior as the reference while keeping footer rendering subprocess-free.

## Plan

- [x] Add focused tests for the five modules and cached Git metadata parsing; the initial `npm test` failed on the missing runtime exports, types, and module registrations.
- [x] Extend `extensions/pi-starship/src/modules/git/` and the runtime snapshot so one refresh supplies branch, commit, operation state, line metrics, and detailed status values; focused pi-starship tests pass.
- [x] Register the modules in Starship order, keep commit/state/metrics out of the built-in root format, update English documentation, and cover the public variables and defaults.
- [x] Run `npm run check`, inspect `npm run pack:starship`, and archive this completed plan; both commands passed and the Pi entrypoint loaded with `--list-models`.

## Completion Checklist

- [x] All five requested Git modules are registered, configurable through module format/style/symbol/disabled fields, and rendered only from cached state.
- [x] Git subprocess failures and non-repository directories degrade to empty modules without breaking the footer.
- [x] Lifecycle generation guards and shutdown cleanup still prevent stale Git results from reaching replacement sessions.
- [x] README module reference and package layout describe the implemented behavior.
- [x] CI-equivalent checks and the pi-starship package dry run pass.
