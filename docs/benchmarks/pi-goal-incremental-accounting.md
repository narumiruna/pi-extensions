# Pi Goal incremental accounting

The optimization replaces repeated full-branch token recounts with one checkpoint per
sessionManager: the last processed leaf object and its cumulative assistant token
total. Normal tool completions process new entries and that checkpoint, not the
full history. Divergent branches and reloads recount safely. Retained cache state
is constant per manager; historical prefixes are not cached.

Goal-state snapshots are persisted at the same boundaries. Settings, model context,
accounting semantics, and budget enforcement are unchanged.

## Reproduction

Run from the repository root after installing dependencies:

```sh
node packages/pi-goal/benchmark/token-accounting.mjs
node --expose-gc packages/pi-goal/benchmark/cache-memory.mjs 10000 110
node --expose-gc packages/pi-goal/benchmark/cache-memory.mjs 60000 110
node --expose-gc packages/pi-goal/benchmark/cache-memory.mjs 60000 1100000
```

Timing uses real in-memory Pi SessionManagers with synthetic entries: one assistant
usage record per four entries, with custom records between them. Each mode has
250 samples. Append modes add one assistant entry and one custom checkpoint before
each timed read; insertion is outside the timed interval. Returned totals contribute
to printed checksums, and incremental totals are checked against the unchanged full
recount before and after append phases.

Memory samples must each run in a fresh process. The benchmark warms accounting on
a disposable manager, creates the measured manager, and records `heapUsed` before
and after populating its checkpoint, with four forced garbage collections at each
boundary. The manager stays live through both measurements. This measures retained
JS heap deltas, not transient work arrays, baseline session memory, or process RSS.
The large-token case exercises totals beyond V8's small-integer range.

These measurements cover accounting only, not saving, UI redraw, model calls, or
total tool latency. They are not directly comparable to the earlier exploratory
6.2 ms measurement that included saving and status formatting.

## Timing results

Local shared host: macOS (Darwin 25.5.0), Node v26.3.0, npm 11.16.0.
Timings are indicative, not enforced thresholds. Very small values are near
microbenchmark timer/JIT overhead and are not fixed latency guarantees.

| Initial entries | Full recount after append, median / p95 (ms) | Checkpoint after append, median / p95 (ms) | One cold checkpoint read (ms) |
| --- | --- | --- | --- |
| 100 | 0.01921 / 0.07554 | 0.00038 / 0.00104 | 0.16 |
| 10,000 | 0.32233 / 0.78896 | 0.00013 / 0.00017 | 7.27 |
| 60,000 | 2.54408 / 5.45683 | 0.00013 / 0.00017 | 6.21 |

At 60,000 entries, unchanged reads measured 2.367 ms median for a full recount and
below 0.001 ms for the checkpoint. The deterministic test requires 60,000 entry
lookups cold, one when unchanged, and three after two new entries. Another test
proves historical prefixes are not retained: divergent branch revisits recount,
then appends use the new checkpoint.

Cold reads and branch recounts remain linear in branch length. They use a temporary
array to sum root-to-leaf and preserve floating-point/saturation semantics. This
array is released after the call; it is not retained cache memory.

## Retained-memory results

Three fresh processes per case measured these heap deltas after garbage collection:

| Entries | Tokens per assistant | Retained heap delta |
| --- | --- | --- |
| 10,000 | 110 | 5.0–15.7 KiB |
| 60,000 | 110 | 2.8–3.1 KiB |
| 60,000 | 1,100,000 | 6.9–7.1 KiB |

These small deltas include GC/JIT noise and are not exact checkpoint object sizes;
the non-monotonic values do not indicate negative per-entry costs. The structural
claim is constant retained checkpoint state per manager, not a fixed byte count.
The checkpoint references an existing leaf object rather than copying entry content.

For comparison, the superseded per-entry prefix-cache implementation measured
about 2.01 MiB at 60,000 entries with small totals and 2.80 MiB with large totals
in three isolated processes per case using the same retained-heap methodology.
The single-checkpoint implementation avoids that history-proportional overhead.

## Verification

Completed locally for the single-checkpoint implementation:

- `npm run check`: passed builds, Biome, extension boundaries, and workspace types.
- Canonical affected gate:
  `PI_EXTENSIONS_BUILD_READY=1 PI_EXTENSIONS_TEST_BASE=origin/main npm test`.
  Test compilation passed; all **946 Goal tests across 37 files** passed, including
  **13 accounting tests**. Across all 80 files: 1,461 tests passed, 10 failed, and
  two were skipped after a suite setup failure. The broader gate is not green.
- `npm --workspace @narumitw/pi-goal run test:runtime`: passed the existing offline
  lifecycle, continuation, retry, compaction, ownership, wait, and budget scenarios.
- Timing benchmark completed with checked reference totals; all nine isolated memory
  samples completed.
- Rebuilt package loaded through the installed Pi's `DefaultResourceLoader` with
  the expected command/tools, no duplicate extension, warnings, or load errors.
- `git diff --check`: passed.

The broader gate's remaining host/toolchain limitations match the earlier run:

- The versioning fixture requires Node v26.11.1; this host has v26.3.0. Setup fails
  and skips two tests.
- Five npm install-policy assertions fail; this host's npm warns that
  `min-release-age-exclude` is unsupported.
- Native macOS file watching did not observe writes. The fsevents smoke and two
  Pi exec readiness tests fail.
- The root runtime-builder import-inventory test and extension-status contract test
  exceed their unchanged five-second deadlines.

No root tests were changed or deadlines raised to hide failures. A clean broader
gate under the pinned toolchain and functioning platform facilities is still
required. The PR remains draft. Package metadata and runtime-loading behavior
are unchanged; no new pack smoke is required.

## Scope audit

The implementation uses only public session APIs and their append-only contract.
A weak sessionManager key owns one checkpoint; entry object identity distinguishes
reloads with reused IDs. Missing or empty leaves clear the checkpoint. Branch
changes not containing the checkpoint recount and replace it. The original full
recount remains the reference and fallback for branch-only contexts. Root-to-leaf
accumulation preserves rounding and safe-integer saturation; baseline subtraction,
budget enforcement, and goal snapshots are untouched.

The extension conventions were reviewed. No settings, persistent formats, prompts,
tools, timers, background work, dependencies, or publications changed. A patch
Changeset records the package performance change. The rebuilt checkout is configured
for local testing; existing Pi runtimes need `/reload`.
