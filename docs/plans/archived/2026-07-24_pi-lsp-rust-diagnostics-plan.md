# pi-lsp Rust diagnostics plan

## Goal

Prevent pi-lsp from accepting rust-analyzer's premature empty pull-diagnostics response when the server publishes the real diagnostics shortly afterward, without hiding pull request failures or delaying unrelated servers unnecessarily.

## Context

rust-analyzer advertises pull diagnostics, can answer the first `textDocument/diagnostic` request with an empty list while workspace analysis is still running, and later publishes the actual syntax diagnostic. pi-lsp currently returns the early empty list immediately.

## Plan

- [x] Add a deterministic `LspClient` regression fixture where a pull-capable server returns an empty pull result and publishes a diagnostic later; focused compiled test failed with `actual: []` instead of the late fixture diagnostic.
- [x] Update the shared diagnostics path to give configured servers a bounded grace period for a late push after an empty pull while preserving existing non-empty publications, propagated pull errors, bounded empty fallback, timeout/cancellation cleanup, and push settling; focused compiled pi-lsp client tests pass (7/7).
- [x] Configure and document rust-analyzer's 5000 ms grace period, including config validation and adapter coverage; focused compiled pi-lsp tests pass (17/17), and `extensions/pi-lsp/README.md` documents the option and custom-config example.
- [x] Run formatting, the focused pi-lsp tests, the real rust-analyzer smoke against an intentional Rust syntax error, and the repository `npm run check` gate; the smoke reported the expected syntax error, package dry run included 13 files, and all 1,217 repository tests passed.

## Completion Checklist

- [x] The regression test proves late rust-analyzer-style diagnostics are returned instead of the premature empty pull result.
- [x] Existing pull-error, push-sequencing, batching, bounded fallback, and cleanup behavior remains covered and passing.
- [x] A real rust-analyzer smoke reports the intentional syntax error through pi-lsp's compiled runtime path.
- [x] The worktree contains only the intended pi-lsp, test, documentation, memory, and archived-plan changes.
