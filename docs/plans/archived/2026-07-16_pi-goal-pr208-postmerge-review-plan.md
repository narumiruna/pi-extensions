## Goal

Resolve the final post-merge review thread on PR #208, verify retry ownership is granted only to actual Pi retry starts, and open a focused follow-up PR.

## Context

A lingering `goalRecovery` currently survives unrelated extension-originated input, allowing that turn to inherit the displaced goal while priority is pending.

## Plan

- [x] Add a focused regression where unrelated extension input arrives before an automatic retry; the focused queue suite showed the extension turn incorrectly received the recovering goal system prompt against merged `main`.
- [x] Clear stale recovery ownership at the extension-input boundary while preserving automatic retry behavior; all 43 focused queue tests and pi-goal typecheck pass.
- [x] Run the repository gate, runtime smoke, package dry run, explicit ignored-source Biome check, and diff validation; `npm run check` passed 501 tests, runtime smoke passed, and `just pack-goal` produced the expected 12-file package.
- [x] Commit and push the branch, open a follow-up PR referencing PR #208, reply to and resolve the late thread, and confirm final CI/thread state; commit `4e3944e` is pushed in PR #209, PR #208 has no unresolved threads, and both CI jobs pass.

## Risks

- Automatic Pi retries must continue to receive the displaced goal prompt and accounting.
- Extension-owned goal prompts must not lose legitimate state that their command path already established.

## Completion Checklist

- [x] The post-merge PR #208 finding has focused regression coverage; all 43 queue tests and pi-goal typecheck pass.
- [x] Repository, runtime, packaging, formatting, and diff checks pass with the evidence recorded above.
- [x] PR #209 is open with both Pi 0.79/latest jobs passing, and PR #208 has no unresolved threads.
