# Pi Goal incremental token accounting

Status: implemented in the fork. Goal tests and runtime verification pass; the
broader repository test gate is not green on this host. See the
[benchmark and verification report](../benchmarks/pi-goal-incremental-accounting.md).
This work targets `csp256/pi-extensions:main`, not upstream.

## Goal

Reduce per-tool bookkeeping latency in long sessions without changing token totals,
budget enforcement, goal-state persistence frequency, or model-visible context.

The previous accounting path calls `getBranch()` and scans its result on every
update. An exploratory benchmark of a temporary copy of a roughly 60,000-entry
session measured approximately 6.2 ms median for accounting, persistence, and status
formatting combined, versus 0.03 ms for persistence alone. Those measurements exclude
actual UI redraw and are not historical event self-times.

## Implementation

`packages/pi-goal/src/accounting.ts` now caches cumulative assistant token totals
at each visited entry. A weak map scopes totals by sessionManager; another weak map
keys each prefix by entry object identity. Ordinary reads walk backward through
public `getLeafId()` and `getEntry()` APIs only until reaching a cached prefix,
then total new entries root-to-leaf.

Pi's public session API specifies append-only entries. Branch changes reuse cached
shared prefixes. Reloaded or replaced entry objects trigger a recount even when
session IDs and entry IDs are unchanged. Session replacement, empty leaves,
compaction, branch summaries, and forked trees preserve the full-recount result.
Weak ownership does not retain replaced managers or entry trees.

Branch-only contexts retain the original full-recount behavior. Usage fallback,
rounding, safe-integer saturation, baseline subtraction, budget enforcement, and
append-time goal-state snapshots remain unchanged. There are no new settings,
persistent schemas, dependencies, asynchronous tasks, or model-visible messages.

The first read still visits the complete uncached branch and now pays a one-time
cache-population cost. Memory grows with visited entries still owned by the session;
the improvement is amortized steady-state accounting, not faster cold startup.

## Applicable rules and verification

| Touched area | Applicable MUST rules | Named verification |
| --- | --- | --- |
| Accounting cache | Use public Pi APIs; scope session-owned resources by sessionManager; do not retain replaced sessions | Review of append-only entry contract and weak ownership; deterministic session/branch/reload tests |
| Lifecycle and persistence | Preserve branch reconstruction, canonical snapshots, and budget enforcement | Existing budget/recovery tests and runtime smoke; accounting equivalence tests |
| Model context | Keep existing prompt, message, and tool-definition prefixes stable | Review: no context, prompt, or tool changes; existing cache-contract tests |
| Published behavior | Include a package-specific Changeset and deterministic tests | Patch Changeset; repository checks and affected-test gate attempted separately |
| Performance evidence | Avoid host-dependent timing thresholds in deterministic tests | Public API traversal counts; separate synthetic before/after benchmark |

The extension conventions and settings/persistence guide were read before coding.
No package metadata or runtime-loading behavior changed, so packaging/loading-specific
smokes were not added. The existing generated-entry tests and Goal runtime smoke
exercise registration and lifecycle behavior.

## Correctness coverage

The new accounting tests compare against the unchanged full recount for usage
fallbacks, malformed usage values, floating-point addition, saturation, zero totals,
repeated reads, and mixed appends. They cover 2,000 deterministic mixed branch
operations, divergent and ancestor branches, shared headless UI, missing entries,
session replacement, same-file reload with reused IDs, resume, compaction, branch
summaries, label re-chaining during forks, and session resets.

A 60,000-entry deterministic test requires 60,000 lookups for the cold read, one for
a repeated read, and three after two new entries. A tool-completion lifecycle test
verifies unchanged baselines, repeated goal snapshots, and immediate budget limiting.

## Release and remaining work

A patch Changeset records the published performance change. The PR contains actual
source, tests, and a reproducible synthetic benchmark, not only this plan.

The broader root gate still needs a clean run using the repository's pinned Node
and compatible npm/platform facilities; failures and retries are recorded in the
linked report. No timeouts were raised or root tests bypassed to claim a green gate.
No extension was installed or published, and the running Pi configuration is
unchanged. Keep the PR against our fork unless explicitly asked to propose it upstream.
