# Responsive list UI/UX review

[Back to README](../README.md)

Choice names and effective settings values must remain identifiable when the terminal becomes narrow. This change improves existing list presentation without adding a screen API, theme, shortcut, or setting. Pi still owns terminal rendering and host input; consumers still own state and persistence.

## Review findings

The review used standard-screen source, the local showcase, existing tests, installed Pi list implementations, and an independent read-only audit. Baseline frames used 80- and 32-column terminals with 30 rows. These are component captures, not physical-terminal screenshots.

| Finding | User effect | Implemented response |
| --- | --- | --- |
| Choice primary columns silently clipped names and the trailing `✓ current` marker, even at 80 columns. | Similar alternatives could become indistinguishable; current state could disappear. | Use native adaptive columns and explicit ellipses. Reserve the existing current marker when sufficient cells remain. Show the complete selected label below the list when it is clipped. |
| Settings sized their label column independently of terminal width and did not truncate labels before padding. | A long label could hide every effective value or break alignment. | Bound labels before padding, reserve value cells, and show clipped selected labels or values as passive context. |
| Searchable choices did not show result totals. | Users could not distinguish the number of matches from the cursor position. | Replace the blank row after search with a muted count such as `3 choices` or `1 of 3 choices`. Remove the redundant “Type to search” tail row. |
| Browse reserved the entire status suffix before the item name. | Long status text could remove the name. | Reserve at least half of content cells for the name, unless it needs less; bound each field with an ellipsis. |
| Compact browse hid the search field and rejected query edits. | “Edit search” recovery guidance could not be used after a resize. | Continue native query editing while hidden, without focusing or drawing the hidden field. |
| A one-cell settings row lost its trailing cursor space. | The compact frame could miss the selected row and retain the query instead. | Recognize a bare selected marker after clipping; preserve the selected row first. |
| Native `SelectList` falls back to its raw value when the label is empty. | An empty display label could expose an untrusted raw ID. | Use `(unnamed)` for empty action/choice display labels; preserve the original ID only in callbacks. |

The review retained existing strengths: standard horizontal framing, semantic theme roles, separate current and cursor states, disabled-row explanations, native text editing, exact document views, asynchronous save rollback, and mode-specific adapters.

Long static `detail` screens can still lose overflow text. Scrolling those prose screens is deferred because converting them to exact reviews would change wrapping and navigation. This list-focused change does not claim to fix every Kit UI limitation. Browse exact documents keep their existing complete-body precedence; status metadata is not inserted into them.

## Codex visual proposal

One concept board was generated with `codex_imagegen`. It compared a wide choice screen with narrow choice and settings screens, using a dark terminal example, cyan semantic accents, muted supporting text, visible ellipses, full selected-label context, and result counts.

The generated board was used to choose information hierarchy, not to define a new palette. Runtime colors remain the callback theme's roles. Its illustrative extra separators, footer placement, and mismatched sample result rows were not implemented. Generated imagery is not test evidence and is not a runtime asset, so it is not included in the package or Git history.

The reproducible design brief is: render terminal-only wide and narrow list examples; keep one selectable row per item; preserve effective values; reveal clipped selected labels; show search result counts; use existing horizontal rules, native input, and semantic colors; add no sidebar, tabs, mouse-only actions, or new shortcuts.

## Implemented design

Action and choice lists still use Pi's public `SelectList`. Its public layout callback controls primary truncation. A current choice keeps `✓ current` when there is room for both a label fragment and the marker; smaller widths keep bounded text and the complete selected-label fallback when height permits. Cursor position remains distinct from current state.

Settings retain one row and one pointer target per setting. After reserving two cells each for the cursor and column gap, values receive up to half of the available cells, limited by the widest displayed value. Short values leave more space for labels. Labels use their full width when space permits. Both fields use cell-aware truncation. Below six columns, the row prioritizes its cursor and label; full selected information remains secondary context. Description, full-label, and full-value rows are passive and do not become activation targets.

Search counts describe the filtered catalog, not the visible viewport or selected position. They use the existing row between the query and choices. Settings retain their native-style search field. Browse retains its existing adaptive layout and query/selection restoration.

At constrained heights, the existing bounded frame keeps the selected row or empty-state explanation before extra information. A complete label, description, query, count, and all hints cannot fit in a one-row budget. Extra context returns after enlarging the terminal.

## Before and after

These ANSI-free excerpts use the same synthetic data. Native fake-cursor markers and search-field padding are omitted for readability.

At 32 columns, settings previously lost both values:

```text
→ Information density for sessio
  Theme
```

The same rows now preserve aligned values, with selected context below:

```text
→ Information dens…  Comfortable
  Theme              System

  Information density for
  session output
  Set the amount of detail in
  each session.
```

At 80 columns, the current choice previously lost its name ending and current marker:

```text
→ Balanced profile for daily dev  Recommended for interactive work
```

The adaptive primary column now shows the complete name and current state. A clipped description remains available below:

```text
3 choices
→ Balanced profile for daily development ✓ current  Recommended for interactiv

Recommended for interactive work
```

At 32 columns, the selected choice retains an explicit truncation mark and its current state, followed by the full label:

```text
3 choices
→ Balanced profile … ✓ current
  Verbose profile with full d…
  Minimal profile for low-ban…

Balanced profile for daily
development ✓ current
Recommended for interactive work
```

