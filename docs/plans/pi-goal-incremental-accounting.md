# Pi Goal incremental token accounting

Status: proposal; implementation and verification are pending. This work targets
`csp256/pi-extensions:main`, not the upstream repository.

## Goal

Reduce per-tool bookkeeping latency in long sessions without changing token totals,
budget enforcement, goal-state persistence frequency, or model-visible context.

The installed implementation totals assistant usage by calling `getBranch()` and
scanning its result on every accounting update. A local benchmark using a temporary
copy of a roughly 60,000-entry session measured approximately 6.2 ms median for
accounting, persistence, and status formatting combined, versus 0.03 ms for
persistence alone. These are exploratory wall-time measurements, exclude actual UI
redraw, and are not historical event self-times or a repository performance gate.

## Applicable rules and verification

| Touched area | Applicable MUST rules | Named verification |
| --- | --- | --- |
| Accounting cache | Use public Pi APIs; scope session-owned resources by sessionManager; do not retain replaced sessions | Review of append-only entry contract and weak ownership; deterministic session/branch/reload tests |
| Lifecycle and persistence | Preserve branch reconstruction, canonical snapshots, and budget enforcement | Existing budget/recovery tests and generated runtime smoke; new accounting equivalence tests |
| Model context | Keep existing prompt, message, and tool-definition prefixes stable | Review: no context, prompt, or tool changes; existing cache-contract tests |
| Published behavior | Include a package-specific Changeset and deterministic tests | Patch Changeset review; repository `npm run check` and `npm test` |
| Performance evidence | Avoid host-dependent timing thresholds in deterministic tests | Count public API traversals; separate synthetic before/after benchmark |

Settings, UI, package metadata, dependencies, and runtime loading are unchanged.
The extension conventions and settings/persistence guide were read before coding.

## Proposed implementation

- Inspect the current checkout and Pi's public session APIs before choosing a cache
  design; do not depend on private SessionManager fields.
- Scope derived accounting caches by sessionManager identity, not UI identity.
- Cache cumulative assistant usage and process newly appended entries without
  rebuilding the entire active branch on ordinary tool completions.
- Preserve exact existing totals when revisiting branches, switching sessions,
  resuming, reloading, compacting, or replacing session data; use a correct full
  recount when the public APIs cannot establish cache validity.
- Preserve usage fallback rules, baseline subtraction, budget enforcement ordering,
  and append-time goal-state snapshots.
- Keep caches in memory and avoid persistent schema, settings, prompt, tool,
  dependency, and publication changes unless inspection demonstrates a need.
- Bound cache ownership and retention so optimization does not retain replaced
  sessions indefinitely.

## Required verification before marking the PR ready

- Compare cached totals with the existing full recount across ordinary appends,
  repeated reads, non-assistant entries, partial usage records, branch divergence,
  ancestor revisits, session replacement, reload/resume, and compaction.
- Verify budget enforcement and goal-state recovery remain unchanged.
- Verify warm updates inspect only newly relevant entries using deterministic
  traversal-count assertions, not wall-time thresholds.
- Benchmark cold and warm paths on synthetic long sessions and report before/after
  medians and tail latency without committing private session content.
- Read the applicable extension conventions and settings/persistence guidance;
  enumerate touched-area MUST rules and their verification methods before coding.
- Run the applicable package tests and runtime smoke, then repository
  `npm run check` and `npm test` separately; report skipped or blocked checks.
- Add a patch Changeset when implementing the published behavior change; this
  planning-only commit does not change published behavior.

## Current scope

This draft establishes the implementation plan only. It does not install or publish
an extension, modify the user's running Pi configuration, or claim an implemented
speedup. Keep the PR against our fork unless explicitly asked to propose it upstream.
