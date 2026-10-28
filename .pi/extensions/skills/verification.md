# pi-skills verification and terminal handoff

The implementation follows the approved pi-skills plan. It remains a project-local extension with no workspace, manifest, root test registration, Changeset, model tools, loader hook, or publication change.

## Deterministic and runtime evidence

Completed on 2026-10-26:

- Installed repository dependencies with `npm install`; the lockfile and manifests stayed unchanged.
- Rebuilt the Kit workspace before consumer tests and checked its workspace resolution with `npm ls @narumitw/pi-tui-kit`.
- Local NodeNext no-emit TypeScript and warning-free Biome checks passed.
- Extension-local Vitest passed 307 tests across nine files, including command grammar, native validation branches, bounded GitHub transport, settings, tree operations, actual filesystem/UI integration, Kit TUI/RPC behavior, lifecycle races, and Pi's Jiti loader.
- Root `npm run check` passed builds, Biome, package boundaries, and workspace typechecks.
- Root `npm test` passed 14,974 tests, with two existing skipped tests and no unhandled errors; the local suite runs separately.
- `test/runtime-smoke.mjs` passed through the installed Pi CLI in RPC mode for both explicit loading and trusted-project auto-discovery. Each case exercised eight dialogs, per-skill actions, actual removal, command-triggered reload, retained command registration, and unchanged message serialization across an ordinary Help/menu interaction. It used isolated home/agent/project directories and made no model requests.
- `test/headless-smoke.mjs` verified observable rejection in real print and JSON modes before skill mutation; JSON stdout remained valid protocol records. It used no credentials or model requests.
- A read-only live GitHub smoke found 29 candidates in `narumiruna/skills` at commit `079415193cdacb7947dc0dde9526bda7dd659f43`. It downloaded and hash-verified `skills/default/write-plans`, including its applicable notice, as two files totaling 5,809 bytes. No skill was installed into a real user or project location.

The test suite uses injected I/O failures for permission, cross-device rename, failed registration, partial recursive deletion, and failed recovery. It does not require a real permission denial, mount boundary, or live provider account. Each Vitest test keeps the configured 5,000 ms timeout. Subprocess operation deadlines in the RPC smoke begin only after its server-observable readiness handshake.

## Semantic audit

Applied [extension conventions](../../../docs/extension-conventions.md) and [settings conventions](../../../docs/extension-settings.md), not only the root gates:

- **Correctness and compatibility:** exact command grammar and completions, mode-specific results, native warning equivalence, full-bundle ignore rules, preserved duplicate local paths, and explicit catalog refresh.
- **Security:** pinned Git object hashes, credential-free fixed-host access, redirect refusal, bounded streamed bodies, path/type checks, terminal-display sanitization, exact mutation paths, read-only links/caches/ancestor roots, and secret-safe settings errors.
- **Lifecycle:** factory registration without owned background work, session-manager keys, owner/generation checks, disposal/abort/drain, startup/shutdown races, and no old-context use after reload.
- **Persistence and data loss:** scope-specific native arrays, unknown-field/filter preservation, malformed-file protection, snapshot staleness, complete queued read-modify-write operations, retained persistence errors, no overwrite, source verification, and explicit partial-batch/recovery results.
- **Regression and scope:** no changed existing command routes, no ordinary context/tool transformations, no cross-extension dependencies, no packaged extension changes, and no dependency or root workflow changes.

Independent review identified three failure classes. The final implementation addresses all occurrences and has representative regression tests:

1. Partial deletion followed by abort/session invalidation now drains missing-entry recovery as part of the current safe step. Tests cover cancellation during deletion and recovery for removal and copied moves, complete-root deletion, next-item cancellation, original modes, and actual recovery failure. Repair uses captured plain-data authorization and path/root/parent identity checks, not a stale Pi context.
2. Project-relative registrations now use a `./` prefix. Table-driven tests exercise literal `!`, `+`, `-`, `~`, and `~/` path branches through Pi's actual resource loader and confirm that the selected directory is discoverable.
3. RPC skill and destination labels now include identifying paths. Tests select one of two identical names in the same scope by its actual path rather than an arbitrary numeric suffix.