Typing `diagnostics` now shows `1 of 3 choices`. No-match guidance and the existing query/selection restoration remain unchanged.

## Execution and verification

The saved implementation plan used this dependency order. This record retains the decisions and evidence after the working checklist is complete.

| Plan step | Acceptance evidence |
| --- | --- |
| Review standard screens and capture the baseline. | Source/native-renderer audit, independent findings, and same-size before frames. |
| Generate one Codex proposal and define a feasible terminal design. | Concept interpretation and the explicit rendering rules above. |
| Improve native action/choice labels and result feedback. | Label/current-state, result-count, raw-ID, and pointer regressions. |
| Bound settings columns and reveal clipped selected information. | Alignment, cell-width, accepted-save, and rejected-save regressions. |
| Repair browse label/status balance and compact recovery. | Wide-text, hidden-editing, detail/Back, raw-ID, and native-host regressions. |
| Document the behavior and verify the published boundary. | API guide, patch changeset, package inventory, and packed public interactions. |
| Run repository gates and review the final change. | Results below, including platform limits and the physical-terminal handoff. |

Settings row rendering moved to its own internal module so the screen factory stays below the repository's source-size limit. No public export or consumer dependency floor changed.

The first focused run found a one-cell selected-row regression and a cold Jiti smoke that exceeded the existing five-second test limit. The selected-row matcher was corrected. The smoke now prepares its cold loader in setup and verifies regular/fullscreen interactions as separate tests; it does not increase the timeout. Consumer tests also caught unnecessary clipping of a 31-cell setting label on a wide screen; label columns now use all available room instead of a fixed cap.

The new regressions cover width/height matrices, zero width, wide characters, ellipses, current/disabled identity, full selected context, result counts, theme invalidation, settings acceptance/rejection, native regular/fullscreen input, remapped keys, hidden query editing/paste, pointer identity, and detail/Back restoration. Existing tests retain RPC, unsupported modes, async draining, disposal, session replacement, and shutdown coverage.

Semantic review applies the root and Kit `AGENTS.md` rules, `docs/extension-conventions.md`, `docs/extension-settings.md`, `docs/readme-conventions.md`, and Pi's TUI, theme, and keybinding contracts. It separately checks raw/display safety, pointer geometry, selected-row retention, host input priority, save ordering/rollback, cancellation/disposal, modes, public imports, and package contents. No production asynchronous task, settings I/O path, model-visible prompt/tool prefix, or public API changed. An independent read-only implementation review found no blockers.

| Verification | Result |
| --- | --- |
| `npm run check` | Passed on macOS and on the final clean Linux snapshot: builds, Biome, package boundaries, and workspace typechecks. One unrelated informational Biome diagnostic remains outside this diff. |
| Full `npm test` | Passed on Linux: 799 files and 15,423 tests; one file and two tests skipped by existing gates; zero failures or unhandled errors. |
| Focused Kit suite | Passed on macOS: 72 files and 1,498 tests, including native regular/fullscreen, Jiti loading, real offline RPC, cancellation, and lifecycle coverage. |
| Consumer regression | All 33 BTW menu tests passed after retaining full wide-screen setting labels. The full Linux suite also passed every active consumer test. |
| Package boundary | Dry-run pack and actual tarball inspection passed: 121 files, 211 exact relative-import edges, valid exports/declarations/license/docs, no source/tests/scripts, and public packed choice/settings interactions. |
| Documentation and release intent | Fenced-code-aware README audit passed for 37 packages; 32 local documentation links resolve; patch Changeset and Changesets status review passed. |

The Linux run used the repository Node version, Git with sparse-checkout rule support, an explicit `SHELL`, and an unprivileged user. Its source archive excluded macOS AppleDouble metadata. No test timeout was increased and no new test exclusion was added. Earlier container setup errors were corrected before the passing full run.

The macOS full-suite attempt exceeded the tool command deadline. An isolated unchanged image-generation test also reproduces a macOS native `ENOENT` versus preflight `EISDIR` mismatch for a missing symlink directory. That unrelated implementation is unchanged; a macOS full-suite pass is not claimed. The same image-generation tests passed in the prepared Linux environment.

Kit is a library, not a Pi extension entrypoint. Its existing Jiti fixture and local showcase smokes exercise loading instead of attempting to load the library directory as an extension. Physical-terminal appearance and negotiation remain outside these deterministic checks.

## Physical-terminal and release handoff

A maintainer or tester with the target terminal must use the [existing showcase](./showcase-verification.md#physical-terminal-handoff) with synthetic data after building Kit. Inspect dark/light/system themes, hardware cursor visibility, IME placement, narrow resizing, and regular/fullscreen mouse behavior. In particular, inspect long choice labels/current markers, long setting labels/values, and browse no-match recovery after shrinking the terminal. The expected result is readable state, correct focus, bounded layout, and unchanged native input ownership. Physical terminal negotiation and subjective visual acceptance remain unverified; simulated captures do not establish cross-terminal acceptance.

No new consumer API is required. The maintainer retains publication ownership through the established Changesets workflow. This work does not authorize npm publication, visibility changes, release dispatch, or tags. Before publication, revert only this patch and its changeset if recovery is needed. After publication, preserve public signatures and correct regressions with a forward patch. No settings migration is needed.
