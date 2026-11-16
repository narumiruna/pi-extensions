# Test performance and isolation

The matched local warm-cache Vitest-stage median fell from 384.332 to 200.683 seconds (47.8%).
All 23,343 original passing cases and 18 skips remain; 61 new regressions bring the result to
23,404 passed. Vitest uses at most four fork workers, capped by available CPUs. This is Linux
evidence, not a hosted CI claim. The worker and fixture study below records the samples and limits.

The historical isolation study reduced its local median from 241.39 to 174.54 seconds (27.7%).
Its 11,209 passing cases included 42 added regressions, with two intentional skips. Those older
measurements describe a smaller inventory and must not be compared directly with the current suite.

`npm test` reports build, test compilation, and Vitest subprocess elapsed time separately. CI reuses
build output only after `npm run check` succeeds in the same job. Standalone `npm test` still builds.
The two verification gates remain separate, and a failed prerequisite stops the pipeline.

The additive Vitest reporter saves all file and package measurements to
`node_modules/.cache/pi-extensions-test-report.json`. The console shows only the five largest
packages and files by execution time. JSON durations use milliseconds without per-file rounding.

The reporter interval excludes CLI startup, discovery, and final process shutdown. Use the runner's
Vitest stage for subprocess elapsed time. File execution includes tests and hooks; collection includes
module imports, transform wait, and suite callbacks. Cumulative file times overlap across workers and
must not be added to elapsed time. They do not reproduce Vitest's private pure-import calculation.
Failed and interrupted runs retain their result in the report. The runner attempts to remove stale
data before prerequisites; the reporter also clears previous data on start. A cleanup or publication
failure warns without replacing a failing test's exit code. Treat the old report as stale if cleanup
fails.

## Native bytecode cache

The Vitest subprocess uses Node's native bytecode cache under
`node_modules/.cache/pi-extensions-node-compile-cache`. This stores compiled code, not module
instances or heap state. Top-level evaluation still runs in each isolated fork. Module identity,
resource paths, and `import.meta.url` remain unchanged.

Existing `NODE_COMPILE_CACHE` overrides, including an empty value, remain unchanged. Node's existing
`NODE_DISABLE_COMPILE_CACHE` control is preserved. The runner does not add a default cache when
`NODE_V8_COVERAGE` is present because cached functions can reduce coverage precision. An explicit
user cache override retains its existing behavior. Vitest also disables worker caching for its own
precise/custom coverage providers and flushes cached code before terminating each worker.

Native probes verify cold/warm execution, same-length source invalidation, disable-variable
presence, and unavailable-directory fallback. Cache failure must not prevent tests. Keep cache
storage trusted; do not restore bytecode supplied by an untrusted source.

## Reviewed shared-module tests

The shared-module boundary uses only literal paths in
[`test/shared-module-tests.ts`](../test/shared-module-tests.ts). New files and all omitted files remain
isolated. Changes to a listed test or its called source paths require a new semantic audit; remove
its entry if module reuse can change its result or cleanup.

Both projects inherit the same fork pool, `Math.min(4, availableParallelism())` worker cap, per-file
setup, custom timeout runner, and 5,000 ms per-test cap. Root global setup runs once. Project includes are defined only on
the children because inherited include arrays concatenate. The isolated project excludes exactly the
reviewed list, and the shared project includes only that list. Verify the resolved inventory with
Vitest's `list --filesOnly --json` command as well as the policy tests. Static case parsing alone
cannot inventory the suites registered by shared helper functions.

Admission requires one of these state classes:

1. Function-local or instance-owned data, streams, controllers, and injected dependencies, with all
   owned work completed or cancelled before the test returns.
2. Pure memoization keyed by the complete immutable input, or invariant implementation initialization
   whose identity is neither replaced nor observed as per-file state.
3. Unique, explicit filesystem paths with awaited operations and complete cleanup. A shared path
   queue must remove its settled entries on both success and failure.
4. Request-local mocks, timers, or environment overrides with complete restoration, no observed
   import-cached path, and no runnable continuation after restoration.
5. Opaque generated IDs when tests observe only identity relationships or stored fixture values,
   not an initial sequence or encoded timestamp. Global clock replacement during allocation is
   outside this admission rule.
