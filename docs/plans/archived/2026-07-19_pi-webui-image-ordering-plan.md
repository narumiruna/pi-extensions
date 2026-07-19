## Goal

Let WebUI users deliberately order multiple image attachments before sending, using both pointer drag-and-drop and visible keyboard controls. Success means the provider receives images in exactly the displayed order without changing text, delivery mode, retry identity, or newer draft edits.

## Context

The browser already preserves insertion order, previews each image, and removes individual attachments. Image Drop demonstrates drag ordering plus arrow controls, but WebUI should retain its compact composer rather than adopt a card grid.

## Architecture

The browser draft remains the owner in this phase. Add immutable ordering helpers to `src/web/state.js`; render contextual move controls on each thumbnail; snapshot the current ordered array in `prepareSend()` so pending or failed attempts retain their original order.

## Non-Goals

- Server-owned drafts, upload progress, per-image processing state, or sent-image history.
- Reordering transcript messages or attachments after Pi accepts a message.

## Plan

- [x] Add failing reducer tests in `extensions/pi-webui/test/web-state.test.ts` for moving before/after, arrow moves, first/last no-ops, unknown IDs, immutability, and send-attempt order snapshots; `npm test` failed before implementation because `moveImage` was absent.
- [x] Implement bounded immutable ordering helpers in `src/web/state.js` and wire drag and arrow actions in `src/web/app.js`; reducer/contracts verify pending/stale locking and failed retries retain the frozen attempt until ordering changes the draft.
- [x] Update `src/web/index.html`/`styles.css` so ordering controls are secondary/contextual, have text-equivalent accessible names, retain at least 44 px pointer targets where visible, and do not obscure thumbnails at 320 px or 200% text; Chrome CDP measured 44 px-wide controls and no document overflow.
- [x] Add DOM/static contracts for drag data, keyboard button labels, focus preservation after a move, stale/read-only behavior, and object-URL cleanup; all 744 tests pass and Chrome preserved focus after arrow ordering.
- [x] Document that image order is provider order in `extensions/pi-webui/README.md`; reducer/send tests verify the attempt snapshots the displayed array order.
- [x] Run the WebUI workspace check, root tests/check, `git diff --check`, and `just pack webui`; all 744 tests pass and the 18-file package preview contains the intended WebUI runtime.

## Risks

- Hidden drag-only behavior would be inaccessible; arrow controls must remain discoverable through focus and labels.
- Re-rendering the list can lose focus; restore focus to the moved attachment/action after each operation.
- A send racing with reorder could mismatch UI and payload; freeze the ordered attempt before network mutation.

## Completion Checklist

- [x] Pointer and keyboard ordering produce the same deterministic array, verified by reducer tests and Chrome drag/arrow interaction smoke.
- [x] Immediate, follow-up, steer, failed retry, stale-tab, and pending-send paths preserve the expected order, verified by the 744-test `npm run check` run.
- [x] Narrow, 200% text, keyboard-focus, and reduced-motion contracts show no clipped controls or inaccessible ordering path; Chrome measured no 320 px document overflow.
- [x] `npm run check`, `git diff --check`, and `just pack webui` pass with only intended WebUI files and this plan changed.
