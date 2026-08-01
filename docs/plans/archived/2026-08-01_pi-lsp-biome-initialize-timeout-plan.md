# pi-lsp Biome initialize-timeout fix

## Goal

Prevent timed-out or cancelled `biome lsp-proxy` runs from leaving Biome daemon descendants that can make later `initialize` requests time out.

## Context

`LspClient` currently signals only the immediate LSP process. Biome's proxy starts a daemon, so interruption during initialization can orphan that daemon. Repeated orphaned scans can exhaust or block later Biome startup.

## Plan

- [x] Add deterministic `LspClient` timeout and cancellation regressions whose fixture starts a detached descendant like Biome's daemon; verified the process-group-only implementation fails with `Timed out waiting for process … to exit`.
- [x] Update `extensions/pi-lsp/src/lsp-client.ts` to perform bounded POSIX descendant discovery before termination, signal detached descendants plus the owned process group, escalate stalled cleanup, and retain Windows `taskkill` tree termination without adding a runtime dependency; both regressions and all 12 `lsp-client` tests pass.
- [x] Audit timeout, abort, normal shutdown, unexpected exit, POSIX, and Windows cleanup paths for the same failure class. Timeout/cancellation discover descendants while the proxy is alive; normal shutdown still uses LSP shutdown/exit plus best-effort tree cleanup; a proxy that exits before discovery can only receive best-effort cleanup. Windows behavior is covered by the existing `taskkill /t /f` path and code review but cannot be executed on this Linux host. No user workflow changed, so README changes are not needed.
- [x] Run focused pi-lsp tests, a forced-timeout and normal `lsp_diagnostics` Biome smoke, the pi-lsp pack dry run, and the repository CI-equivalent `npm run check`; all passed, including 1,998 root tests in a normal clone.

## Completion Checklist

- [x] The regression test fails before and passes after the fix for the intended descendant-leak reason. Stronger red evidence: `Timed out waiting for process … to exit` after process-group-only cleanup; green evidence: timeout and cancellation descendant tests pass with PID-liveness polling.
- [x] No owned LSP proxy or descendant remains after timeout/cancellation cleanup in the tested POSIX path.
- [x] Applicable extension-convention MUST rules and asynchronous lifecycle paths are audited: per-tool process startup, timeout, abort, failure, normal shutdown, and bounded cleanup were reviewed.
- [x] Required verification passes. Windows `taskkill /t /f` cleanup is code-reviewed but not runtime-tested on this Linux host; unexpected proxy exit after descendants are already reparented remains best-effort.
