## Goal

Keep successfully sent images available within the same Pi session so users can browse them and add them to a future batch again. Release all retained content when leaving, replacing, forking, reloading, or shutting down the session, while keeping every image exclusively in Pi process memory.

## Context

- A matching `message_start` currently calls `BatchStore.commitReservation()`, which immediately clears the active items and their source/processed buffers.
- Merely keeping the active batch would attach those images to every later prompt and break the meaning of “Next Pi message.” Sent images therefore need to move into separate session history.
- `maxImages` and `maxBatchBytes` currently limit only one active batch. Retaining images across multiple sends without a session-wide limit would allow memory use to grow without bound.

## Architecture

`BatchStore` maintains two explicit regions:

1. `draft`: the sortable batch for the next Pi message, using the existing reservation and recovery flow.
2. `history`: images confirmed as sent by a matching `message_start`; these are never attached to prompts automatically.

A successful commit moves immutable, metadata-cleared, provider-ready images into history and then clears the draft. Browser state and APIs expose session-history projection, authenticated previews, restaging, single-item deletion, and clearing all history. Restaging creates a new draft item ID and retains the existing batch limits, deduplication, and pre-send `autoResize` reprocessing without modifying the history entry directly.

History stores only the sanitized bytes and display metadata required for reuse, never the original unsanitized files. Draft and history use measurable session memory accounting. When a limit is reached, the oldest history entries are removed in send order until the new draft can be accepted. New images must not be rejected because history is full, and active or reserved draft items must never be removed automatically. `BatchStore.close()` and the runtime’s existing session replacement and shutdown paths are the only terminal cleanup boundaries.

## Non-Goals

- Do not write images to files, databases, Pi session JSON, or browser storage.
- Do not reconstruct history from an existing Pi transcript or restore it across sessions.
- Do not attach history images to later prompts automatically.
- Do not change Pi or model-provider retention after an image has been sent to the provider.

## Assumptions

- “Retain” includes browser preview and an explicit **Add again** action; retaining invisible bytes alone has no user value.
- Only a matching user `message_start` counts as sent. A reservation restored after failed preflight or queued delivery must not enter history.
- Session history has bounded limits configured through `maxRetainedImages` and `maxRetainedBytes` in `pi-image-drop.json`.
- The maintainer accepted defaults of 128 images / 512 MiB and hard ceilings of 256 images / 1 GiB. At either limit, the oldest history is removed automatically using FIFO order, and new images must not be rejected because retained history is full.

## Plan

