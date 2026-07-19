## Goal

Move WebUI attachment upload and image preparation ahead of message submission so each image has visible upload/processing/ready/error state, individual retry/removal, bounded progress, and cancellation. Success means Send never starts with an ambiguous batch and one failed image does not force users to reselect successful siblings.

## Context

WebUI currently holds browser `File` objects locally, encodes all images into one JSON message request, and processes the whole batch in `WebUIRuntime.sendBrowserMessage()`. Image Drop proves per-item reservation, raw bounded upload, processing queues, revisioned mutations, retry, and stale-lease cancellation.

## Architecture

Add a session-owned `AttachmentDraft` module separate from `runtime.ts` and `server.ts`. The server reserves IDs atomically, accepts one bounded raw upload per item, processes with limited concurrency, and publishes revisioned public state over the existing control/SSE channel. Browser state stores IDs and display metadata, not source Base64. Message send references an exact ready draft revision; runtime snapshots sanitized provider-ready bytes before calling Pi.

## Non-Goals

- Attaching staged images to terminal-authored prompts.
- Persisting drafts to disk/browser storage, sent-image history, or restoring drafts across Pi session replacement.
- Chunked resumable uploads across process restarts.

## Plan

- [x] Specify the item/batch state machine in failing unit tests: atomic reservation, count/source-byte limits, ordered IDs, upload, processing, ready, error, retry, delete, clear, revision mismatch, late completion, send reservation, and close; `npm test` failed before implementation because `src/attachments.ts` was absent, and the nine focused compiled attachment tests now pass. Protocol duplicate/lease/abort behavior remains specified in the server test task.
- [x] Implement `src/attachments.ts` with bounded resident bytes, source/provider-ready ownership, processing concurrency, immutable public snapshots, and idempotent cleanup; eight focused attachment tests pass and assert source release after processing plus remove, clear, accepted-send, failure-retry, and close transitions.
- [x] Replace message-embedded Base64 uploads with authenticated per-item reservation/raw upload/retry/delete endpoints in `src/server.ts`; 18 focused server tests pass for cookie, exact Host/Origin, lease, revision, actual body limits without trusted `Content-Length`, duplicate requests, cancellation, and protocol errors.
- [x] Integrate runtime processing and send preflight so only an exact all-ready snapshot can be submitted, Pi settings/model capability are revalidated at send time, accepted bytes transfer once, failed sends retain a retryable draft, and session teardown aborts every job; 20 lifecycle tests plus attachment send-reservation tests pass.
- [x] Extend `src/web/state.js` and `app.js` with per-image Uploading/Processing/Ready/Needs attention status, byte progress, Retry/Remove actions, and whole-batch send gating; reducer/contracts pass and Chrome smoke exercised processing, ready, error, retry, removal, and disabled/enabled Send states without modal alerts.
- [x] Show concise conversion/resize summaries only when they vary by item, while stating metadata removal once near the attachment collection; browser contracts and Chrome smoke verify per-item summaries and one collection notice.
- [x] Test page refresh, new-tab lease takeover, stale upload completion, duplicate upload, delete-during-processing, cancellation, reconnect gaps, session shutdown, and a newer draft created during a pending send; deterministic attachment/server/lifecycle/state tests pass, and Chrome refresh restored the authoritative ordered batch.
- [x] Update README protocol-visible behavior, privacy/memory ownership, retry workflow, and limitations; `npm run check` passes 760 tests, `git diff --check` passes, and `just pack webui` contains 19 intended runtime files.

## Risks

- This is the highest-risk image change because it changes protocol, memory ownership, and send lifecycle; split `attachments.ts` rather than growing `runtime.ts` or `server.ts` beyond clear responsibility boundaries.
- Source and processed bytes can coexist; enforce one combined resident-byte budget and release originals immediately after successful sanitation unless needed for an explicit retry/reprocess contract.
- Lease changes can leave asynchronous native work alive; generation/revision checks must discard late output after abort.

## Rollback / Recovery

Keep the old one-request send protocol behind no compatibility promise during development, then remove it before release. If staging cannot pass lifecycle/security review, revert the feature as one bounded change and retain the existing browser-local path.

## Completion Checklist

- [x] Every attachment state and cleanup transition is verified by nine attachment tests with explicit resident-byte assertions.
- [x] Auth, lease, revision, request-size, cancellation, stale completion, duplicate, and shutdown boundaries are verified by 18 server tests and 20 lifecycle tests.
- [x] Immediate, follow-up, steer, failed-send retry, and newer-draft preservation are verified by lifecycle, server, attachment, and reducer tests.
- [x] Desktop and 320 px Chrome smoke plus browser contracts verify status, retry, removal, progress, ordering, send gating, refresh recovery, focus restoration, 44 px controls, and no horizontal overflow.
- [x] `npm run check` passes 760 tests, `git diff --check` and `just pack webui` pass, the package has 19 intended files, and all final source files remain below 1,000 lines.