A final complete-diff audit includes the changes made after that independent review and the extension-local smoke scripts. It also covers native persistence completing before cancellation: regression tests verify the committed file and report registration as unconfirmed instead of falsely claiming rollback. A second independent read-only review found no remaining findings in the corrected source. Package packing is not applicable: no package metadata, published runtime, dependency floor, or publication behavior changed.

## Per-skill action menu revision

The approved interaction replaces the installed-skill read-only browse screen with Kit `choice` and `actions` screens. Selecting a path opens Move, Remove, Copy directory path, and Back; explicit batch previews and existing slash-command routes remain unchanged. Single-skill mutations share the existing preparation, confirmation, and filesystem engine.

Applied MUST rules for this revision are verified as follows:

- **Commands and modes — Test/Review:** retain batch routes, expose exact path identity in RPC, and disable clipboard copy outside TUI before calling the backend.
- **UI — Test/Review:** use standard Kit screens, callback themes/keybindings and bounded frames; keep protected items informative without enabling mutations; sanitize displayed paths while retaining the raw copy payload.
- **Lifecycle — Test/Review:** check ownership before and after the clipboard await, drain accepted native clipboard work on cancellation/disposal/replacement, and do not publish stale completion feedback.
- **Mutation and settings — Test/Review:** reuse existing exact-path confirmation, native registration and queued operations; verify that a single-skill action does not carry a prior batch selection.
- **Verification — Validator/Test/Smoke:** run the local typecheck, warning-free Biome, focused tests, full repository gates, Jiti loader tests, and isolated CLI RPC/headless smokes.

Regression tests cover action navigation without raw-content pages, per-skill move/removal, confirmation cancellation, duplicate path identity, protected resources, raw directory copying, standalone Markdown parents, clipboard failure/retry, non-default keys, selected-row restoration, main-menu custom scanning after a prior batch, and clipboard cancellation/disposal/owner replacement. Native clipboard writes are mocked so tests do not modify the operator's clipboard. An independent read-only review of the revision found no remaining actionable findings.

## Initial model invocation migration

The initial migration exposed Configure model invocation for Pi's current loaded skill list; the per-skill follow-up below replaces that entrypoint. It does not replace that list with the disk inventory, add a loader or prompt hook, introduce a JSON override, register `/skill-settings`, or disable the user-level predecessor. Existing settings remain in native skill files. The complete implementation and its tests remain project-local.

Select a skill, review the source and canonical target in a standard scrollable Kit review, confirm Open invocation setting, then change the native setting. The review remains usable for long paths and constrained terminals. Settings save immediately; Back and cancellation do not roll back committed writes. The main menu offers Reload now after a save. Until reload, native loaded objects and the advertised catalog remain unchanged. Inventory is refreshed after each completed save; an interrupted or failed refresh cannot leave old fingerprints available for bundle actions.

Applied MUST rules and semantic audits:

- **Commands, modes, and native behavior — Test/Review/Smoke:** preserve existing command routes and observable print/JSON rejection; use the native loaded list and raw path identities; retain manual-only skills after reload; leave Pi's loader, collision precedence, context, messages, and active tools unchanged during ordinary interaction.
- **UI and input — Test/Review:** use standard Kit choice, review, and settings screens with native themes, search, framing, and RPC adaptation; sanitize before display/filtering; require a review before enabling a toggle. A local public-component wrapper aborts only the settings-owned cancellation scope before forwarding standard input unchanged. It preserves focus and Kit's Back/Close/drain behavior without changing Kit or another extension.
- **Persistence — Test/Review:** use Pi's parser and loader, preserve unowned bytes/BOM/newlines, retain POSIX UID/GID/mode, reject invalid or stale source files/targets, and share the tree and canonical file queues. Stage privately, restore and verify ownership/mode, then publish by same-directory rename. Failed transactions leave the queue usable. Separate processes and arbitrary external edits remain unsupported.
- **Lifecycle — Test/Review:** check ownership, cancellation, and required project trust after awaited work, including source-handle cleanup; drain owned work after disposal, Back, hard cancel, replacement, and shutdown. A completed rename returns plain commit data even if cancellation occurred during publication; the menu records the saved value, pending reload, and inventory invalidation before checking current ownership again.
- **Boundaries — Review:** no package/workspace/manifest/dependency/Changeset/root-test changes; no imports from the predecessor; no user skill files changed during development. The predecessor remains active. Only invocation metadata edits may follow loaded links or edit package/ancestor/standalone sources; bundle Move/Remove restrictions remain unchanged.