6. Theme-dependent files that establish the common dark-theme precondition before use, with
   watchers disabled. Keybinding and Kitty-mode overrides must restore their previous value.
   Injected-theme tests must not start observing a prior file's live theme.

A pending promise is not necessarily runnable work. A negative fixture can contain an unreachable
no-resolver promise, or a disarmed race sentinel, after all actual timers, listeners, readers, and
tasks are released. This does not admit an unfinished stream pipe or an unjoined operation.

The called-path audit covers these groups; it does not admit a whole package:

| Group | Audited behavior |
| --- | --- |
| Sync planners, merge/schema validators, pointers, and memory backends | Explicit data, instance maps, in-memory settings projection, local abort signals, and streams whose pipeline settles |
| Sync config and baseline storage | Canonical settings under unique homes; dynamic path lookup; released locks; closed handles and removed temporary publication files; backend constructors, not requests |
| Codex checkpoint, projection, protocol, and consumed provider responses | Explicit entries, local collectors/readers, opaque session IDs, hashing, and drained streams; no provider-registry mutation |
| Usage formats, adapters, auth, and injected transports | Instance caches, local readiness gates, injected credential readers/fetch, restored replacements, and awaited abort/timeout cleanup |
| Notify injected providers, coordinator, and settings | Request-local timers/readers/listeners; instance-owned coordinator state; awaited close; explicit settings paths and restored spies |
| Accounts storage and explicit-ID session selection | Explicit backends/paths, released renewal locks, and fully awaited operations |
| Plan contracts, controllers, supplied-theme presentation, questionnaire, and settings | Local schedulers/controllers/editor state, drained interactions, pure command parsing, explicit paths, and restored migration environment |
| Kit, Fleet, Progress, Analytics, Context Management, Ticker, Herdr, Stamp, Subagents, Notes, and Tool listed files | Local algorithms/models, supplied-theme rendering, immutable metadata, or explicit-path fixtures with settled queues |

Installed Pi paths were inspected, not inferred from type declarations. `getAgentDir()` resolves on
call. The imported tools-manager directory is cached, but listed tests do not invoke that manager.
Theme proxy creation and fixed provider registration are invariant import effects; listed calls do
not depend on changing those registries. `SettingsManager.inMemory()` owns its storage and clones its
input. Context projection functions operate on supplied entries rather than allocate session IDs.
Pi's file mutation queue removes settled path entries and retains only a settled registration barrier.
These findings must be checked again when the relevant dependency implementation changes.

Seventeen exact builder suites are also admitted: Accounts, Analytics, BTW, Caffeinate, Chat,
Context Management, File Context, Fleet, GitHub PR, Goal, Herdr, LSP, Recall, Starship, Statusline,
Tool, and Worktree. They retain unique physical
outputs and Pi Jiti's `moduleCache: false`, so extension evaluation stays cold even when the native
SDK peer is warm. Loader reload does not emit lifecycle events. No extension watcher, inhibitor,
server, or timer starts on these called paths.

The Accounts suite also exercises a completed RPC default-account menu route: initialization,
storage updates, lock release, and menu cleanup are awaited, and its account override is restored.
File Context performs an awaited missing-settings read without creating a file. Other factories
register inactive callbacks/controllers, or the file runs only builder contracts. The Starship TOML
fixture is not read on these paths; its source-map checks are not a TOML parsing smoke. These limits
do not admit fixed-path generated-entry suites or other lifecycle paths.

The additional Analytics, Chat, Fleet, and LSP cases only register inactive factory state; Chat's
native identity and network implementations remain deferred. Context Management only runs builder
contracts. Goal opens a cancelled mock menu, whose controller is released without an action or
persistence call. Its agent path belongs to the freshly generated physical graph.

Four additional Notify files retain actual loopback HTTP tests: Bark, Gotify, ntfy, and Webhook.
Each server binds an ephemeral port, awaits requests, and closes all connections before awaiting
`server.close()` in `finally`. Request arrays and handler state belong to the test. This is not a
package-wide network admission. Slack remains isolated because one timeout assertion can fail
before the pending send is joined. The Codex Compact and Stamp builder suites also remain isolated:
their multi-root setup and cleanup do not cover every partial-allocation or removal failure.

