# Pi Files verification

Pi Files has one extension factory and two independent domain services. The repository cutover replaces both predecessor entrypoints with `packages/pi-files/src/index.ts`; archived sources and tests remain under `deprecated/`. The maintainer authorized this retirement through the end-to-end implementation request. Publication and npm deprecation remain unauthorized.

## Compatibility baseline

Baseline commit: `30ef6143`. Before moving sources, all 33 predecessor suites passed: 597 tests passed and one existing path test was skipped. Direct tests require canonical `TMPDIR` on macOS, as the root test runner already provides; otherwise `/var` versus `/private/var` fixture expectations differ. No production path behavior was changed to hide that fixture issue.

| Area | Preserved contract | Evidence |
| --- | --- | --- |
| Context | Ordered immutable snapshots; unchanged XML escaping, Git provenance, bounds, `file-context-quotes` identity, and custom-turn exclusion. | Migrated context, pending-quote, Git, search, preview, and external-editor suites. |
| Permissions | Context never grants permission; scope never loads content or consumes context. | `files-integration.test.ts` tests attachment, apply/off, tree restoration, and concurrent owners. |
| Durable scope | Snapshot version 1; `scope-state`, `scope-contract`, `scope-context-anchor`; original entry IDs and historical notice bytes. | `migration.test.ts` executes extracted predecessor pure readers and successor readers in both directions, including delayed publication and compaction recovery. |
| Lifecycle | Scope restores on start/tree; context resets on start/shutdown, not same-manager tree navigation. Restrictions survive run completion and cancellation. | Migrated scope runtime/lifecycle tests and merged integration tests. |
| Settings | User-only `pi-file-context.json` and `pi-scope.json`; unchanged fields/defaults; no canonical-file migration or automatic writes. | Existing store suites, generated-entry byte-preservation checks, and combined Settings tests. |
| UI | Dedicated context explorer and checked-file picker; existing navigation, editing, paste, custom bindings, and cancellation. | Migrated UI/picker/explorer suites plus native common Settings tests. |
| Loading | One factory, eager guard registration, lazy specialized UI, external Pi/Kit imports, exact generated paths. | Builder/eager-graph tests, generated-entry Jiti test, and clean production-install fixture. |

The source guidance to prefer direct user-owned context selection is retained in the successor's `AGENTS.md`. Existing changelogs remain in the archives. The pending predecessor breadth-first Changeset is retained in its archive's `release-notes/`; its behavior is included in the successor's release intent instead of targeting a removed workspace.

## Decision branches and safety review

Tool-policy tests cover inactive, active, blocked, invalid, and uninitialized state; stock readers versus same-named replacements; selected versus unselected native writers; and shell, codemode, delegation, unknown tools, and `readOnlyHint` tools. Loadout tests cover the presence or absence of a stock direct writer and active native `codemode.mode=only`. The service does not change core settings or active tool definitions to make a loadout acceptable.

Path tests cover exact canonical targets, lexical aliases, symlink changes, hard links, existing files, reservations, removed targets, workspace mismatch, and validation interrupted by cancellation or scope replacement. Uncertain state publication remains blocked even when a session append changed memory before disk failure. Scope, contract, path, policy, and settings implementations retain the predecessor's formats and enforcement decisions.

The quote queue remains independent under ordinary/custom turns, duplicate-looking snapshots, limits, review/removal, scope apply/off, reload, tree navigation, and shutdown. Tests also cover two headless session managers sharing one no-op UI object. Missing or invalid context is not converted into edit authorization.

External editing remains user-controlled and outside native-tool enforcement. Project trust, contained regular worktree targets, final-symlink rejection, mutation-queue ownership, process cancellation, terminal restoration, and preview reload retain their previous checks. This is not an OS sandbox or an attestation of arbitrary SDK tool overrides. Historical revisions remain read-only.

### Lifecycle and ownership

Services own resources by `sessionManager`. Each UI flow also has a cancellation controller; only one context, scope, or manager flow is active for an owner. Repeated context openings can join their existing flow. Other overlapping openings are rejected, and invalid arguments still receive their original usage error rather than joining an unrelated operation.

