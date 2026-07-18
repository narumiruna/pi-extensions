## Goal

Refine the Image Drop browser page so desktop space is used coherently, empty-state copy is easier to scan, history controls stay near their context, and repeated per-image metadata notices do not dominate the cards. Success means the page remains clear across empty, staged, processing, error, queued, and retained-history states without changing image staging, Pi handoff, retention, or deletion semantics.

## Context

- The framework-free UI lives in `extensions/pi-image-drop/src/web/index.html`, `app.js`, `state.js`, and `styles.css`.
- The current page already has a 1120 px outer width, responsive layouts, 44 px controls, keyboard operation, previews, confirmation dialogs, dark mode, and reduced-motion support.
- The screenshot shows three remaining hierarchy issues: the full-width history toolbar separates **Clear history** from its heading, `auto-fill` leaves an empty grid track when only a few history cards exist, and the empty draft uses three adjacent lines to communicate one state.
- `Sensitive image metadata removed` is generated for every successfully processed image, while conversion and resize notes are item-specific and must remain attached to their cards.

## Non-Goals

- Do not add history folding, timestamps, overflow menus, undo behavior, localization, dependencies, or new server/API data.
- Do not change upload, paste, drag-and-drop, reordering, preview, re-staging, deletion confirmation, retention, security, or Pi lifecycle behavior.
- Do not hide conversion, resize, processing, or error details that vary by image.

## Assumptions

- The shared metadata-removal guarantee can be stated once near the image collections while item-specific notes remain on each card.
- Three history cards should expand into three balanced columns on a wide viewport rather than reserve a blank fourth track; very wide individual cards should remain bounded through the page width and responsive breakpoints.

## Plan

- [x] Add focused presentation tests before changing the UI: `node --test extensions/pi-image-drop/test/web-state.test.ts extensions/pi-image-drop/test/web-ui-contract.test.ts` failed five new assertions before implementation and passes afterward.
- [x] Consolidate the empty draft presentation in `src/web/state.js` and `src/web/app.js` so status and next-step text answer distinct questions without repeating that no images are staged; all six lifecycle branches pass in `test/web-state.test.ts` and browser rendering.
- [x] Update `src/web/index.html` and `src/web/app.js` to present the metadata-removal guarantee once at collection level and suppress only that exact shared note from individual cards, while retaining conversion, resize, processing, and error information per image; helper/DOM tests and mixed-note browser rendering pass for draft and history.
- [x] Adjust `src/web/styles.css` so the history toolbar action stays visually associated with the history heading and low-count grids use available width without an empty `auto-fill` track; browser metrics for 0/1/3/8 cards at 320, 620, 1120, and 2000 px show balanced tracks, a 360 px lone-card cap, and zero horizontal overflow.
- [x] Recheck action hierarchy without changing behavior: browser smoke verification confirms **Choose images** remains the sole primary action, **Add again** stays visible, destructive actions remain secondary, clear confirmations open/cancel, focus order is unchanged, and visible controls are at least 45 px high.
- [x] README update is not applicable because visible labels and instructions did not change. `npm --workspace @narumitw/pi-image-drop run check`, `npm test` (693 passing), `npm run check` (693 passing), and `git diff --check` pass; final scope is Image Drop web UI/tests and this plan.

## Risks

- Suppressing a repeated note too broadly could hide resize or conversion evidence; match only the exact shared metadata-removal note and test mixed-note cards.
- `auto-fit` can make a single card excessively wide; verify low-count states and add a bounded grid/card rule if the rendered result weakens preview readability.
- Shortening the empty state can remove useful next-step guidance; preserve explicit direction to choose images and keep ready/blocked/queued guidance unchanged.

## Completion Checklist

- [x] Empty, processing, blocked, ready, queued, and closed draft states remain unambiguous, verified by exhaustive `web-state.test.ts` assertions and rendered browser-state inspection at 320 px.
- [x] Metadata removal is communicated once without losing item-specific conversion, resize, processing, or error details, verified by mixed-note rendering tests and browser inspection.
- [x] History heading, count, retention detail, and **Clear history** scan as one group, and 0/1/3/8-card grids have no accidental empty track or horizontal overflow, verified at 320, 620, 1120, and 2000 px.
- [x] File selection, paste/drop, preview, reorder, re-stage, delete, clear, stale-tab, and session-ended event wiring is unchanged; browser smoke and the full 693-test integration suite verify visible actions, dialogs, lifecycle paths, and at least 44 px targets.
- [x] Dark mode, reduced motion, and 200%-equivalent narrow reflow preserve content and controls; Chrome media emulation produced dark tokens (`#10131a`/`#edf1f8`), zero-second drop transitions, and zero overflow at 320 px.
- [x] The bounded change passes `npm --workspace @narumitw/pi-image-drop run check`, `npm test`, `npm run check`, and `git diff --check`, with final diff inspection showing only Image Drop web UI/tests and this plan.
