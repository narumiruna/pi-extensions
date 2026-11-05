# Fix Edit Scope picker marking at list boundaries

## Goal

Prevent `Shift+Tab` from moving the highlight from the first matching file to the last file after a checkbox toggle. Keep the documented toggle-and-move interaction, but stop marking movement at list boundaries.

Execution is authorized on `narumi/fix/edit-scope-marking-boundaries`, based on `origin/main` at `5c2cdf2b`. The initial worktree contained only this untracked plan. Scope restrictions have ended. Root scripts were confirmed with `npm run`, and `npm run build` passed before consumer tests. Physical-terminal checks remain open because this agent cannot run interactive TUIs or prove physical key delivery.

## Context

Before the fix, `packages/pi-edit-scope/src/picker-keys.ts` mapped `Shift+Tab` to `markUp` after standard selection and Input actions. In `packages/pi-edit-scope/src/picker.ts`, `perform()` passed movement `-1` to `mark()`. The next file used `(index + move + rows.length) % rows.length`. At index zero, this produced the last result. `rebuild(next)` then restored that raw file ID as the highlighted item.

The same expression made Tab wrap from the last result to the first. Mouse marking uses movement zero. Search order depends on paths and the query, not checkbox labels.

The installed Pi `SelectList` implementation in `node_modules/@earendil-works/pi-tui/dist/components/select-list.js` clamps `setSelectedIndex()`, but its arrow actions wrap. The picker calculates the wrapped file ID before calling that setter. Keep the correction in the extension; do not change Pi or Kit.

Existing test support is in `packages/pi-edit-scope/test/picker-fixture.ts`, `test/picker.test.ts`, `test/ui-host.ts`, and `test/ui.test.ts` under the same package. It supports raw key input, rendered highlights, checked-file validation, and real regular/fullscreen hosts.

## Non-Goals

Do not rewrite the selector or change key assignments, ordinary arrow navigation, paging, search ranking, discovery, settings, path validation, tool enforcement, persisted state, model notices, dependencies, or package visibility. The package remains private and source-loaded; no publication is included.

## Plan

- [x] Reproduce the jump with a failing test in `packages/pi-edit-scope/test/picker.test.ts`.
  - Use more than ten files and send the legacy `Shift+Tab` sequence `\x1b[Z` at the first result. Expect that file to become checked and remain highlighted; the current implementation must fail the highlight assertion.
  - Also check an interior result. If it jumps to the last result, trace the selected raw ID through `mark()` and `rebuild()` before treating a boundary correction as sufficient.
  - Evidence: before the correction, index zero failed with `file-17` highlighted instead of checked `file-00`; index six passed with the preceding result highlighted. The targeted run reported one expected failure and one pass.

- [x] Replace cyclic marking movement with bounded movement in `packages/pi-edit-scope/src/picker.ts`.
  - Toggle the original raw file ID exactly once, then clamp `index + move` to the current filtered result range before rebuilding around the next raw ID.
  - Apply the same rule to both marking directions: `Shift+Tab` stays on the first result; Tab stays on the last result. Interior marking still moves one result in the requested direction.
  - A single result stays highlighted when toggled. No matching result is a no-op. Mouse marking retains movement zero. Keep existing arrow wrapping and page movement unchanged.
  - Preserve the query, checked files outside the filter, result order, and draft-only state until Apply. Add a short comment if needed to distinguish marking boundaries from native arrow navigation.
  - Evidence: both reproduction cases now pass. The only picker logic change bounds the next marking index; `picker-keys.ts`, Pi, Kit, and state publication are unchanged.

- [x] Add regression coverage for the complete marking boundary behavior.
  - In `packages/pi-edit-scope/test/picker.test.ts` and the focused `test/picker-marking.test.ts` suite, cover first, interior, and last results; checking and unchecking; repeated marking; zero and one result; and a filtered first result that is not the first inventory file. Keep the new matrix separate so the existing picker test file stays below 1,000 lines.
  - Assert the rendered highlight and selected count, then assert exact raw IDs passed to validation. Include a prechecked file hidden by the query so marking cannot discard earlier checks.
  - Cover Tab at the final result, ordinary arrow wrapping, and mouse marking without movement. Reuse existing paste, editing, validation, Add/Back, and cancellation cases rather than adding another input dispatcher.
  - Exercise legacy and Kitty `Shift+Tab` input through Pi's matcher, plus a non-default keybinding set. Confirm configured selection or editing actions still take priority over marking.
  - In `packages/pi-edit-scope/test/ui.test.ts`, use `ui-host.ts` to test a long list in regular and fullscreen overlays. Verify boundary marking and one interior upward move at normal and constrained heights, including after resize.
  - Evidence: 130 tests passed across picker, marking, usability, host, and UI suites. Coverage includes both bounds, filtered checks, repeated toggles, native editing/selection priority, legacy/Kitty/modifyOtherKeys input with Kitty on/off, remaps, and regular/fullscreen resize to 3/8/12/32 rows. No timeout override was added.

