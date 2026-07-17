## Goal

Make a stored Codex account switch either leave Pi's `openai-codex` runtime auth usable or report a truthful failure, reproducing and fixing the latest-working-tree sequence where `home` is reported activated and Pi immediately reports no API key.

## Context

`just try-all` disables discovered extensions and explicitly loads `./extensions/pi-*`, so the report exercises the current source, not the older npm cache. Pi checks provider auth before `before_agent_start`, so a missing runtime override cannot be repaired by that hook after prompt submission.

## Plan

- [x] Reproduce the current extension against Pi 0.80.8's real `ModelRuntime` with isolated fake credentials and identify where runtime auth is lost; a real-runtime smoke showed `setRuntimeApiKey("openai-codex", ...)` records a runtime credential but the OAuth-only provider cannot resolve an `api_key` credential, leaving `hasConfiguredAuth` false and `getApiKeyForProvider` undefined.
- [x] Add a failing regression test for the confirmed login-cancel/account-switch sequence and usable-auth invariant; the focused test failed because no native-provider API-key bridge was registered (`0 !== 1`) before implementation.
- [x] Fix runtime-auth application and activation reporting at the shared boundary, then scan cancellation, account-switch, shutdown, reload, setup failure, and provider-overlay coexistence paths for the same state drift; 34 focused tests pass with one expected Pi 0.80.3 skip, and an isolated Pi 0.80.8 activation/default smoke passes.
- [x] Update concise documentation and repository memory with the OAuth-only runtime-key resolver requirement; diff inspection confirms no credentials or unrelated changes.
- [x] Run `npm run check` and inspect the package payload with `just pack-codex-accounts`; the 540-test suite reports 539 passed and one expected Pi 0.80.3 skip, and the dry-run includes all four source modules plus README, license, and metadata.

## Risks

- A mock-only test may miss Pi 0.80.8 runtime behavior, so the diagnosis needs one isolated real-runtime check.
- Reapplying runtime keys on every turn would trigger Pi model refresh/network work; prefer verification or cache invalidation over unconditional mutation.

## Completion Checklist

- [x] A stored valid account cannot produce a success notification while provider auth is absent, verified by `account activation reports an error when Pi cannot resolve the runtime credential` and the Pi 0.80.8 smoke.
- [x] Cancelled login leaves the prior account/runtime-auth state coherent, verified by cancellation-before-switch and already-active cancellation regression tests.
- [x] Pi 0.80.3 compatibility and the full repository gate pass via `npm run check` (539 passed, one expected skip on the version without public `ModelRuntime`).
- [x] The codex-accounts publish payload is complete, verified by `just pack-codex-accounts`, including `src/runtime-auth.ts`.
