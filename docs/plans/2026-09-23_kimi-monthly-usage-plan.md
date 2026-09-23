# Kimi monthly usage plan

## Goal

Display ratio-only Kimi monthly plan quota in `/usage` and the statusline without changing count-based windows or guessing missing wallet values.

## Context

Issue #1390 is open without comments or labels. A local reproduction using its redacted `limits` and `usages` fields produced only `kimi 56% 5h`; a `usages`-only payload threw. A synthetic top-level `booster_wallet` with otherwise valid wallet fields yielded no metrics. The authenticated GET cannot be attempted without an account credential. The pinned older Kimi contract documents only count-based rows, so the reported live shape is the evidence for the new map.

## Plan

- [x] Add sanitized regression cases in `packages/pi-usage/test/kimi-coding.test.ts` for mixed, ratio-only, weekly, duplicate, malformed, and snake-case wallet inputs; show that changed assertions fail before implementation. `vitest run packages/pi-usage/test/kimi-coding.test.ts`: 5 new cases fail, 12 old cases pass.
- [x] Parse recognized `usages` ratios and resets in `packages/pi-usage/src/providers/kimi-coding.ts`, preferring existing count-based windows and retaining duplicate-window safety; accept `booster_wallet` as a top-level alias without weakening nested wallet validation.
- [x] Format percentage buckets distinctly and include the monthly bucket in the Kimi statusline in `packages/pi-usage/src/format.ts` while preserving existing count-only outputs. Focused Kimi tests pass (18/18), including complementary percentage rounding at half-percent boundaries (review thread #4079186725).
- [x] Describe supported shapes, precedence, limits, and examples in `packages/pi-usage/docs/providers.md`; add a patch Changeset for `@narumitw/pi-usage`.
- [ ] Run focused tests, `npm run check`, and `npm test`; build and non-interactively smoke-load the packaged runtime where practical, inspect a pack dry run, and audit the final diff and acceptance criteria. Focused `pi-usage` tests: 269/269 passed; `npm run check` passed; package-directory Pi Jiti loader registered `/usage` without errors; pack dry run included `dist/index.ts` and provider docs; `git diff --check` passed. `npm test` did not pass: one unchanged `packages/pi-subagents/test/process.test.ts` test timed out in the full run (5613 passed, 1 failed) and in an isolated rerun (16 passed, 1 failed).

## Risks

The issue's wallet payload is redacted and the ratio fields are not in the pinned older first-party contract. Reject malformed or unfamiliar values rather than inferring them, and record that live-account behavior remains unverified without credentials. Preserve duplicate count-based windows as unavailable; do not silently replace them with ratio data.

## Applicable conventions and verification

- `docs/extension-conventions.md`: changed behavior needs deterministic tests (`Test`); published behavior needs an independent Changeset (`Review`); run `npm run check` (`Validator`) and `npm test` (`Test`); inspect package contents and a Pi load (`Smoke`) for generated runtime and published content. Review touched-area checklist for every changed path.
- `docs/readme-conventions.md`: no README change is planned; preserve README claims and compare provider-reference statements against implementation (`Review`). If README changes, run its heading and scope checklist.
- `docs/extension-settings.md`: no settings changes are planned; no settings-specific verification applies.

## Completion Checklist

- [x] New tests fail against the original behavior and pass after the fix, including existing count and wallet tests (5 original failures plus the review regression before its fix; 269/269 package tests after).
- [x] The supplied mixed input produces a five-hour count and one monthly percent bucket, a monthly detail line, and both windows in the statusline (fixture assertions pass).
- [x] Ratio-only and malformed/duplicate inputs have deterministic, conservative behavior; existing response shapes keep their prior output (focused tests and diff audit).
- [ ] `npm run check` and `npm test` pass; pack and Pi smoke results or blockers are recorded. `npm run check`, pack dry run, and Jiti load passed; `npm test` failed only on the unchanged pi-subagents stdin-write timeout reproduced in isolation. No live Kimi-account smoke was attempted without credentials.
- [x] Final diff contains only the approved behavior, tests, documentation, and Changeset; all limitations are disclosed.