Deterministic evidence:

- Local TypeScript and warning-free Biome passed; extension-local Vitest passed 639 tests across 13 files.
- Native flag tables, byte/mode round trips, invalid/native YAML classes, queued saves, stale content/identity/parent/link targets, partial writes, failed validation/publication, failure recovery, and bidirectional tree/file queue ordering use isolated fixtures and handshakes.
- Actual POSIX tests preserved a supplementary source GID through regular, linked, and standalone-file round trips. Injected ownership/mode failures kept the original inode and content, and a later retry succeeded. These supplementary-group cases are conditionally unavailable on single-group hosts and Windows; all seven ran on this host.
- UI tests cover TUI/RPC review, no-op/error/retry, raw duplicate identities, protected bundle actions, inventory refresh failure, native metadata immutability, framing/resize, and standard non-default keys. The cancellation matrix covers aliases, modifier order, legacy collisions, Kitty mode, malformed configured strings, the first usable fallback, and hard Ctrl+C with Back remapped.
- Synchronous Enter/Space followed by Back or Ctrl+C before the first callback starts never starts a save. Pending saves abort and drain without stale feedback; late committed saves remain recorded and no pre-save inventory survives.
- CLI RPC smoke passed explicit entrypoint loading and trusted-project auto-discovery, with 24 dialogs each. It exercised target review, a symlink-target off/on round trip, manual-only catalog retention across reload, bundle removal, command reload, and unchanged message serialization across ordinary Help/menu interaction. Print/JSON smokes preserved protocol output and rejected before mutation. No smoke used credentials or made model requests.
- After the audit corrections, root `npm run check` passed builds, Biome, boundaries, and all workspace typechecks. Root `npm test` passed 14,994 tests, with two existing skipped tests and no unhandled errors. The extension-local suite runs separately.

Independent reviews found four failure classes: cancellation before a queued callback starts, source UID/GID loss during atomic replacement, write-target context disappearing at constrained heights, and staging names exceeding the filesystem component limit for valid long source names. The corrected implementation aborts the screen scope before forwarding cancellation, restores/verifies UID/GID/mode, requires the scrollable review, and uses a short basename-independent temporary name. Representative regressions reproduce each class, including ASCII/Unicode standalone and linked-target filename round trips. The complete diff was checked for every occurrence of each class. Earlier deterministic review also found and corrected the source-handle-close ownership boundary. Physical-terminal behavior remains part of the handoff below.

The explicit compatibility limits are source-file edits rather than project overrides, immediate persistence with explicit reload instead of the predecessor's automatic reload, linked/package-source edits only after review, rejection of hard-linked or unsupported metadata files, and no copying of extended ACLs or other extended attributes. Files that rely on those attributes must be edited manually.

## Initial invocation list UI revision

The screenshot review identified three presentation problems: missing invocation state, clipped identity labels, and repeated model-facing descriptions. The revised TUI list uses name-only primary labels and compact mode/scope descriptions. Complete selected identity and active/saved states appear below the list. Full descriptions remain hidden search data. The header is one sentence. RPC labels retain mode, scope, and complete identifying paths because Kit's RPC choice adapter does not render descriptions or selected details.

Applied [extension conventions](../../../docs/extension-conventions.md) and [settings conventions](../../../docs/extension-settings.md) for UI, modes, state, lifecycle, and verification:

- **UI/modes — Test/Review:** retain standard Kit choice/review/settings screens, native keys, framing, search, raw path IDs, and the explicit target review. Sanitize names, paths, source, and hidden search text before display/filtering. Do not change Kit or another extension.
- **State/persistence — Test/Review:** show native loaded flags as Active; record only current source reads and completed saves as Saved. Keep observed values separate from native objects, preserve them on reopening the list, mark differences as Reload pending, and clear the row marker when saved and active agree. A known disk difference can offer reload without a write. Failed or cancelled pre-commit saves do not publish a new value; late committed saves are recorded before ownership checks.
- **Lifecycle/prefix — Test/Review/Smoke:** no new asynchronous resource, context hook, prompt transition, shortcut, persistence format, or registration. Existing cancellation/drain and save safety remain unchanged. Native metadata and the active catalog change only through explicit reload.
- **Boundaries — Review:** the revision stays inside the local extension, preserving the earlier migration and predecessor. No package, dependency, Changeset, or root-test change is needed.

