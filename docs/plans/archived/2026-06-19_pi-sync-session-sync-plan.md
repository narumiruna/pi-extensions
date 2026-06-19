## Goal

Add opt-in Pi conversation/session syncing to `@narumitw/pi-sync` for issue #99. Success means users can sync Pi JSONL sessions from Pi's configured session directory through the existing R2/S3 snapshot flow, with privacy warnings, backups, conflict protection, tests, and docs.

## Context

Issue #99 asks for `pi-sync` to support synced sessions/conversations. Current docs explicitly said pi-sync did not sync Pi sessions. Pi stores sessions as JSONL under `${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl`; session files are user data and may include prompts, tool output, paths, screenshots, or secrets.

## Architecture

Keep the existing S3/R2 snapshot model and local lock. Add a `syncSessions` config flag, defaulting to `false`, that extends the collected file set with denylist-filtered session JSONL files only. Honor `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, Pi `sessionDir`, and the session manager's custom directory, preserve remote session entries during settings-only operations, and protect the current live session JSONL during destructive applies. Do not add real-time collaborative editing; this remains file snapshot sync.

## Non-Goals

- Do not sync `auth.json`, OAuth state, npm caches, `.pisync`, `.env*`, or arbitrary files under `${PI_CODING_AGENT_DIR:-~/.pi/agent}`.
- Do not support concurrent live editing of the same session file from multiple machines.
- Do not add a new storage backend or database.

## Assumptions

- “Synchronous conversations” in issue #99 means Pi session/conversation files, not live multi-user chat.
- Opt-in is required because sessions are more sensitive than settings.

## Plan

- [x] Confirm the exact Pi session file shape and resume behavior against local Pi docs and one sample file; verified by `docs/sessions.md`, `docs/session-format.md`, `find ~/.pi/agent/sessions -name '*.jsonl' | head -5`, and a sample JSONL header showing `type: "session", version: 3`.
- [x] Add `syncSessions?: boolean | string` config parsing to `extensions/pi-sync/src/sync.ts`, default `false`, with env override `PI_SYNC_SESSIONS`; verified by `syncSessions config defaults off and supports file plus env overrides` in `npm test`.
- [x] Extend snapshot collection so `sessions/**/*.jsonl` is included only when `syncSessions` is enabled, while honoring `PI_CODING_AGENT_DIR` and denying non-JSONL files, symlink escapes, `.pisync`, `.env*`, token/secret paths, and `node_modules`; verified by `snapshot collection includes session jsonl files only when enabled`, `syncSessions config defaults off and supports file plus env overrides`, and `snapshot preflight validates checksums, duplicate session paths, and deletes stale files` in `npm test`.
- [x] Keep pull/rollback safety for sessions by reusing the current backup and preflight apply path, protecting the current live session JSONL, and recording hashes for files actually applied; verified by `snapshot preflight validates checksums, duplicate session paths, and deletes stale files`, `protected session apply plans keep the live session file`, and `session backups include session jsonl files when enabled` in `npm test`.
- [x] Update `/pisync config`, `/pisync doctor`, `/pisync status`, and `/pisync diff` output to show whether sessions are included and to warn that session contents may contain sensitive data; verified by `pisync config output reports session sync and privacy warning` in `npm test` and source review of `status`, `diff`, and `doctor` output.
- [x] Decide whether auto-sync should push on `session_shutdown` when `autoSync` and `syncSessions` are enabled; implemented a quiet shutdown push guarded by `autoSync`, `syncSessions`, local-change detection, non-reload shutdown, event-shape safety, and the existing lock, with async shutdown support grounded in Pi extension docs and the `auto-commit-on-exit.ts` example.
- [x] Preserve remote session state for opted-out clients: settings-only pushes/rollbacks keep valid remote session JSONL entries, preserve empty session-aware snapshots, avoid rescanning preserved remote sessions, and ignore session-only remote advances when settings hashes match; verified by `settings-only uploads preserve remote session files` and `settings hash maps ignore session differences for first sync checks` in `npm test`.
- [x] Update `extensions/pi-sync/README.md` to document `syncSessions`, `PI_SYNC_SESSIONS`, `PI_CODING_AGENT_DIR`, denylisted session paths, privacy risks, non-real-time behavior, conflict expectations, and the recovery path from `${PI_CODING_AGENT_DIR:-~/.pi/agent}/.pisync/backups/`; verified by README review and `rg -n "syncSessions|PI_SYNC_SESSIONS|PI_CODING_AGENT_DIR|sessions" extensions/pi-sync/README.md`.
- [x] Run package checks for the smallest affected surface and final PR verification; verified by `npm --workspace @narumitw/pi-sync run typecheck`, `npm --workspace @narumitw/pi-sync run check`, `npm test`, `npm test -- --workspace @narumitw/pi-sync`, `npm run check`, `npm run pack:sync`, and GitHub `Check and test` passing.
- [x] Address latest PR review feedback on configured session directories: external session roots preflight against the session root, incoming `settings.json` `sessionDir` decides the apply root unless CLI/env overrides it, nested configured session directories are not widened to `${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions`, `PI_CODING_AGENT_DIR` supports `~` and ignores empty values, `snapshotOptionsForContext` passes only snapshot fields, session apply preflight avoids the old current×remote nested scan, and startup session pulls warn that Pi has already selected the current session. Verified by `npm test -- --workspace @narumitw/pi-sync`, `npm run check`, and `npm run pack:sync` on 2026-06-19 after commit `26748e3`.

## Risks

- [x] Session files can contain secrets; mitigated with default-off config, secret scanning, command warnings, and README privacy docs.
- [x] Same session edited on two machines can still conflict; mitigated by existing remote-change checks, first-sync session conflict guards, live-session protection, and README snapshot/conflict docs.
- [x] Session trees can be large; mitigated by including only denylist-filtered `.jsonl`, avoiding unnecessary remote snapshot downloads when possible, and relying on gzip snapshots.

## Rollback / Recovery

- Disable with `syncSessions: false` or `PI_SYNC_SESSIONS=false`.
- Recover overwritten local session files from `${PI_CODING_AGENT_DIR:-~/.pi/agent}/.pisync/backups/<snapshot>.json.gz` or by pulling an older remote snapshot with `/pisync rollback <snapshot-id>`.
- If the feature regresses, revert the `syncSessions` collection/config changes; existing settings-only sync continues to read old snapshots because they omit session files.

## Completion Checklist

- [x] Session sync is opt-in and default-off, verified by config unit tests and `/pisync config` output test.
- [x] Only denylist-filtered `sessions/**/*.jsonl` is synced when enabled, verified by collection/filter tests and preflight rejection of non-JSONL session paths.
- [x] Pull and rollback protect local session data with backups, live-session protection, and preflight validation, verified by backup and preflight tests.
- [x] User-facing docs explain privacy, non-real-time behavior, conflicts, env/config settings, `PI_CODING_AGENT_DIR`, and recovery, verified in `extensions/pi-sync/README.md`.
- [x] The implementation passes the affected package checks, package dry run, and PR CI, verified by `npm --workspace @narumitw/pi-sync run typecheck`, `npm --workspace @narumitw/pi-sync run check`, `npm test`, `npm test -- --workspace @narumitw/pi-sync`, `npm run check`, `npm run pack:sync`, and GitHub `Check and test` passing.
