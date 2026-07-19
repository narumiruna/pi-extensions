## Goal

Make `@narumitw/pi-retry` detect when Pi's effective agent-level retry policy is disabled, warn without changing that policy, and avoid claiming or attempting retry-dependent recovery while `retry.enabled` is false.

## Context

Pi 0.80.10 classifies `WebSocket error` as retryable, but `AgentSession._prepareRetry()` returns `false` before emitting `auto_retry_start` when `retry.enabled` is false. `pi-retry` currently has no policy check: it emits no startup warning, can show `retrying`, and can abort a stalled request even though Pi will not continue it.

The current `ExtensionContext` does not expose the active session's `SettingsManager`. For the current Pi API, the extension can read the same global/project settings through the public `SettingsManager.create()` API, using `ctx.cwd`, `getAgentDir()`, and `ctx.isProjectTrusted()`. This covers normal Pi CLI sessions but cannot observe SDK-only in-memory overrides; exact support for those requires Pi to expose the active retry policy through `ExtensionContext`.

## Non-Goals

- Do not enable `retry.enabled` automatically.
- Do not replace Pi's retry budget, backoff, or retry loop.
- Do not add a separate pi-retry setting that duplicates Pi's policy.

## Plan

- [x] Add focused failing tests in `extensions/pi-retry/test/retry.test.ts` for a disabled policy: `session_start` warns once with the exact `retry.enabled: true` remedy, a matched error does not set `retrying`, and the stall watchdog does not arm or abort; verified all three failed against the original source with focused compiled Node tests.
- [x] Add a small retry-policy reader in `extensions/pi-retry/src/retry.ts` using `SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() })`, surface settings-load failures without silently treating a known disabled policy as enabled, and make the reader injectable for deterministic unit tests; focused tests verify defaults, global disablement, trusted project overrides, malformed settings, and injected failures.
- [x] Refresh the cached policy during `session_start` and before each provider request, warn once per loaded extension runtime when disabled, and clear/disarm retry-dependent state when policy becomes disabled; focused tests verify warning deduplication and a disabled-to-enabled change on the next request.
- [x] Gate retry-only UI and watchdog behavior on the cached policy: keep classification logic side-effect-free when disabled, never show `retrying`, and never abort a stalled stream that Pi cannot retry; focused tests verify disabled suppression while existing hint tests and the enabled watchdog case pass.
- [x] Update `extensions/pi-retry/README.md` to state that Pi owns retry attempts, budget, and backoff; documented the required `retry.enabled: true` setting, disabled-watchdog behavior, and current SDK in-memory visibility limitation.
- [x] Run `npm run check` and `just pack-retry`, then inspect the tarball to confirm the changed source and README are included without unrelated files; reverified 808 passing tests and the four expected package files after the malformed-settings policy fix.
- [x] Open an upstream Pi API follow-up requesting an effective `ctx.getRetrySettings()` or `ctx.isAutoRetryEnabled()` accessor so SDK in-memory overrides and live runtime changes can be observed without rereading settings files; created https://github.com/earendil-works/pi/issues/6830 (auto-closed by the new-contributor gate pending maintainer review).

## Risks

- A separately created `SettingsManager` cannot see SDK-only in-memory overrides or unpersisted runtime overrides. The package should document this temporary limitation and prefer an upstream context accessor once available.
- Reading settings at every stream event would add unnecessary synchronous I/O. Refresh only at session start and provider-request boundaries.
- Disabling the watchdog when retries are disabled leaves a genuinely stalled request for the user to abort manually, but this is safer than aborting while falsely promising automatic recovery.

## Completion Checklist

- [x] Disabled `retry.enabled` produces exactly one actionable warning, verified by focused lifecycle tests and the full 808-test suite.
- [x] Disabled `retry.enabled` produces no `retrying` status and no watchdog abort, verified by matched-error and timer tests.
- [x] Enabled/default behavior remains compatible, verified by the focused suite and all 808 tests in `npm run check` after the malformed-settings policy fix.
- [x] Policy ownership and configuration are documented in `extensions/pi-retry/README.md`, verified by review of the Install and What it does sections.
- [x] Repository checks and package dry run pass, reverified with `npm run check` and `just pack-retry` after the latest source change.
- [x] The remaining SDK/in-memory policy visibility gap is tracked by https://github.com/earendil-works/pi/issues/6830.
