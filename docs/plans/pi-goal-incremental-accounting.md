# Pi Goal incremental token accounting

Status: implemented. See the
[benchmark and verification report](../benchmarks/pi-goal-incremental-accounting.md).

## Goal

Reduce per-tool bookkeeping latency in long sessions without changing token totals,
budget enforcement, goal-state persistence frequency, or model-visible context.

## Implementation

`packages/pi-goal/src/accounting.ts` retains one checkpoint per sessionManager:
the latest processed leaf object and its cumulative assistant token total. A weak
map releases that checkpoint when its manager is discarded. Retained cache state
is constant per manager, not proportional to session history.

Pi's public session API specifies append-only entries. Ordinary reads use public
`getLeafId()` and `getEntry()` APIs to walk backward only to the previous checkpoint,
then sum new entries root-to-leaf. Unchanged reads need one entry lookup. If the
checkpoint is not an ancestor of the new leaf, the branch is recounted and the
checkpoint is replaced. Historical prefixes are not cached for branch revisits.

Reloaded or replaced entry objects cannot match a checkpoint merely by reusing IDs.
Missing or empty leaves clear it. Session replacement, compaction, branch summaries,
and forks preserve the full-recount result. The checkpoint retains at most one
entry object; it does not retain an array or map of historical entries.

Branch-only contexts retain the original full-recount behavior. Usage fallback,
rounding, safe-integer saturation, baseline subtraction, budget enforcement, and
append-time goal-state snapshots remain unchanged. There are no new settings,
persistent schemas, dependencies, asynchronous tasks, or model-visible messages.

Cold reads and branch recounts remain linear in branch length. The temporary
root-to-leaf work array is proportional to the traversed entries and is released
after the call; it is not retained cache memory.

## Applicable rules and verification

| Touched area | Applicable MUST rules | Named verification |
| --- | --- | --- |
| Accounting cache | Use public Pi APIs; scope session-owned resources by sessionManager; release replaced session state | Review of append-only entry contract and weak ownership; deterministic session/branch/reload tests |
| Lifecycle and persistence | Preserve branch reconstruction, canonical snapshots, and budget enforcement | Existing budget/recovery tests and runtime smoke; accounting equivalence tests |
| Model context | Keep existing prompt, message, and tool-definition prefixes stable | Review: no context, prompt, or tool changes; existing cache-contract tests |
| Published behavior | Include a package-specific Changeset and deterministic tests | Patch Changeset; repository checks and affected-test gate attempted separately |
| Performance evidence | Avoid host-dependent timing thresholds in deterministic tests | Public API traversal counts; separate timing and retained-memory benchmarks |

The extension conventions apply to this accounting-only change. Settings and
persistence implementations, runtime-loading behavior, package metadata, and UI
remain unchanged. The existing generated-entry tests, loader smoke, and Goal runtime
smoke exercise the rebuilt extension.

## Correctness coverage

Accounting tests compare against the unchanged full recount for usage fallbacks,
malformed values, floating-point addition, saturation, zero totals, repeated reads,
and mixed appends. They cover 2,000 deterministic mixed branch operations, divergent
and ancestor branches, shared headless UI, missing entries, session replacement,
same-file reload with reused IDs, resume, compaction, branch summaries, fork label
re-chaining, and session resets.

A 60,000-entry test requires 60,000 lookups cold, one for an unchanged read, and
three after two new entries. A separate test proves old prefixes are not reused:
branch changes recount, then subsequent appends use the new checkpoint. A
lifecycle test verifies baselines, repeated snapshots, and immediate budget limiting.

## Release and remaining work

A patch Changeset records the published performance change. The PR contains source,
tests, and reproducible benchmarks. The checkout is configured for local Pi testing;
existing runtimes need `/reload` after the package is rebuilt.

The full GitHub Actions gate passed on Linux with the pinned Node/npm toolchain:
20,761 tests passed, with unchanged platform/conditional skips. Verification details
and the remaining local macOS native-watcher limitation are in the linked report.
No timeouts were raised or root tests changed to obtain the passing gate. No
package is published.