Lifecycle hooks abort the common flow without awaiting the reload-dependent command. Waiting for that command would deadlock because `ctx.reload()` itself waits for shutdown. Domain cleanup drains native tasks and settings writes instead. Both common Settings and the legacy context settings route have regression tests where reload invokes shutdown/start from inside the command while scope remains active.

Discovery and Git initialization promises are tracked separately, so one failure cannot hide a surviving sibling. Git contexts track their individual subprocess requests and drain them after explorer cancellation; initialization settles every read, and Git calls wait for child close before releasing ownership. Completed explorers release their Git context instead of retaining each project's status map for the session. File reads and external-editor processes also join the owner's native-work set. Consumer/widget errors do not skip cleanup. Held-task regression tests verify that shutdown waits for work to settle after cancellation or a sibling failure.

Owner keys are captured before asynchronous work. A stale settings refresh returns without reading its invalidated context; shortcut writes combine the caller and owner signals. Permission operations revalidate ownership, revision, loadout, and targets. Cancellation closes transient UI, not a persisted restriction.

### Settings and terminal compatibility

The common screen uses Pi's native `SettingsList` and `getSettingsListTheme()`, an input submenu, and Kit's bounded frame with content-row mapping for mouse routing. The mapped frame implementation preserves the same framing rules as `renderBoundedFrame()`. Unknown fields and invalid-file protection stay in the two owning stores; queues provide in-process ordering, not a cross-process lock.

Tests cover immediate hidden-file saves, queued/invalid context blocking only the shortcut, rapid action order, write failures and retry, reload failure, stale continuation, disposal, pending-write drain, input focus, paste, width/height limits, callback theme roles, terminal modes, and non-default keybindings. Host-owned disposal settles the local flow without calling Pi's `done()`, so native dialog-reset iteration and the replacement editor draft stay intact. Configured native actions retain their priority over remapped Escape; only Ctrl+C remains a hard cancel. The 63-case Settings suite includes real Pi reset methods, two dialogs, delayed writes, aliases, modifier order, legacy collisions, terminal modes, invalid bindings, and fallback selection. The explorer returns no cells for zero or unusable widths instead of forcing a one-cell frame; all seven modes have boundary regressions, and normal-width behavior is unchanged. Physical key delivery is not established by these tests.

Compatibility exceptions are intentional: legacy commands keep their dedicated managers and settings routes; settings basenames and historical `/scope` notice text remain unchanged; the scope picker retains its bottom-overlay layout. The external editor does not become scope-enforced. The new combined widget uses only the `files` key, keeps the restriction and exit route separate from context summaries, and clears only its owned key.

### Model-visible context

No tools or prompt metadata are registered, activated, removed, or rewritten by this merge. Existing scope notice bytes, entry IDs, anchors, quote serialization, and additive publication are retained. Ordinary requests preserve normalized model-visible prefixes; compaction recovery remains deterministic and deduplicated after the original contract disappears. Merged tests exercise quote attachment with active scope and restoration; predecessor contract/runtime suites retain delayed-publication, branch, compaction, and normalized-prefix cases. Package, command-menu, and widget naming changes are not model-prefix transitions.

## Verification evidence

Applicable guides: `docs/extension-conventions.md`, `docs/extension-settings.md`, `docs/readme-conventions.md`, `docs/runtime-builder.md`, and the retained package guidance. Semantic review covers all touched areas above rather than treating root gates as a complete behavior audit.

Completed verification:

