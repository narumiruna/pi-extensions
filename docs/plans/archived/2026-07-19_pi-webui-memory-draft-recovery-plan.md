## Goal

Preserve an unsent WebUI text-and-image draft across browser refresh and active-tab takeover using only Pi-process memory. Success means the newest authorized tab resumes one authoritative draft without browser storage, cross-session leakage, or stale-tab overwrites.

## Context

Conversation snapshots intentionally preserve the current browser-local draft during reconnect, but a full page refresh loses it. Image Drop keeps its batch in the session-owned server and transfers editing authority through a lease. This plan depends on the server-side image staging plan so attachment bytes and status already have a canonical server owner.

## Architecture

The server owns a revisioned draft containing text plus ordered attachment references. The active tab sends bounded patch/replace mutations with expected revision and client lease. `/api/state` and SSE snapshots return draft state to authenticated clients; stale tabs can read but not mutate. Text updates must be debounced and serialized in browser order, while attachment operations remain explicit protocol mutations.

## Non-Goals

- localStorage, sessionStorage, IndexedDB, files, or transcript persistence.
- Draft recovery after Pi reload/new/resume/fork/shutdown.
- Synchronizing with Pi's terminal editor or attaching to a terminal-authored prompt.

## Plan

- [x] Add failing draft-store tests for text revisions, ordered attachment references, stale revisions, duplicate mutation IDs, clear-after-accepted-send, failed-send retention, newer edits during send, lease takeover, close, and memory cleanup; compilation first failed because `src/drafts.ts` was absent and all seven focused tests now pass.
- [x] Add a focused `DraftStore` without coupling it to conversation projection; immutable snapshots, revisioned/deduplicated mutations, bounded UTF-8 text, send snapshots, and idempotent memory cleanup are verified by the focused tests.
- [x] Add authenticated draft read/mutation protocol paths to `src/server.ts`, enforcing exact Origin/Host, cookie, active lease, expected revision, request IDs, UTF-8/body bounds, and stale-client errors; 20 server tests pass, including dedicated draft protocol coverage.
- [x] Update browser state/app to hydrate from the authoritative draft, serialize debounced text writes, reconcile revision conflicts from a fresh snapshot, and never let stale responses overwrite newer local input; reducer tests cover delayed acknowledgements and browser smoke verified refresh recovery.
- [x] Update send lifecycle so the accepted attempt clears only the exact sent text/attachment revision while preserving edits made during the request; server tests verify pending-send edits and failed retention, while lifecycle tests retain immediate/follow-up/steer coverage.
- [x] Test refresh, network reconnect, second-tab takeover, old-tab mutation, browser close/reopen, processing attachment, pending send, session replacement, and shutdown; deterministic store/server/state/lifecycle tests pass and Chrome smoke verified refresh, takeover/read-only state, pending-send typing, and authoritative recovery.
- [x] Update privacy documentation to state that unsent drafts live only in the Pi process until cleared or the session ends; `npm run check` passes 771 tests, `git diff --check` passes, and `just pack webui` contains 20 intended runtime files.

## Risks

- Debounced text and explicit image mutations can reorder; use one browser mutation queue and server revisions.
- A snapshot can erase keystrokes typed after the request began; merge only by acknowledged revision and preserve unsent local operations.
- Server ownership increases sensitive in-memory retention; clear on exact send acceptance, explicit clear, lease-independent session teardown, and configured bounds.

## Rollback / Recovery

Because no persistent migration exists, rollback restores browser-local drafts and drops only unsent in-memory server drafts on process/session end.

## Completion Checklist

- [x] Refresh and tab takeover restore the same authoritative text, order, status, and attachments, verified by server/state tests and Chrome browser smoke.
- [x] Out-of-order acknowledgements, stale revisions, old tabs, pending sends, and newer edits cannot lose or duplicate draft content, verified by reducer, store, and server race tests.
- [x] No browser or disk persistence is introduced, verified by source inspection, Chrome reporting zero local/session/IndexedDB entries, and shutdown cleanup tests.
- [x] `npm run check` passes 771 tests, `git diff --check` passes, and `just pack webui` contains 20 intended runtime files.
