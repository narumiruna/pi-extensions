## Goal

Resolve GitHub issue #224 for the current `pi-codex-accounts` package by preventing repeated account-store access from crashing official Bun-based Pi standalone builds, while preserving cross-process lock guarantees and the already-released native-provider auth bridge. Success means repeated sync and async store access works in Pi standalone, the Node/Pi compatibility matrix remains green, and the fix is delivered in a PR linked to the issue.

## Context

The failure is reproducible without credentials: on official Pi standalone 0.80.9 and 0.80.10, the first `CodexAccountStore.readAsync()` succeeds and the second throws the reported Proxy invariant from `proper-lockfile/lib/mtime-precision.js`. The same error was confirmed on macOS arm64 and Linux arm64, so it is not specific to credential contents or stale lock directories.

`proper-lockfile` caches filesystem mtime precision by defining a non-configurable symbol on its `fs` object. In standalone, its default `graceful-fs` object is loader-proxied; the second symbol read violates the Proxy invariant. A spike confirmed that passing one stable, plain adapter containing the required Node callback and sync filesystem methods through `proper-lockfile`'s supported `fs` option allows repeated async and sync locks under standalone 0.80.10.

The second issue report—an `api_key` credential remaining unresolved by Pi's OAuth-only `openai-codex` provider—was fixed after 0.17.0 by the `RuntimeApiKeyBridge` now present in 0.17.1. This change should verify that behavior but not redesign it.

## Architecture

Keep `proper-lockfile` and its existing retry, stale-lock, compromised-lock, and `.lock` directory semantics. In `extensions/pi-codex-accounts/src/storage.ts`, create one module-scoped plain filesystem adapter from Node's `mkdir`, `realpath`, `rmdir`, `stat`, and `utimes` callback/sync APIs, then pass that same adapter to both `lockfile.lock()` and `lockfile.lockSync()`. The precision cache will live on the plain adapter instead of Bun's proxied module object.

Do not patch `node_modules`, monkey-patch `graceful-fs`, or replace the locking algorithm. The adapter must include sync methods because `proper-lockfile` derives its sync implementation from them and uses `rmdirSync` for exit cleanup.

## Non-Goals

- Do not change account JSON format, migration behavior, permissions, retry timing, or lock paths.
- Do not rework the 0.17.1 runtime provider bridge or OAuth flow.
- Do not require real Codex credentials or network authentication in tests.
- Do not add a permanent standalone binary download to the normal test suite.

## Plan

- [x] Add a deterministic regression test in `extensions/pi-codex-accounts/test/codex-accounts-storage.test.ts` for a stable plain lockfile filesystem adapter: the red phase failed with TS2305 because the expected adapter did not exist; the green test now exercises two async and two sync lock cycles from a Bun-like proxied source.
- [x] Update `extensions/pi-codex-accounts/src/storage.ts` to construct one module-scoped plain adapter with every callback/sync method required by `proper-lockfile`, and supply it in the `fs` option to both async and sync acquisition paths; focused storage tests pass without changing retries, stale timing, release handling, or compromised-lock propagation.
- [x] Scan adjacent storage behavior for regressions by exercising repeated `CodexAccountStore.readAsync()` and `read()`, writes, private permissions, migration, and cross-process lock contention; the focused storage suite passes 10/10 and the full root suite passes.
- [x] Run isolated official-standalone smokes with temporary agent directories and no credentials; Pi 0.80.9 macOS arm64, Pi 0.80.10 macOS arm64, and Pi 0.80.10 Linux arm64 each complete two async and two sync store reads without the Proxy error.
- [x] Verify the prior OAuth-only-provider fix through an isolated latest-Pi runtime in CI, run `TMPDIR="$(realpath "${TMPDIR:-/tmp}")" npm run check`, and inspect publish contents with `just pack-codex-accounts`; local checks pass and latest-Pi CI runs the real bridge test without a skip.
- [x] Review the final diff for credential leakage, generated files, and unrelated changes, then create a focused PR with `Fixes #224`; PR #229 is open, mergeable, and CI run 29559534122 passes all three jobs.

## Risks

- Mitigated: one stable module-scoped adapter retains `proper-lockfile`'s precision cache across lock calls.
- Mitigated: the adapter includes the complete callback/sync method set used by `proper-lockfile`, and both lock modes pass focused tests and standalone smokes.
- Mitigated: deterministic Node regression coverage is paired with real Bun standalone smokes on macOS and Linux.
- Accepted: the current ARM machine cannot execute the Linux x64 standalone because its Bun build requires AVX; the same pre-fix failure and post-fix success on Linux arm64 and macOS arm64 demonstrate the architecture-neutral loader boundary, while GitHub's Linux x64 jobs guard package integration.

## Completion Checklist

- [x] Repeated async and sync account-store access no longer reaches Bun's proxied `graceful-fs`, verified by `plain lockfile fs adapter survives repeated probes from a Bun-like source proxy`, `file store supports repeated async and sync access`, and both `fs: LOCKFILE_FS_ADAPTER` call sites in `storage.ts`.
- [x] Official standalone Pi 0.80.10 completes two async and two sync isolated store reads without the Proxy invariant, verified by exit code 0 on macOS arm64 and Linux arm64; Pi 0.80.9 macOS arm64 also passes.
- [x] Existing permissions, migration, contention, retry, release, and compromised-lock behavior remains passing, verified by the 10/10 focused storage suite and `TMPDIR="$(realpath "${TMPDIR:-/tmp}")" npm run check` (543 passed, 1 expected skip with the pinned local Pi).
- [x] Stored Codex runtime keys remain resolvable through the native-provider bridge, verified by the non-skipped real `ModelRuntime` test in latest-Pi CI job 87818831006 (544 passed, 0 skipped).
- [x] The npm payload still contains all required source and runtime dependencies, verified by `just pack-codex-accounts` listing seven expected package files including `src/storage.ts` and the unchanged `proper-lockfile` runtime dependency in `package.json`.
- [x] PR #229 links `Fixes #224`, is open and mergeable, and is green across Pi 0.79.10, 0.80.3, and latest in CI run 29559534122.
