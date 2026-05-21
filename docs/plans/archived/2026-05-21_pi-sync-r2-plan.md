## Goal

Implement a new `@narumitw/pi-sync` Pi extension that syncs selected Pi configuration files through Cloudflare R2 / S3-compatible storage using conservative snapshot bundles, local locking, secret scanning, backups, and explicit user commands.

## Architecture

The extension will expose `/pisync` subcommands. Local state and lock files live under `~/.pi/agent/.pisync/`. Remote storage uses immutable gzip-compressed JSON snapshot bundles under a profile prefix plus a `latest.json` pointer. Apply operations create local backups before writing files.

## Non-Goals

- Do not implement Git sync in this phase.
- Do not auto-apply remote changes on startup.
- Do not sync sessions, auth tokens, npm caches, or `node_modules`.

## Plan

- [x] Add a new `extensions/pi-sync` workspace package with package metadata, TypeScript config, license, README, and Pi extension entry; verified by files under `extensions/pi-sync/` and `package.json` `pi.extensions`.
- [x] Implement R2/S3 configuration loading from environment variables and `~/.pi/agent/pi-sync.local.json`; verified by `src/sync.ts` `/pisync config` implementation redacting credentials.
- [x] Implement allowlisted file collection from `~/.pi/agent`, denylisted path filtering, SHA-256 hashing, and secret scanning; verified by `npm run check`.
- [x] Implement gzip JSON snapshot bundle creation and extraction plus remote `latest.json` pointer operations using AWS Signature V4 over `fetch`; verified by `npm run check`.
- [x] Implement local exclusive lock, local state, backup, diff, push, pull, sync, history, rollback, and doctor commands; verified by command handler code in `extensions/pi-sync/src/sync.ts` and `npm run check`.
- [x] Wire the new package into root README, package scripts, and just recipes; verified by `README.md`, `package.json`, `justfile`, and `package-lock.json` changes.
- [x] Run formatting, typechecking, repository checks, and package dry-run; verified by `npm run check` and `npm --workspace @narumitw/pi-sync pack --dry-run`.

## Risks

- S3 conditional writes vary across compatible providers; the first version should still re-read remote state before writing and fail safely on unexpected responses.
- JSON gzip bundles are less manually inspectable than a file tree; README must document export/recovery behavior clearly.
- Secret scanning can only catch common patterns; allowlist and denylist remain the primary protection.

## Rollback / Recovery

- Pull and rollback must create timestamped backups under `~/.pi/agent/.pisync/backups/` before applying remote files.
- Remote snapshots are immutable; rollback updates `latest.json` to an older snapshot rather than deleting data.
- If a command fails while the lock is held, stale lock recovery is available through `/pisync unlock --stale`.

## Completion Checklist

- [x] `@narumitw/pi-sync` is implemented and exposed by package metadata, verified by `npm --workspace @narumitw/pi-sync run typecheck` passing during `npm run check`.
- [x] Repository metadata includes pi-sync, verified by root README, root `package.json`, `package-lock.json`, `AGENTS.md`, and `justfile` entries.
- [x] Repository quality gates pass, verified by `npm run check`.
- [x] Package contents are correct, verified by `npm --workspace @narumitw/pi-sync pack --dry-run` showing `LICENSE`, `README.md`, `package.json`, and `src/sync.ts`.
