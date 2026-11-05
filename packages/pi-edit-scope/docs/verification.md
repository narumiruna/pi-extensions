# Edit Scope behavior, verification, and terminal handoff

This reference contains detailed behavior and developer compatibility rules for `pi-edit-scope`. Start with the [README](../README.md) for installation, commands, settings, and the protection boundary.

Deterministic tests exercise the real Pi loader, runner, agent loop, and stock tool pipeline without a live provider. They do not prove physical key delivery, IME placement, or terminal usability. Test descriptions below identify coverage; completed package-migration results are recorded in [Migration audit and handoff](#migration-audit-and-handoff).

## File selection

Discovery starts at `ctx.cwd`, not the Git root. It skips symlink entries, nonregular files, and these exact directory names at every depth:

```text
.git  .hg  .svn  node_modules  .venv  venv  __pycache__
build  coverage  dist  target  .next
```

It does not read `.gitignore`. Scan errors and work limits fail the scan instead of showing a partial inventory. Current targets appear first and remain available even when hidden, excluded, outside cwd, or not yet created. Filtering and checkboxes change only the picker draft until completion.

The list contains only files. The fzf-inspired interaction uses Pi's native fuzzy search, including whitespace and directory fragments; it never adds a path. By default, Tab toggles and moves down, Shift+Tab toggles and moves up, arrows only move, and Enter applies the checked set. Marking stops at the first or last matching file instead of wrapping; this differs from ordinary arrow navigation, which still wraps. Repeated marking at a boundary toggles the same file, and marking with no match changes nothing. An empty checked set stays open with an explanation; it neither selects the highlighted file nor ends an existing restriction.

Project labels use paths relative to cwd, not the Git root. Ordinary names are unquoted; ambiguous whitespace and escaped identities stay quoted. External paths remain absolute and are marked `(outside)`. The **Full paths** button uses Pi's `app.session.togglePath` binding (default Ctrl+P) and supports fullscreen clicks. Switching views preserves raw absolute IDs, checks, query, cursor, and canonical validation. It changes no setting and resets when the picker closes. An exact Path preview appears only when the selected row is clipped; canonical redirects keep their own detail.

To add an existing file outside the inventory, open **Add file…** and enter its path in the separate field. The default shortcut is Ctrl+O; Alt+O is used if native selection, editing, or host input reserves Ctrl+O. If both are reserved, no key is advertised; the fullscreen button remains available. Examples:

```text
~/src/another_project/AGENTS.md
~/.plan/PLAN_A.md
/absolute/path/PLAN_B.md
~/.config/atuin/config.toml
```

The separate field accepts absolute, home, file-URL, and cwd-relative forms, including a bare relative filename. Its configured Input submit key (default Enter) starts lookup; typing does not. This does not reuse or reinterpret the search query.

A successful add checks the resolved path, clears only the path field, and returns to the file list with the search and earlier checks intact. It focuses the added file if it matches the query; otherwise it retains the matching highlight and shows an Added status. Repeat for more files, then apply with the configured selection-confirm key (default Enter) or the visible **Start restriction** / **Apply changes** button. There is no function-key completion accelerator or completion row.

Missing paths, directories, hard links, and invalid input keep the path field and its draft open with an error. Back (default Escape) returns to search without changing checks; during lookup it aborts only that lookup and blocks new work until it drains. Cancelling from the file list abandons the draft, not the applied restriction. These actions create no file or parent directory; existing-file and canonical checks run again before apply.

Manually added paths must still exist at selection completion and final commit. Duplicate normalized paths are idempotent. Canonical aliases are deduplicated, but that does not remove the existing-file requirement. Previously approved missing reservations remain valid.

The [new-file workflow](../README.md#-commands) reserves one reviewed replacement target. Relative paths use cwd. Existing targets are rejected without discarding the input draft. The review marks redirected canonical targets and outside-cwd paths explicitly.

Target resolution follows native `write` and `edit` behavior for dot segments, leading `@`, `~`, file URLs, and Unicode whitespace. Exact unusual filenames use file URLs; model notices supply these URLs. Displayed paths are escaped without changing the raw target. Read-only macOS filename fallbacks do not apply to mutation targets.

## Target validation and recovery

Versioned snapshots belong to the active session branch, not to settings. Reload, resume, fork, and tree navigation restore that branch's last snapshot. A new session without a snapshot starts inactive. Compaction does not release the restriction.

Each mutation rechecks the selected reservation and the candidate target. Missing paths use the nearest existing parent plus the missing suffix. A changed symlink cannot expand the approved set. Nonregular mutation targets and files with multiple hard links are rejected, even if a hard-link alias is selected. A dangling symlink is not a missing target that `write` may create; metadata and access errors also do not mean a path is missing.

Uninitialized, invalid, uncertain, or unsupported restored state blocks edits. Use `/edit-scope` to repair the set or `/edit-scope off` to end it. A broken selected alias can be removed from the draft and replaced with its real path; that changes the saved reservation even when the canonical target is unchanged. These checks do not provide race-free containment against other processes.

## Fixed limits

These are fixed safety limits, not settings:

| Item | Limit |
| --- | --- |
| Discovered files | 5,000 |
| Visited directory entries | 20,000, including hidden or excluded names encountered |
| Directory depth | 64 below cwd; cwd is depth zero |
| Selected entries | 100 before canonical deduplication |
| Distinct manually added paths | 100 per picker, including entries later unchecked |
| Serialized scope snapshot | 24,000 bytes |
| Model notice | 48,000 bytes |

## Settings persistence

The [README Settings section](../README.md#-settings) owns the preference, default, path, reload behavior, and filename compatibility exception.

Saves preserve unknown fields, read the latest valid JSON object, and publish with a same-directory temporary file plus rename. Runtime state changes only after successful publication. A malformed document or invalid owned value blocks the save instead of being replaced with defaults. Reads do not create the settings file, its parent, or a temporary resource. Settings-file symlinks and nonregular files are rejected.

Reads, saves, and teardown are ordered in-process for the same absolute lexical settings path, including first creation and atomic replacement. A failed operation does not prevent later reads or saves. Teardown drains preceding preference operations. This is not a cross-process lock and does not coordinate different aliases of a parent directory. Native target mutations retain Pi's own queue.

## Developer compatibility

Package promotion changes the user-facing name to **Edit Scope**, the primary command to `/edit-scope`, and the main implementation path to `src/edit-scope.ts`. `/scope` and `/scope off` remain compatibility aliases with identical behavior.

The following persisted identifiers remain unchanged:

| Identifier | Owner and purpose |
| --- | --- |
| `scope-state` | `src/state.ts`: versioned branch-owned restriction snapshots. |
| `scope-contract` | `src/contracts.ts`: fixed model-visible transition notices. |
| `scope-context-anchor` | `src/contracts.ts`: persisted non-model recovery boundaries. |

The exact model notices in `createScopeNotice()` remain unchanged, including the `Scope` name and `/scope` instructions. Their text is authoritative in `src/contracts.ts`; do not rename it as part of package branding. Retaining these bytes and identifiers preserves restrictions in existing sessions and avoids a package-rename-only change to model-visible prefixes.

The retained user settings basename is another deliberate compatibility exception, not a migration to a new filename. There is no legacy-file copy, removal, or precedence rule between two settings files.

## Runtime boundary

The supported protection boundary and tool policy are in the [README](../README.md#-security-and-privacy). Native nested tool calls use the same guard, but that does not make an opaque parent tool safe. Codemode also has model, image, and temporary-artifact paths outside nested tool calls, so it is not accepted as a generic router.

The conformance suite uses the installed native `write` and `edit` implementations, not only a copied path helper. Its cases include relative and absolute paths, dot segments, leading `@`, `~`, file URLs and URI errors, Unicode and literal whitespace, POSIX literal backslashes, Windows path normalization, macOS read-only fallback separation, symbolic links, missing ancestors, hard links, nonregular files, metadata failures, and cancellation. Platform-conditional cases do not establish verification on an operating system that was not tested.

Real-file menu and native Jiti tests include sandboxed home/project and hidden-plan paths, absolute configuration files, relative paths, file URLs, and unchanged discovery preferences. No fixture touches the user's actual home files. The Add action changes only the checked draft; native writes remain blocked until Apply. Deletion, directory replacement, hard links, symlink removal/retargeting, and canonical alias deduplication have dedicated cases.

Native SDK tests execute the exported tool pipeline with real session hooks. Cases include selected writes/edits and deferred creation, unselected read/ls, and no target side effects from unselected write/edit, shell, codemode, or opaque tools. A trusted host-only fixture invokes a delegation wrapper to check that its `ctx.executeTool()` children retain real nested events and guards. The same wrapper is blocked when model-issued; production contains no test allowlist.

## Prefix epochs

Edit Scope adds no tool definitions and does not change active tool names, snippets, guidelines, or the leading system prompt. An explicit activation, changed reservation, or exit appends a fixed model notice without starting a turn and starts the next contract epoch. Reapplying the identical reservation is a no-op.

Missing or compacted-away notices create one deterministic tail recovery and a non-model persisted prefix anchor. Ordinary requests reuse its original boundary. Deferred original publication is placed at that first-seen boundary, not after newer output. Retained historical contracts remain in order after replacement and exit.

Stale anchors are rejected one at a time in branch order. Restoring an older native notice to the digest base must not discard a newer valid recovery. A repeated logical contract uses a separate recovery sequence, so it does not remove an earlier instance that belongs to a historical anchor's prefix. This covers blocked-state recovery followed by reload to the same active state ID. Saved anchors without a recovery sequence remain valid.

Restoration uses `context_with_system`, not legacy `context`. Native legacy context restoration folds prompt/tool deltas into the leading system message when the conversation changes. The full-system hook preserves existing system messages, including the leading message at index zero. Regression tests use the real runner with additive native deltas, also after exit; an empty-prefix saved anchor cannot precede the leading system message.

A separate native agent-loop test replaces only the stream function with a local completed stream. It compares effective prompt, ordered provider-visible tool definitions, active names, and the serialized earlier message prefix across ordinary requests. It excludes timestamps, usage, and other non-model accounting. It makes no transport request and claims no provider-reported cache hit.

## UI compatibility and cancellation

The manager, settings, review, and task screens use public Kit APIs. The selector and path field use small extension-owned adapters over public Pi `SelectList` and `Input`. Kit's published build and runtime APIs are unchanged.

All interactive flows use Pi's public full-width bottom overlays through `src/ui.ts`. This is an intentional presentation deviation from editor-area dialogs: Pi does not expose the dock's allocated height to custom components, and its fullscreen layout can clip an opaque editor child after widgets and footers consume space. Overlay percentages use real terminal bounds on each render. The original TUI, theme, keybindings, focus, and local mouse coordinates are retained; no host-tree inspection, guessed footer height, terminal proxy, or widget suppression is used.

Ordinary frames retain their existing conservative height. If a fixed Kit task loader is taller than the terminal, the adapter removes frame spacing and uses the public bounded-frame helper to retain the task label and normal-height borders. Component focus, input, disposal, and pending-work methods still reach their original receivers. Pi's completion callback removes only the owned overlay, even when an unrelated overlay has focus above it. Widgets and footers remain mounted and return to view after the overlay closes.

The standalone Kit selector does not expose the required in-place validation, live count, exact path preview, separate add field, and paste-safe completion behavior. The local adapter uses native fuzzy matching and a file-only SelectList. It retains the checked draft and search after validation failure and preserves a pressed raw file ID when scrolling recenters the viewport. Apply, Add, and path-mode buttons stay outside the list; Enter never toggles a file under the default keys.

The footer retains the count and reachable primary keys without scrolling. Scanning, lookup, and selection validation disable new work; an empty draft disables Apply without returning to the manager. At constrained heights, the focused file and search field take priority over button rows. Add lookup has its own abort controller: Back returns to files immediately, aborts lookup, and prevents another operation until it drains. Every result rechecks ownership and cancellation after await. Tests cover all scan/lookup/apply stages with Back, Ctrl+C, disposal, owner abort, and ownership changes.

The picker uses Kit's public hint formatter and bounded-frame hint rows. `picker-keys.ts` advertises only keys whose tested native input families reach the intended action under selection, editing, debug, and regular/fullscreen host priority. It chooses the first proven configured alternative, not the first raw string. Unusual remaps still dispatch through Pi's matcher; unproved literal hints are omitted while visible buttons remain. The proof set covers ASCII letters/digits and Space, arrows, page keys, Enter/Return (including LF and numpad Enter), Escape/Esc, Tab/Ctrl+I, Shift+Tab, Ctrl+P, Ctrl+O/Alt+O, and unmodified function keys. Invalid strings are not repaired. Tests retain modifier-order and Kitty/legacy dispatch outside this proof set.

Selection and native Input editing/submission take priority over marking and additive shortcuts. The add field uses native Input undo-before-submit ordering; the search field uses configured selection confirmation only. Under default bindings Space is text. Ctrl+C remains a hard-cancel path outside paste while Scope owns input; the ordinary footer shows Cancel rather than a duplicate Close hint. Native transcript search, global debug, earlier consuming or transforming listeners, and another focused overlay retain priority. Unknown extension listeners cannot be predicted through a public ownership API; hints do not override them. Regular/fullscreen tests cover paging, search interception, configured alternatives, debug, consumed input, and overlay ownership. Unhandled wheel input follows Pi's native routing.

Whole or fragmented bracketed paste cannot toggle, apply, add, switch views, or cancel. Pending validation discards pasted input. A paste keeps its original Input owner even if lookup completion returns to the file panel. The edited query is published before bytes after the end marker dispatch through the current screen. Pointer actions are blocked during paste. Regression tests cover both cross-panel cases so pasted controls cannot become shortcuts after an await. The new-file input keeps its existing native editing/submission behavior.

File clicks keep the original pressed ID when viewport centering or canonical details move the rows. Query, panel, and resize changes cancel unfinished gestures; their later click is consumed rather than reused for another file or button. Input uses native press-only caret placement, and activatable presses request native overlay focus. Component tests and a real fullscreen SGR press/release case cover these boundaries.

Input rendering and mouse hit-testing use the same equal-UTF-16-length mask. Only the display value is replaced; the raw draft is restored synchronously after rendering or a click. Tests combine control/format characters, emoji joiners, horizontal scrolling, native pointer placement, remapped submission/confirmation, and both actual input callers.

All new-file targets receive one exact review; ordinary in-cwd file selection has no second routine confirmation. The README documents [cancellation and explicit exit](../README.md#-commands): cancelling UI does not release an applied restriction.

Final apply receives the task's operation signal and rechecks idle state, scope revision, ownership, canonical targets, and usable loadout before committing. Session resources are keyed by `sessionManager`, not a shared headless UI object. Shutdown aborts and drains tracked tool checks, UI work, and preference writes. Component disposal also cancels owned work. Filesystem operations already in progress are awaited rather than left detached.

## Search-first picker audit

This change replaces the earlier Enter-toggle/function-key workflow with the interaction in [File selection](#file-selection). It changes only picker UI, display labels, Help, and related tests/documentation. Authorization, canonical pins, state schemas, settings, command routes, model notices, and prefix epochs remain unchanged. No Kit API, package dependency, release, visibility, or publication change is included.

| Touched area | Applicable MUST rules and named verification methods |
| --- | --- |
| Search, selection, and separate path field | Preserve native editing, paste, cancellation, theme, focus, and bounded rendering; `Review`, picker/input/menu and real regular/fullscreen host `Test`. |
| Async lookup and apply | Abort and drain owned work; revalidate ownership, mutable state, and cancellation after await; `Review`, the complete stage/ending matrix and cross-panel paste `Test`. |
| Labels and key hints | Keep raw payloads unchanged, escape unsafe display identities, prove each advertised key under native priority, use the first usable configured alternative; `Review`, table-driven matcher, clipped preview, pointer, and host `Test`. |
| Runtime and compatibility | Preserve loader behavior, persisted state, exact notices, tools, and settings; lifecycle/contracts/native Jiti `Test`, package-directory and CLI `Smoke`. |
| Package documentation | Keep README headings, warnings, scope ownership, and resolvable links; `Review`, heading/link audit, root `Validator`, pack inspection, and `Smoke`. |

The final semantic audit reproduced stale post-paste list actions and clicks lost after canonical-detail reflow, then derived and tested the wider gesture class, including lookup completion between Back press and release. The regression cases verify fresh search results, directional marking, native focus, original raw IDs, and cancellation of stale gestures.

The applicable guides are root `AGENTS.md`, `docs/extension-conventions.md`, and `docs/readme-conventions.md`; the unchanged persistence boundary is audited against `docs/extension-settings.md`. Physical terminal, IME, subjective UX, and interactive `/reload` remain the maintainer's [external handoff](#physical-terminal-handoff).

### Completed search-first checks

| Check | Result |
| --- | --- |
| `npm run check` | Passed: builds, Biome, package boundaries, and workspace typechecks. |
| `npm test` | Passed: 19,180 tests in 893 files; 16 platform/conditional tests and one file skipped; no unhandled errors. |
| Package tests and root test compilation | Passed: 431 tests in 14 files, one Windows-only skip, and `tsc -p tsconfig.test.json`. |
| Native CLI smoke | Passed: explicit package loading, trusted discovery, trust denial, print, and JSON; no model request. |
| Isolated packed production install | Passed with local Edit Scope/Kit tarballs, offline installation, and development/automatic peer installation disabled; native Jiti loads the factory, lazy manager, picker, and key helper, then verifies Tab, Add/Back, retained drafts, and cancellation. |
| Pack dry run and tarball inspection | Passed: 19 files including all 14 source modules, documentation, metadata, changelog, and license; no tests or repository configuration; private/source-entry metadata retained. |
| README audit | Passed: fenced-code-aware headings in 38 active READMEs and all 18 owned relative links/anchors; title, badges, and essential warnings retained. |

One full-suite attempt reached the tool's 300-second command limit without a reported test failure. A supervised rerun of the same canonical `npm test` completed; no per-test timeout or runtime policy was changed. The physical-terminal and interactive `/reload` handoff remains unverified. The package remains private; no release or publication action was taken.

## Review fixes

This section records the earlier package-loading and rendering fixes, before the search-first picker change.

| Finding | Resolution and regression evidence |
| --- | --- |
| Clean Git-root load requires built Kit | Root production preparation emits Kit ESM JavaScript before Inspector assets and hooks. `test/prepare-kit-runtime.test.ts` exercises exact imports, lazy boundaries, staged publication and recovery, plus an isolated production layout with no prebuilt Kit, TypeScript, Biome, Vitest, or Husky. Root esbuild is an explicit production dependency. |
| Native dock clips the selected row | Public bottom overlays bypass dock clipping without changing widgets or footers. `test/ui.test.ts` paints native regular/fullscreen hosts with the real widget, stock footer, extra footer rows, and resize from one to 32 rows; selected content stays visible. |
| Masked text uses different mouse geometry | Both input callers use the same display mask for native rendering and hit-testing. `test/input.test.ts` and `test/picker.test.ts` cover controls, joiners, scrolling, raw submission, and failure recovery. |
| New-file warning ignores canonical outside targets | The review checks both lexical and canonical paths. `test/menu.test.ts` covers inside, canonical-outside, and lexical-outside directory symlinks, cancellation, and no target creation. |

The review fixes do not change authorization, state schemas, exact model notices/anchors, settings storage, or the shared alias owner. The UI adapter owns no process, timer, or task; existing Kit flows retain cancellation and drainage. Native host tests also verify that shutdown removes Scope's overlay without closing or moving an unrelated focused overlay.

### Completed fix checks

| Check | Result |
| --- | --- |
| `npm run check` | Passed: builds, Biome, package boundaries, and workspace types. |
| `npm test` | Passed: 17,929 tests in 839 passing files; 16 platform/conditional tests and one file skipped; no unhandled errors. |
| Focused package, preparation, and shared-builder suites | Passed: 434 tests in 15 files; one Windows-only skip. |
| Production Git preparation | Passed: 18 ordering, output, recovery, and clean-layout tests. Native Jiti loads the root-listed source and lazy menu without prebuilt Kit or development tooling. |
| Source and packed CLI smokes | Passed: explicit package load, trusted discovery, trust denial, print, and JSON; both aliases reject unsupported modes without a provider run. |
| Isolated packed production install and lazy menu | Passed with local Edit Scope/Kit tarballs and development/automatic peer installation disabled; menu/picker overlay options, cancellation, retained restriction, and shutdown verified. |
| Pack dry run and actual tarball | Passed: 17 files, including all 13 source modules and required documentation, metadata, and license; no tests or repository configuration. |
| README heading/link audit | Passed: 38 package READMEs and all 15 package-owned relative links/anchors. |
| Dependency and release intent | Root installation and Kit resolution passed without changing dependency versions; only Edit Scope is selected by Changesets. Existing unrelated advisories and Kit-floor warnings remain. |
| Independent final source audit | No concrete remaining defect found in the four fixes; native overlay branches, owned cleanup, masking, paths, preparation, and compatibility contracts reviewed. |

The first full-suite shell invocation reached the harness's 300-second command limit without a reported test failure. A supervised rerun of the unchanged canonical `npm test` command completed successfully; the Vitest per-test timeout stayed at 5,000 ms. No test timeout, package version, or runtime policy was relaxed.

These deterministic checks do not verify a remote managed Git installation, physical terminal input, IME placement, interactive `/reload`, or other operating systems. The clean production-layout test isolates the reported Git installation failure without changing the user's managed package settings. The initial promotion results below are historical, not substitutes for these completed checks.

## Migration audit and handoff

Applicable guides: root `AGENTS.md`, `docs/extension-conventions.md`, `docs/extension-settings.md`, and `docs/readme-conventions.md`. The package now follows active-package documentation and publication layout, not project-local auto-discovery conventions.

| Touched area | Applicable MUST rules and named verification methods |
| --- | --- |
| Package and loading documentation | One default factory/entrypoint, independent installation, trusted code, shipped source/docs/license, working links; `Review`, boundary `Validator`, pack and package-directory `Smoke`. |
| Command documentation | Preserve established routes, document exact arguments and modes, reject unknown/trailing input, observable non-TUI errors; `Review`, lifecycle/native command `Test`, CLI `Smoke`. |
| Settings compatibility | Follow the settings guide, document the basename exception, side-effect-free reads, validation, latest-document merge, ordered operations, atomic rename, invalid-file protection, rollback; `Review`, settings fault-injection and ordering `Test`. |
| State and prefix compatibility | Retain branch reconstruction, exact persisted identifiers/notices, idempotent restoration, ordered model prefix and native declarations; `Review`, contract/lifecycle/native runner `Test`. |
| Lifecycle and UI descriptions | Release owned work on cancellation, disposal, replacement, and shutdown; revalidate after awaits; preserve native input and bounded rendering; `Review`, input/picker/menu/lifecycle `Test`. |
| README structure and scope | Required headings and badges, source-only installation, essential warnings, concise command reference, one detailed owner per topic; `Review`, fenced-code-aware heading/link audit, root `Validator` and `Test`. |

The documentation audit compares the README and this reference with the implementation and existing test cases. It checks external paths, deferred creation, all command modes, cancellation, branch recovery, hard-link and symlink restrictions, codemode rejection, settings read/write ordering and failure recovery, and model-prefix compatibility. These reviews do not replace execution of the migration checks.

### Initial promotion checks

This table records the initial package promotion before the review fixes. It does not substitute for checks of the changed UI and production preparation.

Run root gates and smokes sequentially from the repository root. Root checks clear and rebuild Kit output; do not run consumer tests or another Kit build/check concurrently.

```sh
npm run check
npm test
node packages/pi-edit-scope/test/runtime-smoke.mjs
npm run package:pack -- edit-scope
```

| Check or smoke | Migration status |
| --- | --- |
| Fenced-code-aware README heading audit and package-owned link review | Passed: required headings in all 38 package READMEs; all 14 owned-document relative links and anchors resolve. Title/badges, unpublished-install instructions, manifest documentation boundary, and whitespace also checked. |
| `npm install` and `npm ls @narumitw/pi-tui-kit` | Passed: the new package resolves Kit from the workspace; the lockfile adds only the new package and workspace link. |
| Root `npm run build` and package build with `--if-present` | Passed; this source-entry package has no build script. |
| Package typecheck and root test compilation with `tsc -p tsconfig.test.json` | Passed after the root build. |
| Focused root Vitest run for `packages/pi-edit-scope/test/` | Passed: 375 tests, 1 Windows-only skip, 11 files, no unhandled errors. Includes exact legacy contracts/identifiers, retained settings path, ignored new filename, aliases, cross-alias flows, and non-TUI modes. |
| `npm run check` | Passed: builds, Biome, package boundaries, and every workspace typecheck. |
| `npm test`, including `packages/pi-edit-scope/test/*.test.ts` | Passed: 837 test files and 17,892 tests; 1 file and 16 platform/conditional tests skipped; no unhandled errors. |
| `node packages/pi-edit-scope/test/runtime-smoke.mjs` | Passed: explicit package-directory load, trusted-project package discovery, trust denial, print, and JSON; both command names reject unsupported modes without a model request or protocol corruption. |
| `npm run package:pack -- edit-scope` and actual tarball inspection | Passed: 16 files containing all 12 source modules, the behavior reference, README, license, and manifest; no tests or repository configuration. |
| Package-directory loading and representative lazy manager/selector through Pi's Jiti loader | Passed from the workspace and an isolated production install of local Edit Scope and Kit tarballs; the packed manager and picker open and cancel without changing state. |
| `npm run changeset:status` | Passed: only Edit Scope is selected for a minor release; existing unrelated Kit floor warnings remain. |
| Physical terminal and interactive `/reload` | Not run; use the handoff below. |

The extension declares the source entry `./src/index.ts` and has no own build. A root build is required for the local Kit dependency before consumer tests or loading. Root `npm test` includes the moved package tests; do not use the removed project-local Vitest configuration or old source paths. The expected package contents are `src/`, `docs/`, `README.md`, `LICENSE`, and package metadata, without repository-only tests or configuration. Publication, visibility changes, tags, and release dispatch are outside this handoff.

The isolated production-install smoke used `--offline --ignore-scripts --omit=dev --legacy-peer-deps` with locally packed Edit Scope and Kit. Pi supplied its peers through the native loader; they were intentionally absent from the consumer's npm tree. The five CLI paths passed again from that install, and its lazy manager and picker were exercised through the SDK TUI harness. This verifies packed contents and dependency resolution, not registry publication or a physical terminal. The initial dependency installation reported two moderate advisories without changing existing dependency versions; no unrelated dependency repair was attempted.

The initial promotion semantic diff audit covered every moved source module, both command aliases, widget ownership, all asynchronous cancellation/disposal/replacement/shutdown boundaries, and settings reads and writes together. Guard, path, discovery, settings, state, and model-contract logic is unchanged apart from import suffixes and compatibility comments. UI changes are limited to branding and the exit-command label. The legacy settings basename and model-visible names are documented compatibility exceptions. No generated runtime, active-tool transition, new setting, private extension dependency, or publishing operation was added.

### Historical predecessor evidence

The following records came from the repository-local `.pi/extensions/scope` implementation before package promotion. They are retained only as history; their commands, counts, and outcomes do not describe a migration run.

| Historical check | Recorded predecessor result |
| --- | --- |
| Local TypeScript | Passed. |
| Local Vitest configuration | Passed: 368 tests in 11 files; 1 Windows-only test skipped on that host. |
| CLI smoke | Passed: all 5 CLI paths after the predecessor's final context change. |
| Local Biome | Passed: 29 files. |
| Root `npm run check` | Passed: builds, Biome, boundaries, and workspace typechecks. |
| Root `npm test` | Passed: 17,517 tests; 15 platform/conditional skips; no unhandled errors. |

The predecessor CLI smoke covered explicit source loading, trusted-project discovery, trust denial, print mode, and JSON mode. It observed command rejection without a model run or protocol corruption. Its subprocess deadlines began after readiness and all child exits were awaited. Those source-location discovery results do not verify the new package installation path.

The earlier [PR #1770 review](https://github.com/narumiruna/pi-extensions/pull/1770), at reviewed head `09256f95`, recorded two addressed prefix failures:

1. [Stale notice exclusions](https://github.com/narumiruna/pi-extensions/pull/1770#discussion_r4436025218): rejecting an older anchor removed a newer valid recovery. The fix recomputes after one-at-a-time rejection.
2. Repeated contracts after blocked-state recovery: restoring the same active state ID removed earlier history used by a valid blocked anchor. The fix gives repeated recoveries distinct sequences and retains compatibility with older anchors.

Both were recorded as prefix/history defects, not file-guard bypasses. Existing pure and native-runner regression cases cover these classes. This historical ledger is not a new review or a claim that the package migration has no remaining defects.

## Physical-terminal handoff

Maintainer: after the repository build, run these checks in a real terminal with the usual Pi configuration. Do not claim verified native UX or release readiness from headless evidence alone. No publication is part of this change. These commands are a manual handoff, not an automated gate.

From the repository root, prepare a disposable workspace:

```sh
repo="$PWD"
fixture="$(mktemp -d)"
printf 'first\n' > "$fixture/a.txt"
printf 'second\n' > "$fixture/b.txt"
cd "$fixture"
pi --no-extensions -e "$repo/packages/pi-edit-scope"
```

1. Open `/edit-scope`; confirm **Edit Scope** branding, the full-width bottom overlay, the first selected action, cwd, and inactive state. Check that `/scope` opens the same manager. Repeat with active widgets, a custom footer, and a short terminal in regular and fullscreen modes.
2. Check that only files appear in the list, ordinary names are unquoted, and outside-cwd targets keep full labels and markers. Type spaces and directory fragments; they must only search. Test Enter with zero checks, Tab toggle/down, Shift+Tab toggle/up, and arrow-only movement. At the first match, Shift+Tab must toggle that file without moving to the last match; at the last match, Tab must toggle without moving to the first. Repeat at both boundaries and after filtering; interior marking must still move one match in the requested direction. Toggle full paths with Ctrl+P or its button without changing query, cursor, or checks. In a long list, check `a.txt`, inspect the count and keys without scrolling, and press Enter to apply. Confirm return to the prompt and the active widget.
3. Reopen the selector, keep a query and checked draft, and use Ctrl+O or **Add file…** for several existing home/absolute paths. Confirm the separate field, preserved search/checks, and outside/canonical details. A query that hides the added file must remain intact with an Added status. Test a missing path, correct the retained draft, and test Back without creating content. Cancel the file list and confirm the live set is still only `a.txt`; repeat and apply the larger set, then restore the one-file set.
4. Try **Use only a new file…** with `a.txt`; confirm the draft survives rejection. Correct it to a new nested path, review it, then cancel. Confirm that no file or parent directory was created.
5. Repeat new-file reservation and complete it. Confirm that the set has one deferred target, not the earlier file plus the new path.
6. Exercise literal and bracketed-pasted spaces, long and Unicode text, masked controls/joiners, Backspace, cursor movement, resize, pointer selection, and IME in both fields. Repeat with non-default Tab, submit, confirm, cancel, and path-toggle bindings. Reserve Ctrl+O through native editing and check Alt+O; reserve both and use the fullscreen Add button without a false key hint. Test Enter/apply and fullscreen button clicks, transcript-search priority, and Ctrl+C hard cancellation. Confirm no default function-key completion or action row remains.
7. Change the hidden-file preference. Confirm immediate persistence and that Back does not undo the save. Restore the preference if required.
8. Run interactive `/reload` while restricted. Confirm the widget, complete Status list, both command names, and restriction survive.
9. Check a new session, resume, and tree navigation before and after activation. Expect the state of each active branch, not the last state from another branch.
10. End through **End restriction**, then use `/edit-scope off` and `/scope off`. Confirm return to the prompt, cleared owned widget, and inactive no-ops for later exits.

Physical terminal keys, IME positioning, subjective interaction quality, and the interactive `/reload` route remain unverified until this handoff is run. RPC cannot safely invoke built-in `/reload` as a prompt command; it would become model input. Native SDK reload coverage does not replace that terminal check. Live-provider behavior and untested operating systems are not claimed. These external UX checks do not replace the deterministic coding gates.