These suites use esbuild's library-owned service for the lifetime of a worker. Build requests finish,
callback slots and references are released, and the idle child and pipes are unreferenced. There is
no build context, watch, or plugin work retained. Worker termination closes the service input and
releases this process. This is an explicit library-lifetime boundary, not a claim of zero process
resources or permission for extension-owned tasks to survive disposal.

Retain isolation for module-reset/mock factories, unrestored terminal state, theme flows outside the
common precondition, observed environment-cached paths, cold-loader assertions, and runtime graphs
without a complete ownership audit. A native Codex stream allocates an ID before its SSE branch;
allocation is safe only under the opaque-ID rule, not merely because fetch was injected. Session
projection functions that do not allocate IDs remain a separate, simpler class.

The Chat protocol's native HyperDHT/Sodium initialization was not proven resource-free. Goal tests
that share a module-owned temporary directory remain isolated. Watcher, provider-registry, process,
and network lifecycle tests remain isolated unless their exact called paths and teardown were
admitted. Omission means not admitted, not necessarily unsafe.

Two additional Codex files were returned to isolation after asynchronous-resource review:
`provider-switch.test.ts` discards a transformed response without reading or cancelling it, and
`metadata-ownership.test.ts` does not join one pending operation on every assertion-failure path.
These are retained test-fixture ownership limits, not production changes in this work.

## Fixture and import changes

Pure Sync snapshot/options helpers no longer import lock storage or the complete merge fixture.
Conflict grouping and three Kit algorithm tests import their existing implementation modules rather
than unrelated re-export graphs. Root-export tests remain unchanged.

The Langfuse build tests create one unimported output fixture and copy its complete graph into separate
consumer directories. They retain two actual deterministic builds, a real failed-validation build,
publication failure injection, independent module-copy identities, and the Jiti lazy help boundary.
Sync Jiti tests also copy one unimported build into independent loader roots and keep all three real
WebDAV interaction routes, server/settings isolation, shutdown, and cancellation cleanup.

Progress restart tests keep three distinct, cleanly exited processes per scenario. Narrow private Pi
imports would not remove the real generated runtime's root import and are not used. Partial-sync
accepted-state cloning and shared Git repository state are not used: their modest potential savings
do not justify additional recovery/identity coupling. Continuous convergence retains its readiness
and server-observed recovery synchronization.

## Worker and fixture study (2026-11-17)

### Scope and preserved boundaries

The baseline is `8e7189e5`, the release-only successor to the investigated `99c7e406` revision.
The baseline resolved inventory contains 1,038 unique files: 201 shared and 837 isolated. All original package
cases, conditional skips, assertions, fork isolation boundaries, prerequisite builds, failure
propagation, native-cache safeguards, and the five-second per-test cap remain required. No retry,
shared-module admission, affected-test selector, compiler, runtime, metadata, dependency, settings
policy, or release workflow changes are part of this study.

The default cap is four workers, still bounded by CPU availability; one-, two-, and three-CPU hosts
must not receive four workers. Both projects inherit that policy. Existing Vitest CLI overrides
remain available; there is no new configuration interface or `npm test` argument forwarding.

Changelog inspection uses one real `npm pack` invocation with repeated active-extension workspace
selectors in `beforeAll`, while retaining every individual package case. `--dry-run` reads actual
packed membership and byte sizes; `--ignore-scripts` prevents prepack builds during consumer tests.
Validation rejects failed commands, malformed records, unexpected, missing, or duplicate packages,
and absent, duplicate, or incorrectly sized root changelogs. Extra npm metadata and stderr warnings
do not invalidate otherwise successful output. Workspace selection can silently omit an unmatched
selector when others match, so validating the complete returned inventory is necessary.

Sync's four pure data factories live in `packages/pi-sync/test/data-fixtures.ts`, whose only runtime
import is `node:crypto`. `helpers.ts` re-exports them and retains engine-host installation, unique
homes, environment restoration, daemon shutdown, and fixture cleanup unchanged. Only the audited
`exclude-policy.test.ts` and `s3-client-safety.test.ts` consumers change their import boundary.
A fresh-process regression invokes all four factories and permits only the emitted data module and
`node:crypto`; value tests pin metadata, payloads, hashes, defaults, and override semantics.

### Matched worker comparison

