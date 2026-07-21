## Goal

Resolve issue #268 by adding a production `@narumitw/pi-usage` successor package that reports usage for the active runtime account across OpenAI Codex and OpenRouter, provides one interactive `/usage` menu plus `/codex-status` compatibility alias, preserves current-account-only statusline behavior, and ships with verified package/repository integration in a pull request.

## Context

OpenRouter is the validated second provider. Its official `GET https://openrouter.ai/api/v1/key` API accepts the same inference API key Pi resolves for the `openrouter` provider and returns meaningful per-key spend, limit, reset, and usage metrics. The account-level `/credits` API is excluded because it requires a separate management key. The existing `pi-codex-usage` package remains available during successor soak.

## Architecture

- Add a provider-neutral adapter/report contract with Codex and OpenRouter adapters.
- Resolve auth only through Pi's model registry and isolate in-memory cache entries with a process-salted credential fingerprint.
- Keep automatic statusline queries scoped to the selected model provider; cross-provider queries are explicit menu actions with bounded concurrency and partial results.
- Use `/usage` as the only primary command interface; retain `/codex-status` as an argument-free compatibility alias.

## Non-Goals

- Enumerating or switching accounts.
- Reading Pi, account-extension, Codex CLI, or provider credential files.
- Using OpenRouter management keys or claiming API-key limits are consumer subscription limits.
- Removing or deprecating `pi-codex-usage` during this change.

## Plan

- [x] Add failing executable specifications for provider normalization, auth/cache isolation, menu/query-all behavior, lifecycle/statusline behavior, and Codex regressions; `npm test` reached the expected red state on missing `pi-usage` source modules.
- [x] Implement the provider-neutral core plus Codex and OpenRouter adapters to satisfy normalization, formatting, timeout, cancellation, redaction, response-bound, and proxy-origin tests; 16 focused adapter/core tests pass.
- [x] Implement `/usage`, `/codex-status`, interactive current/configured/all-provider flows, bounded concurrency, cache identity, and current-only lifecycle statusline; 14 focused command/lifecycle race and cancellation tests pass.
- [x] Add package metadata, migration/provider-semantics documentation, root scripts/recipes/catalog entries, and the `usage` statusline icon; package/statusline typechecks and metadata tests pass.
- [x] Run formatting, the full repository check, package dry run, and a local Pi runtime smoke; `npm run check` passed 992 tests, `just pack usage` contained 11 expected publish files, and `pi -p -e ./extensions/pi-usage '/usage'` exited 0 without network/model work.
- [x] Audit issue #268 acceptance criteria, commit the focused diff, push `feat/pi-usage`, and create pull request #314 with issue linkage and verification evidence.

## Risks

- Runtime credentials can change without a dedicated auth-change event; re-resolve before commands, scheduled refreshes, and turns, then key cache/status publication by a process-salted fingerprint.
- Cross-provider calls could become background traffic; allow them only after explicit menu selection and never publish their results to statusline.
- Provider responses may include secrets or unstable fields; normalize allowlisted fields and redact exact resolved auth values plus token-shaped error text.

## Completion Checklist

- [x] Two provider adapters produce meaningful, semantically distinct usage reports, verified by deterministic Codex and OpenRouter tests.
- [x] `/usage` automatically displays the active provider/account and exposes explicit refresh/other/all/close actions, verified by menu tests.
- [x] Query-all is manual, concurrency-bounded, cancellation-aware, and retains partial success, verified by orchestration tests.
- [x] Statusline follows only the active provider/account and invalidates on model/auth change, verified by lifecycle tests.
- [x] No account switching or credential-file reads exist, verified by source audit and auth tests.
- [x] Documentation distinguishes Codex subscription windows from OpenRouter API-key spend limits and explains migration, verified by README inspection.
- [x] CI-equivalent checks and `just pack usage` pass, with expected package contents inspected.
- [x] Branch is committed and pushed, and pull request #314 exists with issue linkage and verification evidence.
