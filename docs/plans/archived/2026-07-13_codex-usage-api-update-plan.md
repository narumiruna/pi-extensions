## Goal

Research the current Codex rate-limit usage contracts and update `pi-codex-usage` so its direct Pi-auth and Codex app-server paths preserve and display newly exposed usage data without regressing older payloads.

## Context

- Current upstream evidence is `third_party/codex` at `2f7d89b1419bf7064346855b0acde23514b1ebc5` (2026-07-13), plus the current Codex app-server documentation resolved through Context7.
- The `/wham/usage` URL and existing rate-limit fields remain compatible.
- Since the extension's original May implementation, Codex added `rate_limit_reset_credits.available_count` to the backend usage response (`bef99f86`, 2026-06-15), exposed it as `rateLimitResetCredits` from `account/rateLimits/read`, and added optional reset-credit detail rows (`58ec5283`, 2026-07-06).

## Non-Goals

- Do not add reset-credit redemption; Codex requires a separate idempotent consume flow and a post-consume refetch.
- Do not add the separate `account/usage/read` token-activity report to this rate-limit status command.

## Plan

- [x] Compare `pi-codex-usage` direct/backend and app-server schemas with current `third_party/codex` and current Codex docs; verify changes through upstream source, generated protocol types, tests, and commit history.
- [x] Add failing normalization and formatting tests for snake_case backend reset-credit summaries, camelCase app-server summaries/details, and reset-credit-only responses; verify the initial red state with `npm test` type errors for the missing contract.
- [x] Extend `extensions/pi-codex-usage/src/types.ts` and `src/normalize.ts` to normalize the new fields while tolerating absent or malformed optional reset-credit metadata; verified by 13 focused passing tests.
- [x] Update `extensions/pi-codex-usage/src/format.ts` and public exports so `/codex-status` reports available usage-limit resets without expanding the compact statusline; verified by formatter assertions and package typecheck.
- [x] Update `extensions/pi-codex-usage/README.md` to document the upstream API change and visible behavior; examples and limitations now match implementation.
- [x] Run package formatting/typechecking, focused tests, the repository CI-equivalent gate when possible, and the `just pack-codex-usage` dry run; package checks, focused tests, boundaries, and pack passed. The full gate is blocked by unrelated `pi-goal`/`pi-plan-mode` type errors and a concurrently created untracked `otel/` worktree with a nested Biome root.
- [x] Audit the final diff against this plan, then archive this completed plan under `docs/plans/archived/`; tracked edits are limited to `pi-codex-usage`, this plan, and the requested durable memory preference.

## Risks

- Mitigated: optional reset-credit detail data can be absent, capped, or malformed; normalization treats `availableCount` as authoritative, skips unusable detail rows, and accepts count-only reports.
- Accepted: the direct Pi-auth path sees the summary embedded in `/wham/usage`, while detailed rows are currently supplied by the app-server's additional lookup; the command intentionally displays the authoritative count only.
- Accepted baseline: repository-wide tests expose unrelated Pi dependency compatibility errors in `pi-goal` and `pi-plan-mode`; focused compilation and tests prove this package's behavior.

## Completion Checklist

- [x] Direct `/wham/usage` reset-credit summaries and app-server `rateLimitResetCredits` responses are covered by 13 passing deterministic focused tests.
- [x] `/codex-status` displays the authoritative available reset count, while existing model-specific statusline output remains unchanged, as verified by formatter tests.
- [x] Package typecheck, explicit formatting/lint, focused tests, boundary check, and `just pack-codex-usage` pass; repository-wide baseline failures are recorded above.
- [x] README claims match the implemented query, fallback, cache, and reset-credit behavior.
- [x] Intended tracked paths are limited to `pi-codex-usage`, this archived plan, and `MEMORY.md`; `git status --short` separately shows the concurrent untracked `otel/` worktree, which was not modified.