All samples used Linux x64, Node v26.11.1, npm 11.20.0, and 32 available CPUs. Dependencies came from
the unchanged lockfile. One successful `npm run build` supplied every sample. A four-worker warm-up
passed in 212.695 seconds of Vitest time and is excluded from the medians. Native bytecode and Vitest
filesystem caches were then reused without clearing them. Samples alternated two and four workers,
with unchanged source inputs and no overlapping builds, checks, or tests from this work.

| Order | Workers | Compilation, s | Vitest stage, s | Whole probe, s | Maximum RSS, KiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 2 | 4.355 | 384.332 | 388.97 | 2,970,868 |
| 2 | 4 | 3.957 | 202.621 | 206.85 | 3,068,952 |
| 3 | 2 | 3.889 | 378.395 | 382.56 | 2,987,228 |
| 4 | 4 | 3.864 | 202.946 | 207.08 | 2,989,852 |
| 5 | 2 | 4.080 | 392.761 | 397.11 | 2,978,628 |
| 6 | 4 | 4.456 | 213.404 | 218.19 | 2,965,896 |

Every run passed 23,343 tests with 18 skips, 1,037 passing files and one skipped file, and zero
unhandled errors. The two-worker median is 384.332 seconds; the four-worker median is 202.946 seconds,
a 47.2% reduction. These are subprocess elapsed times, not cumulative file time or a cold-cache
claim. The probe includes compilation and npm launch overhead, but not a prerequisite build.
GNU time's maximum RSS is the largest reported process, not aggregate simultaneous-process memory.
External host activity was not controlled, and its effect cannot be separated from run variance.

The full JSON case inventories matched after normalizing only five source-confirmed random UUID/PID
titles in `agent-store.test.ts`. A first literal-title comparison rejected those expected differences;
it was an evidence-script failure, not a test failure. The earlier investigation's four-worker trial
without `npm_execpath` failed two npm-environment assertions and is excluded from passing evidence.
The preliminary 448.496/209.909-second comparison is also not part of these matched medians.

### Integrated results

The integrated samples used the same warm-cache and successful-build-reuse mode as the matched
baseline. The final median is 200.683 seconds, 47.8% below the two-worker baseline of 384.332 seconds.
The small difference from the worker-only median is not a separate measured contribution that can
be added to the worker gain.

| Sample | Compilation, s | Vitest stage, s | Whole probe, s | Maximum RSS, KiB |
| --- | ---: | ---: | ---: | ---: |
| 1 | 3.926 | 200.683 | 204.89 | 2,964,396 |
| 2 | 4.161 | 200.780 | 205.22 | 2,993,332 |
| 3 | 3.966 | 200.193 | 204.44 | 2,996,960 |

All three passed 23,404 tests with the original 18 skips and zero unhandled errors: 1,038 passing
files and one skipped file. Case-by-case multiset comparison retained every original result, with
only the five dynamic titles normalized and the concurrency policy test renamed from two to four.
The 61 additions are 47 package-output validation cases, eight data-fixture cases, and six CPU-cap
cases. The final resolved inventory has 1,039 unique files: 201 shared and 838 isolated; the only new
test file is the isolated data-fixture regression suite. The shared allowlist is unchanged.

The unchanged Linux skips remain grouped as follows; other platforms must retain their own existing
conditions rather than adopt these counts as a universal expectation:

| File | Skipped cases | Existing condition |
| --- | ---: | --- |
| `test/macos-install.test.ts` | 1 | macOS-only filesystem watcher test |
| `packages/pi-files/test/paths.test.ts` | 1 | Windows lexical path conformance |
| `packages/pi-lsp/test/lsp-client.test.ts` | 5 | Windows shim launch variants |
| `packages/pi-lsp/test/windows-launch.test.ts` | 8 | Windows launch and expected-failure argv variants |
| `packages/pi-sync/test/case-replacement.test.ts` | 1 | Native case-insensitive filesystem |
| `packages/pi-sync/test/snapshot-mutation-queues.test.ts` | 2 | Native case-insensitive filesystem |

Changelog file tests/hooks time was 10.129/9.691/10.111 seconds in the two-worker baseline and
2.094/2.098/2.079 seconds in the integrated runs, despite the 47 additional cases. These file times
are not additive full-suite savings and also reflect different worker contention.