- [x] Complete the session memory-budget decision: each provider-ready image is below approximately 3.375 MiB; the existing default draft can retain approximately 40 MiB of source bytes plus 27 MiB of processed bytes, with another approximately 36 MiB of Base64 during reservation. The maintainer accepted `maxRetainedImages: 128` / `maxRetainedBytes: 512 MiB` defaults, `256` / `1 GiB` hard ceilings, and FIFO eviction of the oldest history instead of rejecting a new draft.
- [x] Add state-machine tests in `extensions/pi-image-drop/test/batch.test.ts` for matching commits, independent history, restage ordering and deduplication, delete/clear/stale revisions, FIFO count and resident-byte budgets, failed recovery, and `close()` cleanup; focused batch tests pass 14/14.
- [x] Refactor `extensions/pi-image-drop/src/batch.ts` with typed public history state, one shared monotonic revision, defensive Buffer copies, and draft-plus-history FIFO budget accounting; focused batch tests pass 14/14.
- [x] Add lifecycle tests in `extensions/pi-image-drop/test/lifecycle.test.ts` proving matching `message_start` commits, no automatic resend on the next prompt, restaged-image reprocessing under the current `autoResize` setting, and session replacement/shutdown cleanup; focused lifecycle tests pass 24/24.
- [x] Verify that the existing commit broadcast, draft-only widget, and teardown orchestration in `extensions/pi-image-drop/src/runtime.ts` correctly support the new history state; focused lifecycle tests prove history is not reported as pending in the widget and terminal cleanup works, without expanding the runtime surface.
- [x] Add authenticated history preview, restage, delete, and clear endpoints plus top-level history state in `test/server.test.ts` and `src/server.ts`; focused server tests pass 15/15 for cookie, Origin, lease, revision, duplicate-restage, and existing shutdown guards.
- [x] Update `src/web/state.js`, `index.html`, `app.js`, and `styles.css` with a **Sent this session** section, previews, **Add again**, delete, confirmed clear, memory usage/limit details, and FIFO/session-lifetime copy; web helper tests pass 5/5 and the server asset contract passes.
- [x] Update `src/settings.ts` and `test/settings.test.ts` with strict `maxRetainedImages` / `maxRetainedBytes` defaults, hard ceilings, warnings, and combined validation with `startOnSessionStart`; focused settings tests pass 3/3.
- [x] Update the workflow, privacy, configuration, and limitations sections in `extensions/pi-image-drop/README.md` to document session-only history, restage/delete actions, the 512 MiB / 1 GiB policy, FIFO eviction, and the absence of disk or browser persistence.
- [x] Incorporate the click-to-close preview behavior from PR #256 while resolving review comment `discussion_r3608498431`: the semantic dismiss button now has a definite stage-sized `width` and `height`, so tall images remain constrained to the fixed-height preview stage; focused server asset tests pass 15/15.
- [x] Run focused tests (75/75), `npm --workspace @narumitw/pi-image-drop run check`, root `npm run check` (686/686 tests), and `just pack image-drop` (15 expected files, no tests/fixtures/cache); a Chrome DevTools smoke verified tall-preview containment and click-to-close, rendered sent history, restaging, refresh retention, and terminal session invalidation, while lifecycle tests verified no automatic resend and empty replacement-session history.

## Risks

- Session history extends the in-memory lifetime of sensitive image bytes. The UI and README must explain this, and every terminal lifecycle path needs cleanup regression tests.
- Cloned Buffers, Base64 `ImageContent`, and preview responses may make actual heap/external memory exceed logical byte counts. The budget must account for resident representations rather than only original file sizes.
- When draft and history reference the same image content, deletion, restaging, reprocessing, or late async completion could cause use-after-delete, double accounting, or accidental byte retention. Ownership and generation/revision guards must remain explicit.
- FIFO eviction can remove old images without a manual action. The UI and README must show the limit and automatic-removal policy, and eviction may affect only history, never the active or reserved draft.
- `server.ts` already exceeds 600 lines. History routes should remain compact or move into route/state helpers before the file approaches the 1,000-line boundary.

## Rollback / Recovery

- This feature has no migration or persisted data. Reverting it restores the previous behavior, where matching `message_start` immediately clears the batch.
- If the history UI or API fails, history can be feature-disabled while preserving the draft/send flow, but shutdown cleanup must remain enabled.

## Completion Checklist

- [x] Sent images enter independent history only after a matching `message_start` and are not attached to the next prompt automatically, proven by batch and lifecycle tests.
- [x] The browser can preview, restage, delete, and clear session history, with auth, Origin, lease, and revision failures proven by server tests.
- [x] Draft and history follow the maintainer-approved bounded-memory policy, removing the oldest history with FIFO order at the limit without rejecting a new draft, proven by settings, batch, and server tests.
- [x] Refresh preserves history, while reload, session replacement/fork, and shutdown release all history and server state, proven by lifecycle tests and Chrome browser smoke testing.
- [x] The repository and package contain no new image cache, temporary image file, or browser persistence, proven by a clean persistence-API source search and the 15-file pack inspection.
- [x] README and browser privacy copy accurately describe memory lifetime, reuse, and limit behavior, proven by documentation and UI review.
- [x] Package checks, root tests, pack dry-run, and Chrome browser smoke testing all pass, with commands and results recorded in the final plan task.
