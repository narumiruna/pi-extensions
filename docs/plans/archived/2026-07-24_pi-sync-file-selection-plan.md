# pi-sync file selection

## Goal

Add a persistent `/sync files` TUI for choosing top-level Pi files and directory groups, while treating unselected paths as unmanaged and preserving them locally and remotely.

## Plan

- [x] Added red-first tests for `syncFiles` validation/defaults, selected collection/apply policy, and unmanaged remote preservation.
- [x] Centralized the built-in sync catalog and path policy, then threaded `syncFiles` through snapshots, state, comparison, apply, and upload merge behavior.
- [x] Added `/sync files` with a searchable `SettingsList`, safe extra-file discovery, a read-only environment-overridden sessions row, and a non-TUI summary.
- [x] Persisted UI changes serially and atomically while preserving unknown fields, rejecting malformed/symlink config, retaining POSIX `0600`, and rolling back failed UI changes.
- [x] Updated package metadata, npm 11.16.0 lockfile, and README for the new public command and setting.
- [x] Verified with focused red/green cycles, `npm test` (1,154 passing), workspace typechecks, `npm run check`, `just pack-sync` (16 expected files), and an isolated print-mode Pi load/command smoke.

## Completion Checklist

- [x] Existing configs without `syncFiles` retain the full legacy allowlist; empty selection is valid; invalid entries fail safely.
- [x] Unselected built-ins, directories, sessions, and extra files are not collected/applied/deleted and remain preserved in remote uploads.
- [x] TUI and non-TUI command behavior, persistence failures, permissions, and environment override behavior are covered by deterministic tests.
- [x] Documentation and the inspected 16-file package tarball match the implementation.
- [x] All required verification passes; interactive behavior is deterministic-test covered and the runtime smoke used isolated print mode to avoid launching an interactive TUI.
