## Goal

Remove the visible **Close** button from Image Drop’s enlarged image preview and close the preview when the enlarged image is clicked again, while preserving accessible dismissal paths.

## Context

The preview dialog is defined in `extensions/pi-image-drop/src/web/index.html`, wired in `extensions/pi-image-drop/src/web/app.js`, styled in `extensions/pi-image-drop/src/web/styles.css`, and covered by the static asset contract in `extensions/pi-image-drop/test/server.test.ts`.

## Non-Goals

- Do not redesign the image cards or change how previews open.
- Do not change image staging, upload, ordering, or deletion behavior.
- Do not change the separate **Clear all** confirmation dialog.

## Assumptions

- Clicking the enlarged image itself should dismiss the preview.
- Existing dismissal by clicking the backdrop and pressing Escape should remain available.
- The enlarged image should remain keyboard-operable after removing the visible button.

## Plan

- [x] Update `extensions/pi-image-drop/test/server.test.ts` to specify that the preview has no visible Close button and exposes click-to-close behavior; focused `server.test.js` failed on the existing Close button before implementation.
- [x] Update `extensions/pi-image-drop/src/web/index.html` and `extensions/pi-image-drop/src/web/app.js` to remove the Close button, dismiss the dialog from the enlarged image, preserve backdrop/Escape dismissal, and provide keyboard semantics for the enlarged image; focused `server.test.js` passes all 14 tests.
- [x] Update `extensions/pi-image-drop/src/web/styles.css` so the enlarged image communicates click-to-close with an appropriate pointer cursor and retains visible keyboard focus; focused Biome check passes, with native button focus semantics preserved.
- [x] Run the Image Drop test coverage and package checks to confirm the behavior change does not regress server assets or TypeScript/style validation; `npm test` passed 678 tests, the workspace check passed, and the full `npm run check` gate passed.

## Risks

- Removing a labeled control makes dismissal less discoverable; retain Escape, backdrop dismissal, keyboard operation, and a zoom-out cursor to reduce that risk.
- A click handler attached too broadly could close the preview when users click the title area; scope it to the enlarged image only.

## Completion Checklist

- [x] The enlarged preview contains no visible Close button, verified by `extensions/pi-image-drop/test/server.test.ts` and inspection of `src/web/index.html`.
- [x] Clicking the enlarged image closes the dialog, verified by the focused 14-test server asset contract; browser smoke testing was unavailable in this environment.
- [x] Backdrop click, native Escape dismissal, and native button keyboard dismissal remain functional, verified by the source-level asset contract and semantic `<dialog>`/`<button>` markup; browser smoke testing was unavailable.
- [x] Image Drop tests and package checks pass with no unrelated files changed, verified by `npm run check`, the workspace check, and `git diff -- extensions/pi-image-drop`.
