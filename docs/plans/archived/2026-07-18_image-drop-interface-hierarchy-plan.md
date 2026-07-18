## Goal

Make the Image Drop browser page explain the Pi handoff clearly, prioritize the next-message draft over session history, and use space and destructive-action emphasis more effectively without changing upload, staging, history, security, or retention behavior. Success means a user can identify what to do now, what will happen next, and which images were already sent across empty, processing, ready, queued, error, and history states.

## Context

- The page is a framework-free local web UI implemented in `extensions/pi-image-drop/src/web/index.html`, `app.js`, `state.js`, and `styles.css`.
- Pi remains the canonical place for composing and sending messages; Image Drop intentionally has no prompt field or send/attach action.
- The current screenshot and source show an oversized 260 px drop zone, a visually detached generic **Details** disclosure, always-visible disabled clear actions in empty states, prominent red destructive controls, dense retention copy, and no direct next-step instruction beside the staged-image status.
- Existing keyboard reordering, drag-and-drop, paste-anywhere, previews, upload/error states, history re-staging, confirmations, dark mode, reduced motion, and session-disconnection behavior must remain available.

## Non-Goals

- Do not add a prompt editor, send button, automatic browser-to-Pi navigation, persistent browser storage, localization system, new settings, or server/API behavior.
- Do not change image processing, batch limits, history eviction, authentication, active-tab leases, or Pi lifecycle semantics.
- Do not remove detailed conversion, metadata-removal, resize, error, or retention information when it is relevant.

## Assumptions

- The primary user is already running an interactive Pi session and opened this page from Pi's one-time link.
- Current desktop browsers and the existing 280 px minimum viewport remain the supported browser baseline.
- Because the page cannot reliably focus or navigate back to the originating terminal, the handoff should be instructional text rather than a speculative **Return to Pi** control.

## Plan

- [x] Add focused web contract/helper tests before changing the UI: assertions now cover concise empty/history summaries, every draft-guidance branch, **Session details**, hierarchy labels, hidden empty clear actions, and secondary destructive card actions. Red evidence: direct `web-state.test.ts` run failed on the old history label/missing `draftGuidance`; direct server execution cannot resolve NodeNext `.js` imports without the root compile harness and will be verified through `npm test`.
- [x] Restructure `src/web/index.html` so the reading order is purpose and session context → compact image picker → **Ready for next message** draft status and guidance → **Previously sent** history → concise privacy note. **Session details**, headings, live regions, controls, and dialogs were verified by source review, browser accessibility inspection, and the passing server asset-contract test.
- [x] Extend `src/web/state.js` with deterministic presentation helpers for draft guidance and concise history summaries. `draftGuidance` now covers empty, editing, blocked/error, ready, reserved, and closed phases; `summarizeHistory` separates concise status from retention usage. All branches pass in `test/web-state.test.ts`.
- [x] Update `src/web/app.js` to render guidance/retention detail, hide empty clear controls, and use secondary destructive card actions. Browser smoke evidence covered empty, ready, processing-error/retry visibility, sent history, keyboard re-stage/reorder, preview, both clear confirmations, stale-tab, and session-ended states; all server/helper tests pass.
- [x] Revise `src/web/styles.css` with a 160 px horizontal desktop picker, stacked mobile picker, stronger draft guidance, separated lower-emphasis history, and transparent secondary destructive actions. CDP viewport checks at 320, 620, 1120, and 2000 px found no horizontal overflow and minimum 44 px targets; screenshots verified responsive, dark, and reduced-motion presentations.
- [x] Tighten user-facing copy in `index.html` and generated status text while preserving provider-transfer, local-history, retention, and session-end meaning. Capacity/eviction is secondary, the Pi handoff is explicit, and `README.md` now uses the visible **Previously sent** label.
- [x] Run accessibility and interaction checks in Chrome using a local compiled server harness: simulated file-input selection, paste, drag/drop and active feedback; trusted keyboard focus/Space activation and reorder; preview click and Escape dismissal; processing-error/retry visibility; history re-stage/delete availability; cancel/confirm paths for both clear dialogs; stale-tab/session-ended overlays; 320 px reflow (also representing a 200% zoom CSS viewport); and held CDP dark/reduced-motion media emulation. Focus outlines and 44 px targets were measured in rendered styles.
- [x] Run package and repository verification: the workspace check passed, `npm test` passed 688 tests, and the final `npm run check` passed Biome, boundary checks, all workspace typechecks, and 688 tests. `git diff --check` passed and diff inspection showed only Image Drop UI/tests/README plus this plan.

## Risks

- Shortening retention and privacy copy could conceal consequential lifecycle behavior; preserve the full meaning in nearby secondary text or **Session details**.
- Hiding disabled destructive controls can cause layout movement when images appear; reserve a stable toolbar alignment where necessary and test the transition rather than optimizing only static screenshots.
- Making history too quiet could make **Add again** hard to discover; keep the history heading, count, cards, and contextual action visible whenever history exists.
- Global paste/drop listeners may surprise users if future editable fields are added; this plan adds no editable field, but browser tests should confirm current keyboard and file-input behavior remains unchanged.

## Completion Checklist

- [x] The empty page presents one dominant compact image-selection task with hidden empty clear controls, verified by `/tmp/image-drop-empty-desktop.png`, the 320/620 px browser layouts, and rendered focus/target inspection.
- [x] Every draft lifecycle state communicates current status and the next valid action without relying on color, verified by exhaustive `web-state.test.ts` assertions plus `/tmp/image-drop-ready-desktop.png` and `/tmp/image-drop-error.png` browser evidence.
- [x] Previously sent images remain previewable, keyboard re-stageable, individually deletable, and confirmed-clearable while visually secondary to the draft, verified by browser interaction, `/tmp/image-drop-history-desktop.png`, and passing server/history tests.
- [x] Working-directory, privacy, provider-transfer, retention-limit, automatic-eviction, and session-end information remains discoverable and accurate, verified against `index.html`, rendered browser text, session overlays, and `README.md`.
- [x] Keyboard operation, visible focus, dialogs, live status/error announcements, dark mode, reduced motion, 200%-equivalent reflow, and 320–2000 px layouts were browser-verified with no lost control or horizontal overflow; evidence includes `/tmp/image-drop-history-320.png`, `-620.png`, `-2000.png`, and `/tmp/image-drop-dark-reduced.png`.
- [x] The complete change passes `npm --workspace @narumitw/pi-image-drop run check`, `npm test` (688/688), and final `npm run check` (Biome, boundaries, all typechecks, 688/688 tests); final output is recorded in `/tmp/image-drop-final-check.log`.
