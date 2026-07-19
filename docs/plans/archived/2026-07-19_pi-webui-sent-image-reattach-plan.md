## Goal

Allow users to reattach sanitized images from a recent browser-originated user message through a contextual `Attach again` action, with explicit bounded in-memory retention. Success means reuse is convenient without implying permanent transcript image storage or retaining original uploads.

## Context

WebUI currently projects sent images as MIME-type chips and discards source bytes after message acceptance. Image Drop retains sanitized provider-ready bytes per live session and supports Add again. This plan depends on server-side image staging and should follow memory draft recovery so ownership and revisions are stable.

## Resolved Decisions

- Under the maintainer directive to implement this plan, retention is opt-in and defaults to 32 images/128 MiB with hard ceilings of 128 images/512 MiB. The server additionally reconciles retained, current-draft, and conservative in-flight image bytes under one aggregate resident-image budget.

## Architecture

Maintain a FIFO `SentImageStore` keyed by a non-sensitive internal image ID associated with projected browser-originated user messages. Store only sanitized provider-ready bytes and display metadata. Transcript image chips expose `Attach again` only while bytes remain. Reattachment clones bytes into the current draft under its normal count/byte limits; eviction changes the action to an `Expired` status rather than failing unexpectedly.

## Non-Goals

- Reconstructing bytes from historical Pi session entries, retaining terminal-origin images, disk/browser persistence, remote downloads, or retracting provider data.
- A global image gallery or Image Drop-style history section.

## Plan

- [x] Resolve and record conservative retention policy under the maintainer directive to implement this plan: retention is opt-in (`retainSentImages: false`), defaults are 32 images/128 MiB, and hard ceilings are 128 images/512 MiB; settings tests and README document the decision.
- [x] Add failing store tests for sanitized-only admission, message association, FIFO count/byte eviction, duplicate sanitized hashes, cloning into drafts, deletion, clear, session shutdown, and no source-byte retention; compilation first failed because `src/sent-images.ts` was absent and all seven focused tests now pass.
- [x] Implement a separate bounded sent-image store with session-keyed opaque IDs and independent sanitized-byte clones; references alone retain no bytes, commit occurs only after accepted send, and focused tests cover late failure, deduplication, eviction, and shutdown.
- [x] Extend conversation projection with trusted opaque retained-image IDs only for accepted browser messages; conversation/lifecycle tests prove terminal-forged IDs are stripped and public snapshots contain metadata/IDs but no bytes.
- [x] Add authenticated revisioned preview, reattach, delete, and clear endpoints; server tests cover failed-send non-admission, stale-tab rejection, pending-send rejection, draft revisions, duplicate rejection, ordered cloning, and expiration.
- [x] Render contextual `Attach again` on eligible image chips and `Expired` when evicted/forgotten; reducer, transcript, lifecycle, and UI-contract tests cover eligibility and terminal-origin absence with labeled 44 px keyboard controls.
- [x] Add contextual `Forget` beside eligible chips plus the revisioned clear API, while UI contract and desktop/narrow browser inspection confirm there is no permanent gallery.
- [x] Document opt-in retention, aggregate/FIFO byte accounting, session-only lifetime, refresh/takeover behavior, and non-retraction of provider content; `npm run check` passed 787 tests, `git diff --check` and `just pack webui` passed, and 1280×900/320×900 Chrome smoke verified Attach again, refresh recovery, draft cloning, Forget/Expired, and responsive controls.

## Risks

- Retained image bytes can dominate process memory; enforce one global WebUI resident-byte budget across current draft, in-flight work, and sent retention.
- Transcript IDs may outlive bytes after eviction; represent availability explicitly and never promise recovery from Pi session files.
- Reattaching during a pending send can mutate the wrong attempt; target an exact draft revision and preserve newer work.

## Rollback / Recovery

Removing this feature only clears ephemeral retained bytes and contextual actions; no persisted migration is required.

## Completion Checklist

- [x] Accepted retention policy and limits are recorded in settings constants, tests, this plan, and README under the directive to implement the plan.
- [x] Only sanitized provider-ready bytes are retained and bounded; eight focused store tests cover count/byte/aggregate accounting, deduplication, deletion, and shutdown cleanup.
- [x] Eligible, expired, terminal-origin, stale-tab, pending-send, and eviction states are verified by projection, lifecycle, server, reducer, UI-contract, and browser tests.
- [x] Reattachment preserves selected order and normal draft limits without mutating prior messages, verified by attachment/store/server lifecycle tests.
- [x] `npm run check`, `git diff --check`, and `just pack webui` pass; package dry-run includes `src/sent-images.ts` and all expected WebUI assets.
