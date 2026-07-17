## Goal

Keep the cursor on the currently toggled row in every extension-owned multi-select/toggle menu, while preserving existing persistence, tool-policy, paging, and fallback behavior.

## Context

The repository audit found six multi-toggle selectors. Chrome DevTools, Firecrawl, and Subagents already kept cursor state inside one custom component. Telegraph's fix was in the worktree, while Google GenAI and Plan mode still reopened `ctx.ui.select()` after each toggle and therefore reset to the first row.

## Non-Goals

- Do not change one-shot action/account/question menus, where selecting a row closes or advances the flow rather than toggling in place.
- Do not remove dialog fallbacks used by tests or non-custom UI environments.

## Plan

- [x] Audit extension selection UIs and classify in-place toggle menus; verified with repository-wide `rg` over extension source and direct inspection of all repeated selection loops.
- [x] Add cursor-retention regression coverage for Google GenAI and Plan-mode tool selectors; focused tests toggle the second row and observe the selected marker remaining there.
- [x] Convert Google GenAI's repeated tool-selection dialog to one custom selector with a stable index, queued persistence, and its existing dialog fallback; focused cursor and existing fallback tests pass.
- [x] Convert Plan mode's paged tool-selection dialog to one custom selector that retains the row after toggles and resets predictably only when changing pages, retaining the existing dialog fallback; focused cursor and existing selector tests pass.
- [x] Re-audit existing Chrome DevTools, Firecrawl, Subagents, and Telegraph selectors for the same behavior and add only missing regression coverage needed to make the repository invariant explicit; six targeted selector tests pass, and the nested Subagents agent chooser now retains its selected agent when returning from tool configuration.
- [x] Run repository formatting, full checks, and relevant package dry-runs; `npm run check` passed with 593 tests passing and 1 compatibility skip, and Google GenAI (8 files), Plan mode (12), Subagents (23), and Telegraph (10) dry-runs contained the intended files.

## Risks

- Rapid toggles could persist out of order; custom selectors must serialize saves and wait for the queue before closing.
- Plan mode paging must not carry an invalid row index onto a shorter page.
- Existing test contexts may rely on the dialog fallback when `ctx.ui.custom()` returns `undefined`.

## Completion Checklist

- [x] Every in-place extension toggle selector keeps the cursor on the activated row, proven by the repository-wide source audit and six extension regression tests.
- [x] Existing tool selection, unrelated-tool preservation, persistence, cancellation, and paging behavior passes focused package tests, including a custom-selector page transition regression.
- [x] Repository CI-equivalent checks and changed-package dry-runs pass without creating package artifacts; `npm run check` reports 593 passed and 1 compatibility skip.
- [x] The completed plan is archived under `docs/plans/archived/`.
