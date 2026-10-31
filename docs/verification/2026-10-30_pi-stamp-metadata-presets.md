# Pi Stamp metadata presets verification

The main menu now exposes **Presets**. Presets change only assistant metadata; Settings provides independent layout and field controls. Matching settings show their preset name; combinations that match none show Custom.

## Semantic audit

Reviewed the final diff against `docs/extension-conventions.md`, `docs/extension-settings.md`, and `docs/readme-conventions.md`, with an independent read-only review.

- Presets apply one complete metadata patch and preserve unrelated settings and unknown fields.
- Model, Usage, Cost, and Abnormal add distinct metadata selections without changing the original three presets, defaults, legacy translation, or persistence schema; all seven keep debug capture off.
- Legacy selectors and subordinate flags are validated, translated on read, and replaced only by an explicit successful save; canonical fields take precedence individually.
- Reads remain side-effect free. Writes reread valid disk state, retain ordering through reload/shutdown, publish atomically, and recover after failure.
- Metadata visibility is independent of layout. Thinking level, response ID, and diagnostic capture have separate gates; new defaults and presets keep debug capture off.
- Existing since-user cost behavior and session-entry versions remain compatible. Session history is not rewritten.
- Every effective field participates in render-cache invalidation and Status output. Status and Help use scrollable read-only reviews.
- Cancellation, disposal, session replacement, and shutdown are covered. Accepted saves can finish after the menu closes, but ended ownership suppresses later UI notifications.
- No model-visible prompt, tools, messages, or context behavior changes. No background preview task, network collector, or model call was added.
- Temporary preview settings affect only renderer reads. Capture and persistence keep canonical settings, and each render merges the selected metadata preset over the latest canonical base without restoring an old snapshot.

## Checks

- `npm run format`: passed.
- `npm run check`: passed, including builds, Biome, package boundaries, and all workspace typechecks.
- `npm test`: passed, with 822 test files passing, one skipped file, 17,046 tests passing, and 15 skipped tests.
- Focused Pi Stamp suite: 507 tests in 18 files passed, including non-default keybindings, paste/editing, narrow and zero widths, resizing, capture privacy, persistence failures, legacy migration, live original transcript Stamps, per-message response recovery, native painted screens, and pending-save cancellation.
- Fenced-code-aware README heading audit: all 37 active packages passed; local documentation links resolve.
- Final diff and whitespace audit: passed.

The dependency floor was raised to include the Kit fixes for zero-width bounds and readable narrow Settings values. Root installation, resolution inspection with `npm ls @narumitw/pi-tui-kit`, Kit rebuild, and consumer typecheck passed. The required Kit artifact is available from the npm registry. The isolated Jiti fixture now copies Kit's declared runtime dependencies while keeping Pi peers physically absent.

## Smokes and package evidence

- Package build passed.
- Seven real Pi RPC smokes loaded the built package directory with extension discovery disabled, opened the lazy Presets choice, applied each preset once, returned through Back or cancellation, and closed. Each smoke checked the complete catalog, current marker, exact saved metadata fields, no displayed example, and no file write before confirmation.
- Those smokes verified unrelated setting preservation, private file permissions, disabled debug fields, and an empty model message history; they made no provider requests.
- Generated-runtime tests validated emitted relative imports and exercised the lazy menu, native live-choice RPC path, and the real timestamp-only Stamp renderer through Pi's Jiti loader without physical Pi peers. The same mounted component gains the matching response's model/provider/API during selection and returns to its original rows after cancellation.
- `npm run package:pack -- stamp` passed. An actual temporary tarball contained 20 files, including the per-message reader, unchanged data-validation module, declared entrypoint, generated chunks, source, license, README, and linked settings reference. Packed source and documentation matched the working tree, the rejected picker-preview helper was absent, and all three generated relative imports resolved to exact paths within `dist`. The tarball was removed.

## TUI review corrections

- Main summaries show only the clock style, seconds visibility, and metadata preset; Status retains every effective setting and source.
- Every main-menu action has a short description, including Settings, Status, Help, and Close. Tests check the complete description list and its rendered text at 80 columns; the invalid-file Settings warning remains intact.
- The main Presets description states its purpose once. The picker explains preview versus confirmed saving, unchanged unrelated settings, and disabled debug fields without repeating the settings path.
- Short preset descriptions state their differences. Native current markers identify the saved preset; Custom has no marked preset, and moving focus changes only the temporary display, not canonical settings.
- The 53 menu tests cover all seven presets at 80 columns and 24 rows, complete picker descriptions, markers before and after saving, Custom without a marker, and RPC labels. Existing narrow/zero-width, remapped-key, editing/paste, failure, and lifecycle coverage remains intact.
- Runtime tests verify each preset's exact transcript rows in collapsed and expanded views. Matching tests allow an individual edit to reach another named preset instead of incorrectly assuming every edit becomes Custom.

