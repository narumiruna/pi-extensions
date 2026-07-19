## Goal

Refine Pi WebUI into a readable, stable current-session chat surface while preserving its framework-free implementation, authenticated loopback protocol, delivery semantics, drafts, and accessibility. Success means long Pi responses scan like structured documents, streaming updates do not reset unrelated DOM state, users can recover their place in a live transcript, and text/image composition remains compact and predictable across desktop, narrow, dark, reduced-motion, stale-tab, and ended-session states.

## Context

- The browser UI lives in `extensions/pi-webui/src/web/index.html`, `app.js`, `state.js`, and `styles.css`; its contracts are covered by `test/web-state.test.ts` and `test/web-ui-contract.test.ts` plus server/lifecycle tests.
- The current screenshot shows raw Markdown punctuation, large bordered assistant cards, a tall sticky composer, weak disabled-action differentiation, and hidden paste/drop capability.
- `pi-image-drop` provides useful precedents for visual tokens, drag feedback, image containment, enlarged preview, status placement, dark mode, and narrow reflow. WebUI remains a continuous conversation rather than adopting Image Drop's hero drop zone, card grid, history, or destructive dialogs.
- The transcript currently rebuilds every DOM node on each event. This can reset open disclosures and selection, increase streaming cost, and make whole-transcript live-region announcements noisy.

## Architecture

- Keep the server/runtime protocol unchanged unless a UI state cannot be derived from the existing conversation, tool, lease, and activity payloads.
- Extract a small framework-free transcript renderer from `app.js` so keyed message/tool DOM reconciliation can be tested and maintained separately.
- Add a dependency-free safe-Markdown module that parses a deliberately limited subset and creates DOM nodes with `createElement()`/`textContent`; never render model text through `innerHTML`.
- Keep draft, delivery, lease, and sequence state in `state.js`. Keep viewport measurements, focus, dialogs, object URLs, and scroll behavior in browser rendering code.
- Reuse Image Drop's neutral spacing, border, focus, status, and dark-mode conventions while retaining WebUI's green accent unless implementation screenshots show an accessibility or hierarchy regression.

## Non-Goals

- Do not implement full CommonMark/GFM, tables, syntax highlighting, raw HTML, remote assets, or a Markdown dependency.
- Do not add image history, a permanent full-width drop zone, message editing/deletion, timestamps, search, session selection, terminal/ANSI mirroring, or persistence outside the live tab/process.
- Do not change immediate/follow-up/steer behavior, image limits/sanitization, authentication, active-tab ownership, replay, or session teardown semantics.
- Do not turn every response, image, or tool into an Image Drop-style card; use containers only where they communicate ownership, interaction, or state.

## Assumptions

- The primary user is operating Pi in a terminal and uses WebUI as a frequent browser companion on keyboard/pointer or touch.
- Safe external links should accept only `http:` and `https:`, open in a new tab to preserve the current draft/session, and use `rel="noopener noreferrer"`; every other scheme remains plain text.
- Assistant responses benefit from document-style open layout, while user messages remain visually bounded and tools remain disclosures.
- Screen-reader users should be able to navigate the transcript without hearing every streaming token; a dedicated live status can announce meaningful completion/new-update state instead.

## Plan

