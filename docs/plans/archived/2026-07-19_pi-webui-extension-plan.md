## Goal

Add a new lightweight Pi extension that exposes `/webui`, serves a private loopback chat page for the current terminal-owned Pi session, streams the session's semantic conversation and execution events into that page, and sends browser text/images back into the same Pi session. Success means terminal and browser users see the same accepted messages and agent/tool lifecycle without attempting to mirror ANSI/TUI pixels.

## Context

- `@narumitw/pi-web@0.5.0` already exists in a separate AGPL repository and provides a much broader web application. A distinct package avoids replacing it, inheriting its product scope, or creating a versioning collision with this monorepo's shared `0.20.x` release line.
- Working package identity: `@narumitw/pi-webui` in `extensions/pi-webui/`; the user-facing command remains the short `/webui`.
- `pi-image-drop` provides proven patterns for session-owned loopback startup, one-time bootstrap links, per-server cookies, exact Host/Origin checks, SSE, stale-client leases, bounded image processing, and teardown. Reuse patterns where appropriate, but do not couple the two extension runtimes or copy code from the separate AGPL `pi-web` package.
- Pi extensions expose semantic message/tool lifecycle events and `pi.sendUserMessage()`, but not the final ANSI-rendered terminal screen. Browser rendering will therefore be equivalent in meaning, not pixel-identical to the TUI.

## Architecture

- `src/webui.ts`: extension entrypoint and registration.
- `src/runtime.ts`: current-session ownership, `/webui`, Pi event projection, browser-send routing, generation guards, and teardown.
- `src/conversation.ts`: serializable transcript snapshot, monotonic event sequencing, pending browser-message state, and bounded reconnect buffer.
- `src/server.ts`: random-port `127.0.0.1` HTTP server, bootstrap authentication, API routes, SSE clients, request deduplication, and shutdown.
- `src/images.ts`: bounded signature-based PNG/JPEG/WebP/GIF processing to provider-ready image content, metadata removal, pixel/byte limits, and optional resizing.
- `src/web/`: framework-free accessible transcript, tool cards, connection state, image previews, and composer.
- Initial page load receives an authenticated snapshot from the active branch; subsequent SSE records carry ordered semantic deltas. A sequence gap or reconnect requests a fresh snapshot rather than guessing state.
- Browser sends default to immediate delivery while Pi is idle and `followUp` while busy. Steering is a separate explicit action. Terminal input remains independent and is projected back through the same Pi events.

## Non-Goals

- Pixel/ANSI mirroring, remote PTY control, or synchronization of unsent terminal editor text.
- LAN/public binding, cloud relay, multi-user access, or authentication beyond the one local Pi session.
- Session browsing, switching, forking, model/settings control, file browsing, shell terminal, git UI, task boards, or other features from the existing `@narumitw/pi-web` application.
- Persistent browser history, transcript duplication outside Pi's session, sent-image history, exotic image codecs, or automatic OS browser launch.
- Rendering arbitrary custom TUI components or built-in dialogs in the browser.

## Assumptions

- “Lightweight” means one current-session chat surface with no React/Vite/Fastify stack; Node HTTP, SSE, TypeScript, framework-free browser assets, and `sharp` for bounded image sanitation are acceptable.
- Tool arguments/results are visible by default in compact summaries with full content behind explicit disclosure; model thinking is hidden by default because terminal expansion state is not exposed and thinking may contain sensitive material.
- `/webui` starts or reuses one session-owned server and displays a rotating one-time link without launching a browser.

## Plan

