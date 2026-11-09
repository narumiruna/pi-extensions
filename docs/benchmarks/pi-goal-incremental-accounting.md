# Pi Goal incremental accounting

The fork replaces repeated full-branch token recounts with cached cumulative totals.
Normal tool completions process new entries and one cached ancestor rather than
walking the entire history. Goal-state snapshots are still persisted at the same
boundaries; settings, model context, and budget semantics are unchanged.

## Reproduction

After installing repository dependencies, run from the repository root:

```sh
node packages/pi-goal/benchmark/token-accounting.mjs
```

The benchmark uses real in-memory Pi SessionManagers with synthetic entries: one
assistant usage record per four entries, with custom records between them. Each
mode has 250 samples. Append modes add one assistant entry and one custom checkpoint
before each timed read; insertion is outside the timed interval. Returned totals
contribute to printed checksums, and incremental results are checked against the
unchanged full recount before and after append phases.

These measurements cover token accounting only, not persistence, UI redraw,
model calls, or total tool latency. In particular, they are not directly comparable
to the earlier exploratory 6.2 ms measurement that included saving and status formatting.

## Results

Local shared host: macOS (Darwin 25.5.0), Node v26.3.0, npm 11.16.0.
Timings are indicative, not enforced thresholds. Very small values are microbenchmark
measurements near timer/JIT overhead and are not fixed latency guarantees.

| Initial entries | Full recount after append, median / p95 (ms) | Incremental after append, median / p95 (ms) | One cold incremental read (ms) |
| --- | --- | --- | --- |
| 100 | 0.01375 / 0.01833 | 0.00050 / 0.00075 | 0.10 |
| 10,000 | 0.28308 / 0.31713 | 0.00025 / 0.00046 | 3.58 |
| 60,000 | 2.38550 / 3.29171 | 0.00033 / 0.00046 | 18.32 |

At 60,000 entries, repeated unchanged reads measured 2.78546 ms median for the full
recount and below 0.001 ms for the cached read. The important deterministic result
is traversal cost: the new test requires 60,000 entry lookups for the cold read,
one for an unchanged read, and three after two new entries.

Cold cache population is slower than one full recount because it records every
prefix. This is a one-time cost per uncached entry tree; reloads rebuild safely,
branch switches reuse known prefixes, and steady-state work is proportional to
newly visited entries. Weak maps release replaced managers and entry objects rather
than retaining old sessions. The cache adds per-visited-entry memory while entries
remain owned by the session.

## Verification

Completed locally:

- `npm run check`: passed repository builds, Biome, extension boundaries, and all
  workspace typechecks.
- Test compilation with `tsc -p tsconfig.test.json`: passed, including the final
  fork/branch-summary accounting assertions.
- Canonical affected test gate, matching CI selection:
  `PI_EXTENSIONS_BUILD_READY=1 PI_EXTENSIONS_TEST_BASE=origin/main npm test`.
  All 945 Goal tests across 37 files passed, including 12 new accounting tests.
  The broader gate did not pass: 1,460 tests passed, 10 failed, and two were skipped
  after a suite setup failure (80 files total).
- Single-worker retry of all Goal tests and selected root failures: all 945 Goal
  tests passed again; the root extension-status contract test recovered.
- Final targeted run: all 12 accounting tests passed with branch summaries,
  fork label re-chaining, same-file reload, and budget/snapshot assertions.
- `npm --workspace @narumitw/pi-goal run test:runtime`: passed the existing offline
  Pi lifecycle, continuation, retry, compaction, ownership, wait, and budget smoke.
- The synthetic benchmark completed with matching reference totals.

The broader gate's remaining verification limitations are explicit:

- The versioning fixture requires the repository's pinned Node v26.11.1, whereas
  this host has v26.3.0; its setup assertion fails and skips two tests.
- Five npm install-policy assertions fail with this host's npm; it warns that
  `min-release-age-exclude` is unsupported.
- Native macOS file watching did not observe writes. Both the fsevents smoke and
  Pi exec readiness tests failed on repeated runs.
- The root runtime-builder import-inventory case exceeded its 5,000 ms deadline,
  including a single-worker retry with the canonical temporary directory.

No root tests were changed or deadlines raised to hide these results. A clean
broader gate under the pinned toolchain and functioning platform facilities is
still required; the draft PR does not claim that gate is green. No new package
metadata or runtime-loading behavior requires a new pack/load smoke. Existing
Goal generated-entry tests and runtime smoke passed.

## Scope audit

The implementation uses only public session APIs and the append-only entry contract.
Session and entry object identities isolate totals across shared UI objects, branch
changes, reload, resume, and replacement. The original full recount remains the
reference implementation and the fallback for branch-only contexts. Root-to-leaf
accumulation preserves rounding and safe-integer saturation, and baseline subtraction
and budget enforcement are untouched.

The extension conventions and settings/persistence guide were reviewed. No new
settings, persistent formats, prompts, tools, timers, background work, dependencies,
installation changes, or publications were introduced. A patch Changeset records
the package performance change. The implementation and this report target our fork,
not upstream.