- [x] Align the package documentation and Help with the boundary rule.
  - Update the short interaction description in `packages/pi-edit-scope/README.md` and the File selection section of `packages/pi-edit-scope/docs/verification.md`: marking stops at the first or last matching file.
  - Update Help in `packages/pi-edit-scope/src/menu.ts` without changing command routes or settings. Preserve README headings, badges, warnings, and working links.
  - Evidence: README, Help, and File selection now specify non-wrapping marking; the physical-terminal handoff names the boundary cases. The fenced-code-aware audit passed for headings, title, badges, and order in 37 active extension READMEs and all 18 Edit Scope relative links/anchors. The existing Help test now asserts the boundary text.

- [ ] Verify the fix and audit the final diff after implementation is authorized.
  - Run `npm run` first to confirm root scripts. Then run `npm run check` and `npm test` sequentially from the repository root. The check gate builds Kit before consumer tests; do not run another Kit build or check concurrently.
  - Run `node packages/pi-edit-scope/test/runtime-smoke.mjs` for the existing deterministic CLI smoke. This does not prove physical key delivery.
  - Ask the maintainer to use a real terminal with `pi --no-extensions -e ./packages/pi-edit-scope` after the build. In both display modes, test first/interior/last results, filtering, repeated marking, a short terminal, Apply, and cancellation. Do not run this interactive command through the agent's shell tool.
  - Record the intended navigation deviation, completed checks, release intent, and any unverified terminal behavior. No metadata or loading change is planned, so pack and loader-specific changes are not required.

### Applicable rules and verification

Apply root `AGENTS.md`, `docs/extension-conventions.md`, and `docs/readme-conventions.md`. Use Pi's `docs/tui.md` and `docs/keybindings.md` for public input and rendering behavior.

| Touched area | Applicable MUST rules and repository requirements | Verification |
| --- | --- | --- |
| Picker input and rendering | Keep custom UI TUI-only; bound rendered lines; retain callback theme/keybindings, Input focus, render requests, native editing, paste safety, and hard cancellation. | `Review`; picker and regular/fullscreen host `Test`. |
| Draft and lifecycle safety | Keep raw file identities unchanged; do not commit on marking; preserve cancellation/disposal cleanup and ownership checks after awaits. Add no asynchronous work. | `Review`; existing picker/menu/lifecycle `Test`. |
| Compatibility and documentation | Document the intentional non-wrapping marking behavior; preserve established commands, settings, notices, README structure, and safety warnings. | `Review`; command and contract `Test`; heading/link audit. |
| Verification | Add deterministic tests for changed behavior and run both root gates; distinguish host tests from physical-terminal evidence. | `Validator`: `npm run check`; `Test`: `npm test`; CLI and terminal `Smoke`. |

### Execution evidence

- `npm run check` passed: builds, Biome, package boundaries, and all workspace typechecks. Existing Biome schema and unrelated lint information did not fail the gate.
- Final root test compilation passed. The final focused run passed 130 picker/marking/usability/host/UI tests plus the Help assertion test. All changed tests remain below the standard 5,000 ms timeout.
- Full native `npm test` completed: 19,194 passed, four failed, and 34 skipped across 895 files. The failures are two new-file review assertions split by long macOS temporary paths, the filename-fallback test's assumption that NFC/NFD names are distinct on disk, and the Fleet background-exit fixture exceeding the Unix socket path limit.
- An isolated worktree at base `5c2cdf2b` reproduced the same four failures (129 passed, four failed, one Windows-only skip). The affected path/Fleet implementations and background-exit test are unchanged. No unrelated behavior, skip, timeout, or test policy was changed.
- Native CLI smoke passed all five paths: explicit package loading, trusted discovery, trust denial, print, and JSON. It made no provider request.
- Complete diff review covered correctness, empty/single/multiple filtered results, raw identities, native input priority, mouse identity, cancellation, disposal, session ownership, shutdown, command compatibility, and scope. No new task, authority path, settings write, prompt change, or external request was added.
- The package remains private. No Changeset is required for this unpublished package; no dependencies, entrypoints, metadata, visibility, versions, tags, or release workflows are changed.

## Completion Checklist

- [x] The original first-result regression failed before the fix and passes after it; the interior-result case passes before and after the correction.
- [x] Both marking directions stop at filtered-list boundaries, toggle only the intended file, and retain query, checks, and raw IDs; existing arrow, mouse, paste, Apply, and cancellation behavior passes in the 130-test focused run.
- [x] Regular/fullscreen host tests retain the expected highlighted file through constrained heights and resize; custom-keybinding and terminal-protocol cases pass.
- [x] README, Help, and the behavior reference agree with the tested contract; the final diff satisfies the touched-area rules without unrelated runtime or policy changes.
- [ ] Root gates and the deterministic CLI smoke have passing evidence. Physical-terminal checks have evidence or an explicit maintainer-accepted limitation; unavailable checks remain open.
- [ ] The handoff names applicable guides, semantic audits, checks, smokes, intentional deviations, release intent, and all unverified paths.

Delete this plan only after every task and completion check has evidence and deletion is within the user-approved edit scope.