- [x] Scaffold `extensions/pi-webui/` with `@narumitw/pi-webui`, shared repository version, MIT license, Pi peer/dev dependencies, `sharp`, published source/web assets, README, and TypeScript config; the root runner produced the intended missing-entrypoint red state before implementation and now includes the package tests.
- [x] Specify the conversation projection in failing `test/conversation.test.ts` cases for initial active-branch snapshots, text/thinking/tool content, partial assistant replacement, tool correlation, monotonic sequence numbers, bounded replay, duplicate event suppression, and snapshot recovery after a sequence gap; the focused conversation suite passes 7/7 after the intended missing-module red state.
- [x] Specify runtime behavior in failing `test/lifecycle.test.ts` cases for lazy single-flight startup, rotating links, terminal-originated message projection, idle browser sends, busy default follow-up, explicit steer, send failures, session replacement/reload, stale contexts, and shutdown; the focused lifecycle suite passes 8/8, with duplicate IDs and empty requests covered by server tests.
- [x] Specify the authenticated server in failing `test/server.test.ts` cases for random loopback binding, per-server bootstrap cookie names, one-time token exchange, exact Host and mutation Origin, active-tab lease, body limits, no-store/CSP/referrer/frame headers, snapshot/event/send routes, SSE disconnects/backpressure, request cancellation, stale sequence recovery, and deterministic connection closure; the focused server suite passes 10/10 and root execution resolves source assets from compiled tests.
- [x] Specify image handling in failing `test/images.test.ts` cases for browser paste payloads, byte and pixel ceilings, signature/MIME mismatch, corrupt input, supported PNG/JPEG/WebP/GIF output, metadata removal, resize bounds, aggregate prompt limits, cancellation, and current model/`images.blockImages` guards; the focused compiled suite passes 6/6 after the intended missing-module red state.
- [x] Build the framework-free page against a tested state reducer: session/project context and connection status at top, chronological transcript in the main region, collapsed tool details, hidden-by-default thinking disclosure, and a sticky composer with image paste/drop/previews, **Send next**, and a busy-only secondary **Steer** action; 10 reducer/DOM contract tests pass and Chrome rendered terminal-origin, browser-origin, tool, follow-up, steer, and image states.
- [x] Add browser recovery and accessibility behavior for reconnect/snapshot replacement, stale tabs, session-ended state, pending/accepted/rejected messages, send retry without duplicate delivery, keyboard-only image removal/send, semantic live regions, visible focus, non-color statuses, reduced motion, 200% text reflow, and narrow layouts; contracts pass, Chrome verified reconnect and stale takeover, dark/reduced media, zero overflow at 320 px and 200% text, 44 px controls, and `/tmp/pi-webui-320-200.png`.
- [x] Perform a holistic edge-case pass across simultaneous terminal/browser input, multiple tabs, rapid double-send, SSE reconnect during streaming, tool-output growth, abort/error boundaries, model changes, session replacement, reload, and shutdown; the pass added bounded property traversal and lease-aborted sends, found/fixed empty SSE headers that left EventSource reconnecting, and expanded focused coverage to 7 conversation, 10 server, and 8 lifecycle tests, including tree-navigation resync and session renames. Compaction uses the same message/activity events and requires no separate protocol state.
- [x] Document install, `/webui` workflow, immediate/follow-up/steer semantics, semantic-not-pixel synchronization, image limits, thinking/tool privacy, loopback security, one-active-tab behavior, lifecycle cleanup, supported browsers, remote port forwarding limitations, and the distinction from `@narumitw/pi-web` in `extensions/pi-webui/README.md`; package paths and commands match the manifest and root recipes.
- [x] Integrate the workspace into root `pack:webui`, named `just` pack/try/install/publish aliases, root package/use-case/development/structure documentation, and the lockfile; boundary checks discover 19 active packages, `just --list` shows all four aliases, and `just pack webui` contains exactly 13 intended manifest/license/README/source/web files with no tests, fixtures, caches, tarballs, or `node_modules`.
- [x] Run `npm --workspace @narumitw/pi-webui run check`, focused and root tests, `npm run check`, `git diff --check`, `just pack webui`, and a latest-Pi runtime smoke with an isolated agent directory; final `npm run check` passes all 737 tests, pack contains 13 intended files, Pi 0.80.10 loads `/webui`, and Chrome verified terminal-originated, idle browser, queued follow-up, steer, image, reconnect, stale-tab, and shutdown flows.

## Risks

- Pi events do not expose every TUI-only visual or interaction; documentation and UI copy must say “session sync,” not “terminal mirror.”
- Browser and terminal can submit concurrently; serialized request IDs, Pi delivery modes, and event-derived acceptance state must prevent duplicate or falsely confirmed messages.
- Streaming tool output can be large and frequent; coalesce replaceable updates, cap replay memory, apply display truncation, and recover from sequence gaps with snapshots.
- Tool results, thinking, local paths, and images may be sensitive even on loopback; retain no browser storage, hide thinking by default, authenticate every endpoint, and never expose the listener beyond `127.0.0.1`.
- Reusing the short `/webui` command may collide with another installed extension; Pi's command suffixing remains the fallback, and the README must identify the registered command provenance.

## Completion Checklist

- [x] One terminal Pi session and its authenticated browser page exchange text and supported images in both idle and busy states, verified by 8 lifecycle tests and the Pi 0.80.10/Chrome smoke matrix.
- [x] Initial history, assistant streaming, final messages, tool execution, errors, queue/activity state, branch resync, reconnect, and session end are semantically synchronized, verified by conversation/server tests and browser inspection.
- [x] The implementation never claims or attempts pixel-identical TUI mirroring, verified by source and README review with TUI-only states explicitly documented as unsupported.
- [x] Loopback authentication, mutation protection, bounded input/output/memory, active-tab leasing, duplicate-send prevention, and teardown pass 10 deterministic server tests plus lifecycle/image coverage.
- [x] The page remains operable by keyboard and at narrow/large-text/reduced-motion settings, verified by 12 reducer/DOM contracts and Chrome at 320 px, 200% text, dark mode, and reduced motion.
- [x] Package metadata, root integration, lockfile, and publish contents are correct, verified by the 19-package boundary check and `just pack webui` inspection of 13 intended files.
- [x] Package and repository quality gates pass with no unrelated changes, verified by explicit Biome, workspace check/typecheck, final `npm run check` (737/737), `git diff --check`, and final diff review.
