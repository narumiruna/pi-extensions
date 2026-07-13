## Goal

Harden PR #200's Codex reset-credit normalization against malformed optional backend/app-server collections while preserving strict handling of the required primary usage snapshot and the authoritative reset count.

## Context

The focused edge-case audit found two plausible boundary failures in `extensions/pi-codex-usage/src/normalize.ts`:

- A malformed entry inside optional `additional_rate_limits` or `rateLimitsByLimitId` can currently throw and discard otherwise valid primary/reset usage data.
- A non-empty app-server reset-credit detail array containing only malformed rows is normalized as `credits: []`, which incorrectly conflates unusable details with the protocol's meaningful “details fetched and no rows returned” state.

## Non-Goals

- Do not make the required primary rate-limit snapshot lenient; malformed primary data should continue to fail the source so query fallback/error reporting remains accurate.
- Do not add reset redemption or display individual reset-credit details.

## Plan

- [x] Add focused failing tests for malformed optional backend/app-server bucket entries and malformed-only reset-credit details; the initial focused run failed in all three identified cases.
- [x] Add non-throwing normalization only around optional additional buckets, preserving strict primary snapshot normalization; focused strictness and malformed-collection tests pass.
- [x] Preserve `credits: []` only for a truly empty detail array and omit `credits` when a non-empty detail array yields no valid rows; mixed arrays retain valid details capped by the authoritative count, without undefined optional properties.
- [x] Run package check, explicit changed-file Biome check, focused tests, boundary check, package dry-run, and the repository gate where possible; local scoped checks passed and both remote CI matrix jobs passed.
- [x] Audit the PR diff, update the archived plan with evidence, commit the hardening change, push PR #200, and verify CI/review state; commit `f127198` is pushed and both Pi 0.79.10/latest jobs passed.

## Risks

- Mitigated: validation failures are caught only for optional additional buckets; dedicated tests prove malformed required primary snapshots still throw.
- Mitigated: detail rows are optional, filtered, and capped to `availableCount`, which remains authoritative.

## Completion Checklist

- [x] Malformed optional bucket entries no longer discard valid primary/reset usage, proven by deterministic tests.
- [x] Empty and malformed-only reset-credit detail arrays retain distinct normalized meanings, proven by deterministic tests.
- [x] Existing direct/app-server normalization, formatter, lifecycle, and statusline tests remain green in the 17-test focused suite.
- [x] PR #200 contains hardening commit `f127198` with passing Pi 0.79.10/latest CI; unrelated `otel/` worktree content remains excluded.