Three alternating fresh-process, emitted-JavaScript import probes measured lifecycle `helpers`
at 471.536/438.594/458.267 ms and `data-fixtures` at 4.505/4.488/4.203 ms. The instrumented medians
are 458.267 and 4.488 ms, respectively, not a full-suite saving. Hook instrumentation and native
module loading differ from Vitest. The helper control still loaded the Pi root and engine fixture
host and configured the host; data-only probes loaded exactly the data file and `node:crypto`.
These findings apply to the two audited consumers, not every Sync helper user.

### Verification and current semantic audit

`npm run check` passed separately from plain, unfiltered `npm test`. The latter passed all 23,404
cases with 18 skips and zero unhandled errors; its stages were 7.574 seconds build, 4.194 seconds
compilation, and 206.380 seconds Vitest (218.33 seconds for the entire command). It is an independent
standalone-build gate, not one of the matched build-reuse performance samples.

The focused npm execution-hook run passed 466 cases with two existing skips across 22 files:
runner/environment/cache/failure propagation, gate separation, reporting, project and timeout
policies, all package changelogs, both migrated consumers, and representative Sync snapshot,
settings, storage, merge, queue, recovery, and lifecycle fixtures. Kit was rebuilt before consumers.
The shared project passed shuffled seeds 101, 202, and 303: 3,843 cases each in 9.05/7.98/8.35 seconds,
with no unhandled errors. `vitest list --filesOnly --json` verified unique complete project membership.

Two initial development checks failed and were corrected rather than waived: test compilation
rejected an optional undefined assertion message, and Biome rejected dynamic namespace indexing in
the new compatibility test. The passing checks use a normal assertion and explicit export comparisons.

The final source diff was audited against root and Sync `AGENTS.md`, `docs/extension-conventions.md`,
and this document, including an independent read-only review. The applicable MUSTs are covered by
deterministic behavior tests, real package membership/size inspection, unchanged lifecycle ownership,
and both repository gates. The audit covered npm selection/launch/JSON branches, failed and partial
inventory handling, fixture payload/hash identity, engine-host setup, cleanup and environment
restoration, post-await ownership, inherited scheduling, mocks restored in `finally`, unchanged
conditional skips, and cache/coverage/failure safeguards. No production asynchronous flow or settings
read/write policy changed. Package-directory Pi smokes, publication tarballs, and Changesets are not
applicable because metadata, runtime loading, and published behavior are unchanged; real dry-run pack
checks remain in the suite. No retry, timeout increase, skipped gate, or isolation deviation was used.

### Current external handoff and recovery

**CI maintainer:** after the approved commit is available, compare three normal before/after runs on
the same runner class. Confirm CPU and memory limits, full versus affected selection, stable outcomes,
and separate check/test gates. Hosted timeout headroom and aggregate process pressure remain
unverified by these local samples. Do not claim CI acceleration or merge a failing worker-default
change. If worker concurrency fails hosted checks, restore the two-worker cap and its policy tests
while retaining independently verified batching and fixture extraction. Do not add retries or timeouts.

**Native-platform maintainers:** with the approved revision and native macOS/Windows toolchains, run
the existing gates and verify batch npm launch, package inventory, conditional skips, and worker
stability. Native launch and memory behavior remain unverified on this Linux host. Linux measurements
do not establish native compatibility or performance. No workflow dispatch, paid runner change,
package publication, or release tag is authorized by this work.

### Reproducing the measurements

Run commands from the repository root. First install dependencies and complete `npm run build`.
Do not set `PI_EXTENSIONS_TEST_BASE`. Save the following temporary probe outside the repository;
launching it through npm preserves `npm_execpath` and the npm environment. The execution hook changes
only Vitest's worker count, not the test inventory or test behavior:

```js
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { runTests } = await import(pathToFileURL(path.resolve("scripts/run-tests.mjs")).href);
const workers = Number(process.argv[2]);
if (![2, 4].includes(workers) || !process.env.npm_execpath) throw new Error("Use npm exec and 2 or 4 workers");
if (process.env.PI_EXTENSIONS_TEST_BASE) throw new Error("Full inventory required");
process.exitCode = runTests({
  env: { ...process.env, PI_EXTENSIONS_BUILD_READY: "1" },
  execute(command, args, options) {
    return spawnSync(command, args[0]?.endsWith("vitest.mjs") ? [...args, `--maxWorkers=${workers}`] : args, options);
  },
});
```

