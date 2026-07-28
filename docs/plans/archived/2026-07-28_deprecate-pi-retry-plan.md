## Goal

Deprecate `@narumitw/pi-retry` in favor of Pi's built-in provider retry and timeout behavior, preserving its source under `deprecated/` while removing it from active workspace checks, version bumps, root loading, and publishing.

## Context

The repository targets Pi 0.82.1. Pi now owns bounded retry/backoff, recognizes explicit provider retry guidance, reconnects a Codex websocket connection limit before a stream starts, and applies configurable HTTP/provider/websocket idle timeouts. The remaining extension-specific classification is narrow, while its 90-second watchdog can abort long silent provider work earlier than Pi's default timeout.

## Non-Goals

- Delete historical source or already-published npm versions.
- Change Pi core, `pi-goal`, or legacy `pi-statusline` compatibility mappings.
- Add a replacement extension.

## Plan

- [x] Move `extensions/pi-retry` to `deprecated/pi-retry`, update its README warning, local paths, package description, and repository metadata, and preserve implementation/test files unchanged apart from path-facing documentation; SHA-256 comparison confirms every source and test file is byte-for-byte unchanged.
- [x] Remove `pi-retry` from active root documentation, agent command guidance, npm scripts, and Just pack/try/install/publish recipes; targeted searches find no stale active path, root install recommendation, or recipe.
- [x] Regenerate `package-lock.json` so `pi-retry` is no longer a workspace/link, then verify workspace, version-bump, boundary, test, and publish discovery exclude it; the prior repository-pinned npm 11.16.0 produced the bounded 41-line lock removal and its clean-install dry run accepts the result, while npm 12.0.1 is unsupported by the current Node 25 runtime and its attempted regeneration was discarded because it rewrote thousands of unrelated lines.
- [x] Run the CI-equivalent `npm run check`, a deprecated-package pack dry run, `git diff --check`, and a final extension-conventions touched-area audit; all checks pass, including 1,763 tests, 21 active-extension boundaries, and the five-file archived package preview.
- [x] Apply npm registry deprecation metadata with an actionable Pi-core migration message if current npm authentication permits it; npm accepted the authenticated account but rejected the write with `EOTP`, and direct registry inspection confirms 0 of 65 published versions changed, so `npm deprecate '@narumitw/pi-retry@*' '<documented migration message>' --otp=<code>` remains the exact external follow-up.

## Risks

- A stale workspace link or root recipe could continue loading or publishing an unsupported package.
- Removing the extension changes direct Git installs by dropping the aggressive 90-second watchdog; Pi's built-in timeout remains the supported recovery path.
- Registry deprecation may require an npm OTP unavailable to this session.

## Completion Checklist

- [x] `pi-retry` exists only under `deprecated/` and clearly identifies Pi core as its replacement.
- [x] Active workspace, development recipe, version-bump, test, root-load, and publish discovery no longer include `pi-retry`.
- [x] Lockfile and repository documentation contain no stale active `pi-retry` path or install recommendation.
- [x] Required checks and package smoke pass, with the OTP-protected registry follow-up recorded.
