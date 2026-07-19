## Goal

Refine the Pi WebUI composer so attachment count, per-image state, ordering, removal, focus, and send priority are easier to scan without changing message delivery or attachment lifecycle behavior. Success means the composer remains compact and accessible from zero through the configured maximum number of images, with no duplicated routine status.

## Context

The current composer already supports an auto-growing textarea, server-staged images, per-item upload/processing/error/ready state, retry, keyboard ordering, drag ordering, removal, clear-all confirmation, dynamic image limits, and immediate/follow-up/steer delivery. The requested work is a bounded presentation pass over `src/web/index.html`, `src/web/app.js`, and `src/web/styles.css`.

## Non-Goals

- Changing attachment upload, sanitation, retention, draft persistence, lease, or send protocols.
- Changing configured image limits or introducing new settings.
- Replacing the framework-free browser UI or redesigning the transcript/session header.
- Removing keyboard ordering, drag ordering, retry, individual removal, or clear-all recovery paths.

## Plan

- [x] Lock the revised composer contract into `extensions/pi-webui/test/web-ui-contract.test.ts`: the focused test failed against the old summary/strip controls, then passed with dynamic summary, one metadata statement, separate live region, contextual ordering, reflow, focus, and subordinate Remove assertions; root `npm run check` passed all 798 tests.
- [x] Split visible attachment summary from transient announcements in `index.html`/`app.js`: Chrome inspection verified `1/8`, mixed processing, error/Needs attention, and `8/8` states while Ready stays on item cards and transitions use the hidden polite live region.
- [x] Clarify ordering controls in `app.js`: one-image smoke showed zero arrows; multi-image cards show `Order n of m`, earlier/later names and tooltips, first/last boundaries, optional drag, and keyboard reorder focus returned to the moved card's valid control.
- [x] Reduce destructive-action competition in `styles.css`: Remove remains a 44 px text action with transparent default styling, border/underline hover, and a visible focus ring; light/dark error smoke showed Retry above Remove while Send remained the sole primary action.
- [x] Replace the sparse strip with auto-fitting wrapping cards and narrow single-column reflow; seeded 8-image CDP checks at 960, 640, 375, and a 480 CSS-pixel/2× 200%-equivalent layout reported no page overflow, bounded cards, truncated long names, and 44 px controls.
- [x] Refine textarea focus to one compact 2 px ring while preserving the global 3 px control ring, logical keyboard traversal, 44 px targets, reduced-motion CSS, and preview-dialog focus return; Chrome light/dark focus smoke passed.
- [x] Update only the README Images and Accessibility wording for count summary, one-image omission, multi-image order context, earlier/later controls, drag shortcut, and keyboard support; no protocol or lifecycle claims were added.
- [x] Run `npm run check` (798 tests), `git diff --check`, and `just pack-webui`; the dry-run includes `src/web/index.html`, `app.js`, and `styles.css`, and line counts remain 995/932 respectively.

## Risks

- Separating visible status from the live region can create duplicate or missed screen-reader announcements; announce phase changes only in the live region and keep routine item details readable in place.
- Removing one-image reorder buttons changes focus targets; removal and retry must remain predictable after any asynchronous rerender.
- Wrapping cards can regress long filenames, localization, zoom, or the 280 px minimum viewport; test reflow rather than relying only on the supplied desktop screenshots.
- The displayed maximum must come from `model.imageLimits.maxImages` with the existing safe fallback, not a new hardcoded limit.

## Completion Checklist

- [x] Attachment summary and per-item state are non-duplicative and use the effective maximum, verified by contract tests plus ready/processing/error/max browser states.
- [x] One-image drafts omit meaningless reorder arrows, while multi-image drafts remain reorderable by keyboard and pointer, verified by existing boundary tests and Chrome focus/order smoke.
- [x] Send remains the sole prominent action and Remove remains visible but subordinate, verified in light, dark, narrow, hover, focus, disabled, and error states.
- [x] No upload, draft, lease, retry, ordering, clear, or delivery behavior changed; existing WebUI state, server, lifecycle, and UI suites passed under the 798-test root check.
- [x] Package assets and size constraints are verified by clean `git diff --check`, `just pack-webui`, tarball inspection, and 995/932-line app/style counts.