The package suite, both root gates, and real Pi RPC smokes passed again after these corrections. The RPC smokes checked current markers, confirmation-only saving, and removal of the picker path. Settings persistence and asynchronous lifecycle behavior did not change.

## Display-only preset preview follow-up (2026-10-31)

This historical stage replaced the synthetic example with a temporary display override on mounted Stamp entries. The later visible-response preview below extends it; the recorded-stamp-only restriction is no longer the complete picker behavior.

- Native Kit `runLiveChoice()` applies the initial and focused preset to transcript renderer settings. Recorded rich, sparse, legacy, user, and tool entries keep their original data, expansion state, and independent display preferences. Missing metadata stays absent in those persisted entries. At this stage no session message was read for an in-picker preview.
- Preview leases merge with the latest canonical settings, release abort listeners, and clear on Back, hard cancellation, disposal, replacement, and shutdown. Superseded leases cannot change or clear a newer preview. An already-aborted caller cannot acquire ownership.
- Custom initially previews Compact without saving it. Current markers still derive from canonical settings; only confirmation submits one complete metadata patch. Success and failure preserve focus for the next choice, with canonical state retained after failure.
- Confirmation clears the preview before saving. Native Kit `runTask()` retains input ownership while the accepted update drains. Ctrl+C, disposal, and owner cancellation suppress stale success and failure notifications and prevent the picker from reopening; they do not cancel an accepted atomic write.
- Independent review identified the original pending-save input-ownership gap. The entire changed preset-save path was audited against native Kit and installed Pi lifecycle branches, fixed with the native task owner, and rechecked with no remaining actionable findings.
- Fifteen controller tests, 35 mounted-preview UI cases, 53 retained menu cases, and ten actual-extension/disk tests verify capture isolation, latest-base updates, stale ownership, all seven presets, Custom, missing fields, Back/Ctrl+C, disposal, shutdown, replacement, failed saves, accepted-save success/failure cancellation, remapped bindings, mouse focus, and rendering bounds. Readiness and result promises synchronize pending saves without sleeps.
- Native TUI markers use `✓ current`; RPC uses Kit's descriptive `current` labels and explicit `← Back`. RPC never opens a preview lease. Seven final real Pi RPC smokes passed after the task-owner fix.
- RPC review tests compare exact 120-cell hard-wrapped source rows after validating page titles and footers, so source text remains checked across page and word boundaries.
- No storage schema, default, legacy translation, model-visible prefix, or dependency floor changed in this follow-up. README sections, settings-reference links, and the existing Changeset remain aligned with the implementation.
- The completed plans at `docs/plans/2026-10-31_pi-stamp-preset-preview-plan.md` and `docs/plans/2026-10-31_pi-stamp-display-preview-plan.md` were removed after their verification. This record retains the handoff and unresolved physical-terminal limits.

## Preset order follow-up (2026-10-31)

- Both TUI and RPC list Compact, Model, Usage, Cost, Abnormal, Detailed, then None: common settings first, focused choices next, full metadata and disable choices last.
- Only the ordered catalog changed. Preset values, defaults, exact matching, preview ownership, confirmation, capture, persistence, and initial focus remain unchanged. The applied preset still receives initial focus; Custom still previews Compact.
- Contract and RPC fixtures assert the exact new order. TUI tests navigate from the actual current selection rather than assume None is first, retaining all narrow-frame, preview, save, and cancellation checks. The package settings table and existing Changeset use the same order.
- Semantic review applied the menu, TUI/non-TUI, settings, and verification rules in the guides above; no new asynchronous flow or compatibility deviation was introduced.
- `npm run format`, `npm run check`, test compilation, and the complete `npm test` gate passed again: 16,959 tests passed with the same documented skips. All 420 Stamp tests remain covered.
- Seven final offline Pi package-directory RPC smokes asserted the exact ordered catalog, current marker, unchanged preset patches, confirmation-only writes, and Back/cancellation behavior. The package dry-run and inspected 18-file tarball included the current ordered catalog and settings reference. Temporary package artifacts were removed.

## Rejected in-picker preview stage (2026-10-31)