```sh
npm exec -- node /absolute/path/to/worker-probe.mjs 4 # excluded warm-up
# Run sequentially, alternating 2, 4, 2, 4, 2, 4:
npm exec -- node /absolute/path/to/worker-probe.mjs 2
npm exec -- node /absolute/path/to/worker-probe.mjs 4
```

Acceptance probes also selected the existing default and timing reporters plus Vitest's JSON reporter
with `--reporter=json --outputFile.json=<sample>.cases.json`, consistently across configurations.
The inventory, separate gates, and representative shared-order command are:

```sh
npm run check
npm test
npm exec -- vitest list --filesOnly --json
npm exec -- vitest run --project shared --sequence.shuffle --sequence.seed=101
# Repeat the order check with seeds 202 and 303, after a successful prerequisite build.
```

Full logs, case inventories, timing reports, host details, GNU time output, and probe sources remain
in `/tmp/pi-test-speed-execute-ZcBtVX/` for this session; this document retains the durable results.
Do not infer a passing run from stale timing output; check the command exit and JSON result.

## Historical isolation-study measurements

The remaining measurements and audits record the earlier isolation study, not the current worker
comparison. Measurements use the same Linux x64 host, Node v26.11.1, 32 available CPUs, and at most two fork
workers. Dependencies were installed once from the unchanged lockfile. Run one used a cold Vitest
transform cache; later baseline and comparison runs reused the normal filesystem cache. No test or
build jobs were run concurrently by this change. GNU time's maximum resident set is the largest
reported process RSS, not the sum of simultaneous child-process memory.

Baseline revision: `3276ad35`. All three original runs passed 11,167 tests with two intentional skips;
666 files passed and one file was skipped.

| Baseline run | Vitest elapsed, s | Entire npm test, s | Maximum RSS, KiB |
| --- | ---: | ---: | ---: |
| 1 | 241.39 | 248.18 | 2,202,604 |
| 2 | 236.67 | 242.83 | 2,081,556 |
| 3 | 253.49 | 259.88 | 2,093,640 |
| Median | 241.39 | 248.18 | 2,093,640 |