- [x] Establish regression-first UI coverage and a state matrix before changing presentation: added Markdown/security, transcript/tool, unseen-update, and browser-contract assertions; `npm test` produced the expected four red surfaces (missing Markdown/transcript modules, missing follow-state functions, and missing UI contract), with the supplied long-response screenshot and prior idle/running/image/stale/ended/dark/320 px Chrome smoke serving as baseline evidence.
- [x] Replace whole-transcript rebuilding with keyed reconciliation in `src/web/transcript.js`: message/tool nodes update in place and paints batch through `requestAnimationFrame`; `npm test` passes, Chrome preserved the same open tool node through a phase update, and an authoritative snapshot reduced 19 rendered messages to the one replacement branch message.
- [x] Add safe structured response rendering through dependency-free `src/web/markdown.js`: paragraphs, headings, lists, emphasis, strong text, inline/fenced code, blockquotes, and HTTP(S) links use DOM text nodes only; parser/security tests pass and Chrome rendered semantic headings/lists while leaving a `javascript:` link as inert text.
- [x] Add live-transcript recovery controls: follow/unseen state is deduplicated in `state.js`, the dedicated button reports new activity only away from the bottom, and Chrome verified a final message at scroll-top exposed **Jump to latest**, preserved position, then returned within the near-bottom threshold and cleared the cue.
- [x] Compact and clarify the composer without weakening delivery behavior: the textarea auto-grows from 48 px to a 32vh bound, idle/running labels are **Send**/**Queue next** with **Steer** secondary, disabled primary styling is neutral, and Chrome reconfirmed pending locking plus exact lost-response request reuse/draft recovery.
- [x] Bring image composition up to the relevant Image Drop standard: paste/drop/choose guidance, drag-active styling, contained 68 px thumbnails, count/metadata status, and an enlarged native dialog are implemented; Chrome pasted a PNG, opened/closed preview, cleared its image source, restored opener focus, and retained zero horizontal overflow.
- [x] Strengthen transcript hierarchy after behavior is stable: assistant output uses open document layout, user content remains a bounded bubble, tools are disclosures with `Running`/`Completed`/`Failed` labels and bounded command previews, and the refined 1440 px screenshot `/tmp/pi-webui-refined.png` confirms Markdown/tool hierarchy while transcript limit tests remain green.
- [x] Align header, status, and visual tokens with Image Drop where responsibilities match: the compact header keeps identity/connection visible, cwd moved to **Session details**, neutral/focus/danger/dark tokens now align, and Chrome verified coherent grouping and no overflow at 1440 and 320 px while retaining the green WebUI accent.
- [x] Finish accessibility and adaptation behavior: the transcript is navigable but no longer a token-level live region, a dedicated polite status announces completion, controls remain at least 44 px, preview close restores focus, and Chrome verified dark/reduced media, 320 px and 200%-equivalent zero-overflow reflow.
- [x] Update `extensions/pi-webui/README.md` for safe Markdown, keyed updates/jump-to-latest, paste/drop/preview, and delivery labels; `npm --workspace @narumitw/pi-webui run check`, `npm test`, `npm run check`, and `git diff --check` pass with 751 tests, while `just pack webui` contains the 15 intended runtime/package files including `markdown.js` and `transcript.js` and excludes tests/development output.

## Risks

- Incremental reconciliation can leave stale nodes after branch navigation or reconnect; treat snapshots as authoritative and test removal, reorder, and sequence recovery separately from append/update events.
- A custom Markdown subset can mishandle incomplete streaming delimiters or introduce XSS/link injection; keep parsing bounded and deterministic, prohibit raw HTML, validate protocols, and use DOM text nodes exclusively.
- Auto-follow can steal reading position, while disabling it without a cue can hide new work; define and test one near-bottom threshold plus an explicit unseen-update recovery control.
- A smaller composer can hide delivery or failure state; preserve routine status, errors, queued mode, image preparation, stale ownership, and session end adjacent to the input/actions.
- Dialog previews and incremental nodes can leak object URLs or focus; centralize preview ownership and cleanup on remove, send, replacement, dialog close, and teardown.
- Copying Image Drop too literally would over-containerize a continuous chat; reuse its system and interaction quality, not its page-specific hero/grid structure.

## Completion Checklist

- [x] Streaming updates preserve keyed message/tool DOM, unrelated open disclosures, focus, and reading position, verified by 751 passing tests and Chrome same-node/open-disclosure plus authoritative-branch scenarios.
- [x] Long responses render the agreed safe Markdown subset without executable HTML or unsafe links, verified by parser security fixtures, Chrome semantic DOM inspection, and source search finding `innerHTML` only in its negative contract assertion.
- [x] Users who scroll away from the bottom receive a visible unseen-update cue and can return predictably, verified by state tests and a Chrome scroll-top/final-message/jump recovery flow.
- [x] Composer states remain compact, unambiguous, and lossless for idle, busy, image-reading, pending, failure/retry, stale, disconnected, and ended states, verified by state/contract tests, a 48 px–32vh auto-grow bound, stale-tab smoke, and exact idempotent retry smoke.
- [x] Picker, paste, drop, thumbnail, enlarged preview, remove, send, and cleanup paths preserve image order and draft ownership, verified by existing image/server tests plus Chrome PNG paste, contained preview, dialog close/source cleanup, and opener-focus restoration.
- [x] Assistant, user, thinking, tool-running/completed/failed, and error content have distinct hierarchy without unnecessary cards, verified by Markdown/tool fixtures, Chrome running-to-completed disclosure preservation, and `/tmp/pi-webui-refined.png`.
- [x] Header/session context, status, primary action, blocking/recovery information, and privacy disclosure remain discoverable, verified by keyboard-visible labels and Chrome layout metrics at 320, 640, 920, and 1440 px.
- [x] Light, dark, reduced-motion, 200%-text, touch-target, and horizontal-overflow checks pass in Chrome: dark tokens resolved to `#10131a`, reduced media matched, all tested widths had zero overflow/minimum 44 px controls, and 32 px root text reflowed at 320 px without overflow.
- [x] `npm --workspace @narumitw/pi-webui run check`, `npm test`, `npm run check`, `git diff --check`, and `just pack webui` pass; the dry-run package includes all 15 intended files and both new runtime web modules.
- [x] The final scope is limited to Pi WebUI UI/runtime asset routing/tests/docs and this plan; completion evidence is recorded above and the plan is ready to archive under `docs/plans/archived/`.