A separate latest-response Preview block was implemented and tested, but the user rejected that placement. Their screenshot identifies the original right-aligned Stamp as the target. The block, its helper, and its dedicated tests were removed by the correction below; none is current behavior.

The completed plan at `docs/plans/2026-10-31_pi-stamp-visible-preview-plan.md` was removed after that stage's verification. Its historical results do not establish acceptance of the live-transcript requirement.

## Live original-Stamp correction (2026-10-31)

The provided screenshot shows a timestamp-only original assistant Stamp, None saved, and Model focused. The required change is on that original transcript row, not in the menu. The separate Preview block and rejected latest-response helper/test have been removed.

- The renderer now displays ordinary metadata for a Stamp without saved metadata by reading that Stamp's matching earlier assistant response. Association uses the own Stamp ID, supported entry version, assistant role, and exact valid timestamp on the active branch. A nearest preceding same-timestamp response is used, never another response, a future entry, or an abandoned branch.
- Saved Stamp metadata remains authoritative. Recovery never reads response content, IDs, diagnostics, raw/current Thinking, or unused persisted payloads. User/tool rows, ordinary clocks, timing, throughput, and since-user history are unchanged. No session entry, branch, model context, or recording flag is modified.
- The reader binds to the public session manager at session start and clears on shutdown. A public leaf-ID cache avoids whole-branch reads on every paint; explicit bind, session replacement, and leaf changes invalidate associations. Metadata is detached, bounded, sanitized, and captured once per requested Stamp/leaf, including cached unavailable values.
- The renderer includes resolved metadata in its line-cache dependency. Late binding or a branch change therefore refreshes an already mounted Stamp even when settings did not change. Hidden metadata and user/tool/saved-metadata rows do not invoke recovery. Canonical rendering uses the same read-only fallback after confirmation, so the visible result does not disappear when the preview lease closes.
- Existing data types and validators moved unchanged into `stamp-data.ts`, with established `stamp.ts` exports preserved. Entry schemas, defaults, legacy normalization, capture policy, canonical ordered saves, invalid-file protection, and model-visible prefixes did not change.
- Tests retain 53 menu intents, 38 transcript UI cases, and the existing ownership/key/mouse/bounds/privacy cases. The current suite includes 72 reader cases and 12 actual-extension/disk cases for association, cache/session invalidation, late binding, saved-data precedence, missing fields, cancellation, accepted-save durability, and post-save visibility.
- Ten native fake-terminal cases drive actual scheduled input/paint. At normal 24-row geometries they assert the original right-aligned timestamp-only Stamp changes during all seven selections, user stamps remain unchanged, no metadata block appears in the menu, and cancellation restores canonical rows. Regular/fullscreen confirmation cases keep the recovered Model row after saving. Fullscreen 16-row cases retain visible changes; short regular 16-row cases verify repaint in terminal output/scrollback because the native picker and Pi chrome can occupy the viewport. This limit is documented, not presented as a visible-preview success.
- Full test compilation, both root gates, 507 Stamp tests, the 37-package README audit, the 20-file package/import inspection, and seven final offline Pi RPC smokes passed after this correction. Generated Jiti execution recovers the matching real metadata in the original renderer with physical Pi peers absent. A fresh independent read-only review found no actionable findings.
- README, Settings guidance, Help, and the existing Changeset now describe only direct transcript application and read-only ordinary-field recovery. No separate sample or Preview panel, extra option, dependency floor change, persisted backfill, or private cross-extension coordination remains.
- The completed plan at `docs/plans/2026-10-31_pi-stamp-transcript-preview-plan.md` was removed after verification; this record retains the evidence and physical-terminal handoff.

## Unverified path and release boundary

A physical-terminal TUI smoke was not run because this harness prohibits commands that open a TUI. Tests use native renderers with fake terminals; real RPC and Jiti loading cover the emitted runtime. A maintainer with a built local checkout can start `pi --no-extensions -e ./packages/pi-stamp`, create an assistant response while None is saved, open `/stamp` → Presets, and move to Model. The model must immediately appear on the original right-aligned assistant Stamp circled in the screenshot, not in a separate menu block. Check regular and fullscreen modes, cancellation restoring None, and confirmation retaining Model without rewriting the session. Enlarge short regular-mode terminals if the menu pushes Stamp rows into scrollback. Physical appearance, terminal input and mouse delivery, and theme reload remain unverified and require the maintainer's terminal.

No package was published, no version tag was created, and no release workflow was dispatched. Publication still requires explicit approval.