The 24 focused list tests cover screenshot-shaped rendering without routing prose, hidden-description search, complete selected identity, raw/sanitized path separation, TUI/RPC mode visibility, same-name RPC paths, narrow frames and focus, both native modes and observed boolean values, external disk differences, reopening, toggle-back, failure, no-op, cancelled reads, and pre/post-commit cancellation. Local TypeScript and warning-free Biome passed; the complete local suite passed 663 tests across 14 files. Existing review, keybinding, lifecycle, filesystem, and native-loading regressions passed. CLI RPC smoke passed explicit and trusted-project loading with 24 dialogs each, linked target round trips, explicit reload, and ordinary message-prefix stability; print/JSON smokes passed observable rejection without model requests. Root `npm run check` passed, and `npm test` passed 14,994 tests with two existing skips and no unhandled errors.

Independent review found a display fallback branch: Pi loads invalid names with warnings, and `SelectList` renders the raw value when its normalized label is empty. Invocation labels now have a nonempty sanitized Unnamed skill fallback, while raw path IDs remain unchanged. Public-harness regressions reproduced and verified the fix for empty, control-only, ASCII-whitespace, and Unicode-whitespace names with control-bearing paths. The complete incremental diff was audited for this class and for state accuracy, cancellation, native immutability, and path identity; no unresolved implementation finding remains.

Physical-terminal acceptance remains part of the retained handoff below. Inspect the revised list on a wide terminal like the screenshot and after narrow resize, including selected path details and active/saved/pending state. Automated public-harness rendering is not physical-terminal evidence.

## Per-skill invocation actions

The current route is `/skills` → Manage skills → select a skill → Model invocation → target review → settings. There is no separate main-menu configuration list. PR #1727 was merged before this follow-up, so the change starts from its merged main revision.

Manage combines disk inventory and the native loaded snapshot using normalized absolute skill-file identities. Bundles map to their SKILL.md file; standalone Markdown keeps its own file path. Exact matches retain the original inventory authorization and attach the native skill. Loaded-only entries are visible without acquiring an inventory record or bundle permissions. Names and inferred physical/canonical aliases never authorize a join; distinct aliases remain separate rows. All native loaded package, ancestor, linked, and standalone paths remain available independently.

Applied [extension conventions](../../../docs/extension-conventions.md) and [settings conventions](../../../docs/extension-settings.md):

- **Commands/UI — Test/Review/Smoke:** keep public slash-command grammar and modes, standard Kit screens/keys/framing, safe name-only rows, status/details/search, raw operation payloads, and the exact target review. Read and clone native skills only when entering Manage or a management scan. Use Kit's cancellable task presentation for target inspection.
- **Authorization — Test/Review:** only a native loaded match enables Model invocation; only an existing eligible LocalSkill enables Move/Remove. Preserve protected bundle restrictions and pass the original inventory entry/ID to preparation. Loaded-only entries cannot invent location, fingerprint, or write authorization. Copy remains TUI-only and sends the selected raw directory path.
- **Lifecycle/state — Test/Review:** changing selection clears the reviewed snapshot. After target inspection, revalidate selection and the native reference. After an awaited save, retain plain committed values, dirty state, and inventory invalidation, but never replace a newer selection/snapshot/catalog continuation with the old result. Preserve abort/disposal/drain and all previous pre/post-commit cancellation behavior.
- **Persistence/prefix/boundaries — Test/Review/Smoke:** reuse the existing writer, field format, ownership checks, and tree/file queues; keep native objects and ordinary prompt/messages/tools unchanged until explicit reload. Add no package, dependency, Kit, root-test, Changeset, or predecessor change. Keep catalog and test-fixture responsibilities local and source files below the responsibility limit.

