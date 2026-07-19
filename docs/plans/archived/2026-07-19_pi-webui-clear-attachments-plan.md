## Goal

Add a compact, safe way to remove every unsent WebUI attachment without clearing message text. Success means users with several images avoid repetitive deletion while retaining control, clear feedback, and recovery from accidental activation.

## Context

WebUI currently exposes one Remove action per thumbnail. Image Drop offers a confirmed Clear all action, but WebUI's composer should not add a permanent destructive control when only zero or one image is attached.

## Architecture

Keep clearing as a browser-draft mutation. Show a secondary `Clear attachments` action only when at least two attachments exist. Use a native confirmation dialog for the first implementation rather than inventing undo persistence; confirmation must state the count and must not affect text.

## Non-Goals

- Clearing transcript images, server-retained sent images, message text, or Pi session content.
- Browser storage or an undo system.

## Plan

- [x] Add failing state/DOM tests for visibility at two images, cancellation, confirmed image-only clearing, text preservation, pending/stale disabling, outbox invalidation, preview closure, and object-URL revocation; `npm test` failed before implementation because the clear state helper and dialog were absent.
- [x] Add the contextual secondary action and native dialog to `src/web/index.html`, wire it in `src/web/app.js`, and keep state mutation in a pure helper; Chrome smoke verified count-specific copy and initial focus on Cancel.
- [x] Preserve focus after cancel/confirm, support Escape, and ensure the action does not compete visually with Send/Queue next; Chrome smoke caught and verified the requestAnimationFrame focus-restoration fix with no 320 px overflow.
- [x] Update the README image workflow to document individual removal and confirmed multi-image clearing.
- [x] Run the WebUI workspace check, root tests/check, `git diff --check`, and package dry run; all 745 tests pass and the package preview contains 18 intended files.

## Risks

- Revoking preview URLs before confirmation would break cancellation; release resources only after the confirmed state transition.
- Clearing while an idempotent send attempt exists could retry removed images; invalidate any unsent outbox when the draft changes.

## Completion Checklist

- [x] Confirm, cancel/Escape, stale, pending, and preview cleanup states are verified by state/contracts plus Chrome dialog interaction smoke.
- [x] Clearing removes only unsent attachments and releases every corresponding object URL, verified by reducer tests and Chrome observing two revocations while preserving text.
- [x] Send remains the sole primary composer action, verified by UI inspection and the secondary clear action at 320 px.
- [x] `npm run check`, `git diff --check`, and `just pack webui` pass with 745 tests and 18 package files.