- Root `npm install` and `npm ls @narumitw/pi-tui-kit`: passed; the successor resolves to the workspace version satisfying its manifest floor.
- `npm run check`: passed builds, Biome, package boundaries, and all workspace typechecks.
- Final full `npm test`: 930 files passed; 20,215 tests passed and 34 skipped, with no unhandled errors. The emitted Settings test fixture was newer than its final source and included all 63 cases.
- Final focused package/production suites: 39 files passed; 708 tests passed and one existing skip.
- Native CLI smokes passed explicit generated loading, trusted-project generated auto-discovery, trust denial, RPC, print, JSON, observable scope/Files command rejection, and shutdown. No provider request was sent. The discovery fixture supplies a temporary dependency ancestor to model a real package installation under Jiti's lexical resolution.
- Bidirectional migration, exact historical notice/anchor bytes, generated Jiti lazy browsing, and production Git-install fixtures passed.
- Explicit successor build, `npm run package:pack -- files`, and actual temporary packing passed. The tarball contains 64 files, including runtime, source, documentation, changelog, README, and license; tests and build scripts are absent. Packed runtime hashes equal the validated generated output.
- Clean tarball installation outside the workspace passed dependency resolution, actual CLI smokes, and a lazy browser/startup/shutdown smoke through that installation's own Pi SDK and Kit. Use canonical temporary paths on macOS; the initial `npm --prefix` fixture produced misleading local-file metadata across `/tmp` aliases, so the verified fixture installs from its canonical working directory.
- Fenced-code-aware heading audits passed for 37 READMEs, with 85 local links/anchors checked. All 79 archived predecessor files retain exact content except the two explicit README warnings. Five scope policy/persistence modules are byte-identical, and eight compiler-normalized quote/discovery functions retain exact bodies.
- Changesets status passed for the successor only. A read-only successor registry query returned E404; no package was published.
- Final semantic review covered correctness, security, lifecycle, compatibility, regressions, and scope. Review-found native-work, host-disposal, native-key priority, and project-install-directory issues were fixed with representative regressions or corrected instructions. There are no intentional model-prefix changes or unresolved implementation findings.

### Startup samples

Separate-process samples used the existing startup benchmark, cold Jiti cache mode, one warm-up, and three measured runs per configuration on macOS/arm64. Values are medians, not a deterministic gate or a provider-latency claim.

| Loadout | Package import time | First command response |
| --- | --- | --- |
| Archived predecessor source pair | 266 ms | 396.61 ms |
| Successor source entrypoint | 199 ms | 329.20 ms |
| Successor generated entrypoint | 147 ms | 275.59 ms |

All samples used isolated agent directories and sent only command-discovery requests. An intermediate full test run had seven process-startup/deadline failures in four unchanged suites; all 53 tests in those suites passed on a focused rerun, and the final full gate passed without concurrent build/smoke commands or timeout changes. Existing unrelated Biome schema/version informational notices remain; checks exit successfully. Physical-terminal and unavailable-platform items below remain external handoff, not passing automated results.

## Retained external handoff

### Physical terminal and unavailable platforms

Responsible role: terminal/platform tester. Prerequisites: the built successor and the recorded deterministic/offline loading evidence. Exercise browsing, content search, exact-line review, scope apply/off, external editing, hard cancellation, reload, custom keys, paste/IME, and narrow/fullscreen layouts on the target terminal. Exercise native Windows path behavior on Windows.

Expected result: usable input, focus, terminal restoration, and the documented guard boundary. Unverified until performed: physical key delivery, subjective usability, unavailable-platform behavior, and native Windows editor launch. Do not claim those environments were verified. Record any discovered defect and its release impact before making a compatibility claim; deterministic checks do not establish product acceptance.

### First publication

Responsible role: package owner. Prerequisites: final implementation evidence, registry-name/ownership/visibility verification, and explicit publication approval. Approve and perform first publication through the repository's approved path; approve npm deprecation notices separately.

Expected result: an independently installable successor with accurate migration instructions. Unverified until performed: registry ownership, first-publication visibility, and installation of the released npm artifact. No publication, visibility change, version tag, release workflow dispatch, or npm deprecation is authorized by this merge. Local tarball verification is not release approval.

## Recovery

Follow [migration and rollback](migration.md). Stop the run, record resource scopes and target state, remove or disable the currently active implementation, and reload a coherent successor or predecessor resource set without co-loading guards. Retain both settings files and the original session entries. Do not delete state or bypass a guard to recover unrestricted editing; uncertain restoration remains blocked until repaired or explicitly ended.