Pure catalog tables cover bundle/standalone identity, directories named like Markdown files, native-only sources, duplicate names/paths, lexical path normalization, aliases, immutable inputs, raw paths, and first-entry authorization. Per-skill policy tests cover loaded/scanned/protected combinations, loaded-only source classes, original mutation identity, malformed removable bundles, exact-match-only invocation, management scanning, and stale selected-resource awaits. Existing UI/key/state/search/rendering/cancellation regressions remain in scope. Real Jiti tests include both a scanned linked skill and a registered loaded-only linked source in explicit and trusted-project loading modes.

An independent read-only review found no introduced actionable finding. It identified an inherited overlapping-root issue: repeated inventory entries reached Move/Remove and were rejected as overlapping sources. Selection, preview, conflict warnings, and mutation preparation now retain the same first original entry as Manage. Regressions cover single and bulk Move/Remove, first-entry protection, original object identity, and a real overlapping-root scan followed by removal without affecting a sibling. The final complete-diff audit checked every inventory consumer, selected-resource await, cancellation/disposal path, native-state boundary, and changed route against both guides. No new guide deviation was introduced; existing deliberate limits remain below.

Completed on 2026-10-27:

- Dependencies were synchronized with `npm install` without manifest or lockfile changes, and Kit was rebuilt before consumer tests.
- Local no-emit TypeScript and warning-free Biome passed. Extension-local Vitest passed 714 tests across 16 files, including all earlier invocation, cancellation, source-file, and native-loading regressions.
- Root `npm run check` passed builds, Biome, package boundaries, and workspace typechecks. Root `npm test` passed 14,994 tests with two existing skips and no unhandled errors.
- CLI RPC smoke passed explicit entrypoint loading and trusted-project discovery, with 28 dialogs each. Both cases exercised the new action route, linked-target off/on saves, manual-only retention after explicit reload, bundle removal, retained commands, and unchanged ordinary message serialization.
- Print and JSON smokes rejected observably before mutation and preserved protocol output. No smoke used credentials or made model requests. Physical-terminal acceptance remains unverified, as described in the external handoff.

## Deliberate limits

For resource-path registration, Pi owns native `settings.json` publication through its public `SettingsManager`; this extension does not replace that implementation or claim atomic JSON publication. Invocation metadata uses the separate atomic skill-file transaction described above. The native queue protects same-process file operations, not concurrent cross-process edits of the same array.

Cross-process mutation and arbitrary external filesystem edits are unsupported. Identity and content checks detect changes at defined boundaries, not all possible hostile races. A real device or mount can still fail during recovery; failures identify the remaining paths rather than claim that cleanup always succeeds.

The default targets and selected concrete roots are an inventory boundary, not a complete mirror of Pi's resource resolver. Ancestor and package resources can still affect native collision precedence. For bundle operations, symlinked roots/skills, standalone Markdown, package caches, and ancestor roots are read-only; hard-linked bundles cannot be moved. Reviewed invocation metadata edits have the separate source-file scope described above.

Standard Kit screens own rendering, keybindings, frame layout, and RPC adaptation. Consumer tests cover non-default selector keys, filtering/checked IDs, preview return, native input editing/paste, narrow widths, constrained heights, resize, cancellation, and disposal. They do not establish the physical terminal input pipeline.

## External handoff

Responsible role: maintainer with an interactive terminal. Prerequisite: installed repository dependencies and built Kit output.

Run the documented interactive load command:

```sh
pi --no-extensions -e ./.pi/extensions/skills/index.ts
```

Verify per-skill action navigation and Back, native clipboard delivery, checkbox selection/search, exact path review, non-default keys, IME positioning, bracketed paste, mouse interaction, fullscreen and regular mode, narrow resize, hard cancellation, trusted-project auto-discovery, and `/reload`. For model invocation, inspect a linked target and a long path in the review before enabling settings, toggle both values, cancel before and during a pending save, and verify explicit reload. Confirm that Back follows settings → review → skill actions → Manage skills, that loaded-only/protected entries cannot Move/Remove bundles, and that source-file changes can affect other projects. Expected result: standard Pi/Kit interaction, no unintended mutation, and refreshed skill discovery only after explicit reload.

These physical-terminal paths remain unverified because the agent must not launch an interactive TUI from Bash. The automated loader and RPC smokes are completed evidence, not a substitute for that terminal review. No package publication, visibility change, version tag, or release workflow is authorized by this handoff.