The local 25% target is at most 181.04 seconds for the full-suite Vitest median. The original
[hosted CI job](https://github.com/narumiruna/pi-extensions/actions/runs/39272572434/job/118128445978)
took 400.86 seconds in Vitest and 412 seconds for the test step. Its cumulative import time was
440.87 seconds, 61% of tracked time, across 20,303 evaluations of 1,749 modules. Package execution
totalled 247.099 seconds; root tests added 14.469 seconds. Sync accounted for 92.177 seconds, or
37.3% of the package total; Progress accounted for 17.829 seconds. Those cumulative costs identified
candidates, not elapsed savings. Local and hosted elapsed times are not interchangeable.

A focused, default-isolation profile showed the external Pi root taking about 0.5–0.6 seconds per
loaded file. Removing its incidental helper edge removed that cost from the pure file-merge planner.
The first focused comparison reduced Langfuse file execution from 2.463 to 1.350 seconds and Sync Jiti
from 3.573 to 3.111 seconds. These are single focused samples, not full-suite median claims.

The 107-file shared-module trial passed seeds 101, 202, and 303 and three complete runs. Its median
was 231.99 seconds. Adding native bytecode caching passed three complete runs at 201.36, 201.52, and
207.04 seconds, a median of 201.52 seconds (16.5% below baseline). All original cases and intentional
skips remained; added reporting, cache, and failure-path regressions account for the larger count.

The 181-file boundary passed three complete runs at 182.93, 183.74, and 178.03 seconds: median
182.93 seconds, a 24.2% reduction. Adding twelve reviewed builder suites produced a 193-file trial
at 184.86, 185.57, and 191.69 seconds: median 185.57 seconds, a 23.1% reduction. Neither trial meets
the target. The faster individual sample is not a substitute for the median.

The final 203-file boundary passed all three complete samples below. Node's bytecode cache was
cleared before the first sample; samples two and three reused it. The Vitest transform cache was
warm. All 11,167 original passing cases remain, plus 42 reporting, runner, policy, and fixture
regressions; the two intentional skips are unchanged. There are 670 passing files and one skipped
file. No retry, larger timeout, removed assertion, or additional worker was used.

| Final run | Build mode | Vitest elapsed, s | Entire npm test, s | Maximum RSS, KiB |
| --- | --- | ---: | ---: | ---: |
| 1 | Reuse after successful check | 182.42 | 186.15 | 2,114,956 |
| 2 | Standalone build | 174.54 | 180.74 | 2,072,300 |
| 3 | Standalone build | 173.11 | 179.12 | 2,099,064 |

The Vitest median is 174.54 seconds, 27.69% below 241.39 seconds and below the 181.0425-second
cutoff. The peak-RSS median is 2,099,064 KiB versus 2,093,640 KiB in the baseline; this is not total
concurrent-process memory. Do not combine the different build modes into a whole-command speed
claim. Standalone builds took 2.726 and 2.567 seconds; CI reuse removes that stage, not Vitest time.

### Final package measurements

Each cell below is the median of that package's cumulative file time in the three final samples.
Collection includes imports, transform wait, and suite callbacks. These are not per-package elapsed
times, and summing phase medians does not give the full-suite elapsed median. Root tests are separate.

| Package | Files | Tests/hooks, s | Collection, s |
| --- | ---: | ---: | ---: |
| pi-sync | 158 | 69.439 | 49.364 |
| pi-progress | 21 | 8.934 | 7.807 |
| root | 23 | 8.894 | 3.136 |
| pi-codex-compact | 25 | 7.972 | 4.802 |
| pi-lsp | 9 | 6.830 | 1.066 |
| pi-subagents | 13 | 6.120 | 4.013 |
| pi-usage | 39 | 5.383 | 8.290 |
| pi-fleet | 22 | 4.899 | 2.367 |
| pi-notify | 19 | 4.468 | 1.531 |
| pi-plan-mode | 38 | 4.348 | 8.947 |
| pi-starship | 21 | 4.075 | 4.007 |
| pi-langfuse | 16 | 3.622 | 3.578 |
| pi-tui-kit | 46 | 3.515 | 3.587 |
| pi-accounts | 11 | 3.338 | 3.311 |
| pi-btw | 17 | 3.336 | 3.075 |
| pi-goal | 27 | 2.609 | 7.606 |
| pi-github-pr | 2 | 2.256 | 0.048 |
| pi-notes | 8 | 2.117 | 1.539 |
| pi-statusline | 12 | 1.942 | 3.297 |
| pi-analytics | 9 | 1.545 | 0.894 |
| pi-worktree | 11 | 1.492 | 2.858 |
| pi-file-context | 15 | 1.477 | 4.152 |
| pi-inspect | 20 | 1.256 | 5.826 |
| pi-typesafe-search | 12 | 1.019 | 3.729 |
| pi-context-management | 10 | 0.855 | 1.829 |
| pi-chat | 11 | 0.848 | 1.829 |
| pi-stamp | 11 | 0.830 | 0.918 |
| pi-ticker | 7 | 0.642 | 0.950 |
| pi-herdr | 11 | 0.493 | 1.353 |
| pi-dotenv | 2 | 0.464 | 0.392 |
| pi-caffeinate | 2 | 0.321 | 0.411 |
| pi-recall | 6 | 0.292 | 0.532 |
| pi-typesafe-compact | 7 | 0.188 | 2.139 |
| pi-tool | 4 | 0.181 | 0.472 |
| pi-typesafe | 3 | 0.085 | 1.387 |
| pi-cache-hit-monitor | 2 | 0.037 | 0.277 |
| pi-tui-kit-showcase | 1 | 0.036 | 0.053 |


## Asynchronous-resource review

An instrumented 183-file trial passed all 3,161 cases but produced 85 deduplicated diagnostic
locations: 84 `PROMISE` locations and one `FILEHANDLE` location. These are locations grouped by source
frame and type, not a count of individual live resources. Passing tests alone did not establish
ownership safety.

The full diagnostic class was audited against test fixtures, called code, installed Vitest, and Node
native stream/filesystem implementations. The two Codex ownership gaps above were removed from the
shared boundary. The other reported promises were no-resolver negative fixtures, disarmed abort
sentinels, unobserved harness/reporting gates, or consumed native stream bookkeeping. Their actual
owned listeners, timers, readers, and components finish separately.

The file-handle location awaited string-path `fs.readFile()` through baseline staging. Node waits
for the native close on both success and failure; the reported wrapper can outlive its descriptor
in asynchronous-resource tracking. A Linux probe performed 1,000 small reads and 64 reads of a 2 MiB
file, with no retained fixture descriptors before or after collection. This does not excuse an
unclosed `FileHandle` overload or a detached read.

After returning the two Codex files to isolation, the 181-file boundary passed seed 505 with
3,069 tests and 73 diagnostic locations: 72 explained promise locations and the closed file-handle
wrapper. This is not a zero-warning result. The twelve additional builder suites passed all 75
cases under resource diagnostics with no new diagnostic locations. The 193-file cohort also passed
shuffled seeds 101, 202, and 303 with 3,144 cases each; its resolved inventory contains 193 shared
and 478 isolated files, with no duplicates.

The subsequent ten-file addition passed 405 cases under resource diagnostics. It produced 28
additional promise locations in Bark, ntfy, and Webhook: disarmed abort/race sentinels, intentionally
unreachable fetches, and empty-executor stream-cancellation fixtures with their promise followers.
No server, socket, or timer diagnostic appeared. The cancellation path closes the native readable
stream, releases its reader, removes the abort listener, and clears the deadline; the deliberately
pending underlying cancellation has no resolver or future effect. This is another classified
warning result, not a zero-diagnostics claim. The 203-file cohort passed seeds 101, 202, and 303,
with 3,549 cases each, in 14.50, 12.10, and 12.45 seconds. Resolved inventory: 671 unique files,
203 shared and 468 isolated.

## Historical isolation-study verification and semantic audit

`npm run check` passed for the final configuration: builds, Biome, package boundaries, and all
workspace typechecks. Three separate full `npm test` runs passed. The 53 focused runner, reporting,
project-policy, Langfuse, and Sync Jiti cases also passed. Shared-order and resource results are
recorded above; diagnostics were classified rather than suppressed.

The final diff was reviewed against `AGENTS.md`, `docs/extension-conventions.md`,
`docs/extension-settings.md`, and `docs/runtime-builder.md`, with independent source reviews.
The review covered correctness, terminal-safe reporting, cache trust, prerequisite failures,
fixture setup failure and cancellation, post-await ownership, shutdown, physical module identity,
settings-path isolation and queue completion, and unchanged backend/restart assertions.
No published implementation, prompt prefix, tool contract, settings policy, package metadata,
dependency, or lockfile changed. No Changeset or package-pack smoke is required for these repository
checks and test-only changes. Existing actual Jiti/lazy-boundary, WebDAV, builder-publication, and
fresh-process restart tests provide runtime verification; no live provider or interactive TUI smoke
is needed for unchanged product behavior.

## Historical isolation-study alternatives and hosted handoff

Do not prebundle the Pi runtime root: its `import.meta.url` resource paths, Jiti aliases, and module
identities depend on the original package layout. The native Vitest runner is not a drop-in change
for source tests that use NodeNext `.js` specifiers pointing to `.ts` files. Filesystem transform
caching is already enabled; adding it explicitly does not remove repeated module evaluation.
Increasing integration workers, blanket isolation removal, compiled-tree execution, and CI sharding
are outside this change. A thirty-run Git-init microbenchmark measured 2.387 ms with the default
template and 2.259 ms with an empty template; this negligible difference did not justify changing
Git fixture construction.

The CI maintainer should compare three normal approved CI runs before and after the change on the
same runner class. Confirm the hosted target of about 300 seconds and report total job time
separately. Local verification cannot establish the hosted result. The CI maintainer must also check cache
behavior on other supported platforms and with installed coverage providers if those paths are
required: Linux native-cache probes and coverage-environment regressions passed, but macOS,
Windows, and coverage-plugin integration were not run here. Keep these paths unverified rather than
infer them from configuration tests. No paid runner change, workflow dispatch, release, or publication
is part of this work.
