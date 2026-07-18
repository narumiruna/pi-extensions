## Goal

Add a production `@narumitw/pi-image-drop` package that exposes one `/image-drop` command, serves a session-scoped local image staging page, and attaches the page's ordered image batch to the next non-empty interactive Pi message. Success means the workflow is predictable for idle and queued messages on the latest Pi release, private by default, accessible in current stable desktop browsers, and fully covered by deterministic Node tests plus the agreed manual browser smoke checks.

## Context

- The latest Pi extension API exposes `input` image transforms, `message_start`, `agent_settled`, editor text restoration, project trust, and widgets. This package targets latest Pi only; older Pi runtime behavior is not part of its compatibility contract.
- Pi has no public API for injecting a native attachment marker into the editor. The extension will use an `🖼️` widget above the editor and attach `ImageContent[]` in the `input` hook.
- The page owns image selection and ordering; Pi remains the only prompt editor and message submission surface.
- The repository auto-discovers production workspaces for checks, version bumps, and publishing, but package-specific root scripts, `just` aliases, the lockfile, and root README lists still need updates.

## Architecture

### Package layout

- `extensions/pi-image-drop/src/image-drop.ts`: Pi entrypoint, `/image-drop`, lifecycle hooks, input orchestration, and widget projection.
- `runtime.ts`: one session-owned runtime, generation guards, browser-client lease, shutdown, and stale async protection.
- `batch.ts`: canonical in-memory draft/reservation state machine, revisions, ordering, deduplication, and recovery.
- `images.ts`: magic-byte validation, metadata sanitization, conversion, resize/encoding limits, and hashes.
- `settings.ts`: optional `pi-image-drop.json` loading and strict defaults/hard-cap validation.
- `pi-settings.ts`: documented effective `images.autoResize` / `images.blockImages` resolution from Pi settings.
- `server.ts` plus small HTTP helpers: loopback listener, bootstrap/session auth, static assets, REST uploads/mutations, and server-sent events.
- `src/web/index.html`, `app.js`, and `styles.css`: framework-free browser UI; no prompt field or attach/submit action.
- `test/*.test.ts`: Node unit/integration coverage; small format/metadata fixtures may live under `test/fixtures/` and remain outside the published `files` list.

Keep each module below the repository's 1,000-line review threshold and split responsibilities further if a module approaches it.

### State and message flow

1. `/image-drop` lazily starts an HTTP server on a random loopback port, rotates the unused bootstrap token, and shows a clickable URL without launching a browser.
2. The page authenticates once, receives an HttpOnly session cookie, redirects to a clean URL, and acquires the single active editing lease. A newly authenticated page may take over; the previous page becomes visibly stale/read-only.
3. Before concurrent uploads start, the page reserves ordered item records so Pi can distinguish `uploading`, `processing`, `ready`, and `error` from a complete batch.
4. Fully uploaded source bytes and processed provider-ready bytes remain only in the session runtime's bounded memory. Source bytes are retained until message acceptance so Retry and a changed effective auto-resize setting can be handled without disk storage.
5. A non-empty interactive input with a ready draft creates an immutable reservation and returns a transformed image list. Slash commands, shell commands, RPC prompts, and extension-generated messages do not consume the batch.
6. `message_start` for the matching user-image digest commits and clears the reservation. Latest Pi's `agent_settled` event provides the recovery boundary when a queued reservation never becomes a user message. Preflight failures must restore the text/batch through a proven bounded recovery path.
7. Once Pi records the user message, provider failures do not restore the browser batch because the images already live in Pi's session context for retry.
8. Browser refresh/disconnect preserves the draft. Pi `/reload`, session replacement/fork, or shutdown aborts requests, clears all bytes, closes the server, clears the widget, and makes old pages stale.

### Browser API and security boundary

- Bind only to loopback and reject unexpected `Host` and mutation `Origin` values; do not emit permissive CORS headers.
- Each `/image-drop` invocation invalidates the prior unused bootstrap token. A successful bootstrap sets an HttpOnly, `SameSite=Strict`, path-scoped session cookie and redirects to a token-free URL.
- Serve separate same-origin scripts/styles under a restrictive CSP; add `no-store`, `nosniff`, frame denial, and no-referrer headers.
- Upload one raw image body per item, stream at most the configured byte limit plus one, and never trust `Content-Length`, filename, extension, or browser MIME type.
- Explicitly reject SVG, HTML, remote URLs, unsupported magic bytes, pixel bombs, stale revisions, duplicate ids, and mutation attempts from stale clients.
- Use SSE for state/lease/session-invalidated updates and ordinary same-origin REST requests for item reservation, upload, retry, reorder, delete, and Clear all.

### UI hierarchy

- Header: project basename and session display name; full cwd behind a labeled Details disclosure.
- Primary area: full-page paste/drop target plus a visible file-picker button.
- Status: ready/uploading/error counts and total size, reflected in both the page and Pi widget with text rather than color alone.
- Content: ordered thumbnail grid with dimensions, source/output format, conversion/resize notes, and per-item errors.
- Item actions: drag reorder plus keyboard-operable move backward/forward and Delete controls.
- Batch action: secondary destructive Clear all with confirmation; all mutations disabled with a reason while frozen/queued.
- Privacy copy: bytes stay in the Pi process until the Pi message is recorded, then the message is sent to the configured model provider.
- Accessibility: semantic controls/status, logical focus order, visible focus, adequate targets, keyboard parity, responsive reflow, and reduced-motion-safe feedback.

## Tech Stack

- TypeScript/Node `http`, Web Crypto/Node crypto, and framework-free HTML/CSS/ES modules.
- `sharp` for bounded image processing, `heic-decode`/`libheif-js` for cross-platform HEVC-backed HEIC input that sharp's patent-safe prebuilt binaries do not decode, and `bmp-js` for BMP input omitted by sharp's prebuilt libvips.
- Pi core packages as `peerDependencies: { "*" }` per current Pi package docs and repository-pinned development dependencies for local typechecking. Runtime support targets latest Pi; source and deterministic tests must still avoid breaking the monorepo's shared CI jobs.
- Node's built-in test runner through the repository's existing compile-and-run harness; no Playwright dependency.

## Non-Goals

- Native editor attachment markers, image-only Pi messages, a browser prompt editor, persistent/recent batches, disk caches, remote image URLs, SVG/HTML, OCR, annotation, mobile/LAN upload, cloud relay, or automatic browser launch.
- Project-scoped `pi-image-drop.json` overrides.
- Full remote-environment automation; SSH, Docker, and devcontainer users receive port-forwarding guidance only.
- Publishing the package as part of implementation; package dry-run and release readiness are required, but an explicit maintainer performs first publication.

## Assumptions

- The package and config names are `@narumitw/pi-image-drop` and `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-image-drop.json`.
- Defaults are 8 images, 10 MiB per source, 40 MiB per source batch, and 50 megapixels per source. Configurable hard ceilings are 32 images, 50 MiB per source, 200 MiB per source batch, and 100 megapixels.
- Invalid or over-ceiling extension settings produce one warning and fall back as a whole to safe defaults.
- Exact duplicates are detected from deterministic sanitized-content hashes, ignored non-modally, and mapped back to the existing item.
- PNG/JPEG/WebP/GIF remain in their corresponding provider-supported format when feasible; BMP/TIFF/HEIC/AVIF normalize to PNG. Orientation is applied; EXIF/GPS/XMP/IPTC/comments are removed; ICC and GIF animation semantics are preserved where the output format supports them.
- Effective Pi `images.autoResize` defaults to true and targets Pi's 2,000 px / approximately 4.5 MB Base64 constraints. When false, unsafe inline output is rejected rather than silently resized. Effective `images.blockImages: true` and text-only models block submission and restore the draft/text.

## Resolved Unknowns

- The installed prebuilt `sharp` decodes AVIF/TIFF and preserves tested GIF/ICC semantics, but omits HEVC-backed HEIC pixel decode and BMP. The implemented, documented contract uses bounded `heic-decode` and `bmp-js` fallbacks; all eight inputs pass fixtures.
- Provider-wide aggregate limits remain provider-specific. The extension enforces per-image inline limits, warns above defaults, and documents that the accepted 32-image/200 MiB hard ceilings cannot guarantee provider acceptance.

## Plan

- [x] Scaffold `extensions/pi-image-drop/` with package metadata at shared version `0.18.0`, Pi peer/dev dependencies, `sharp`, `LICENSE`, `tsconfig.json`, source/web/test layout, and contract tests before implementation; `npm test` produced the intended TS2307 red state for the three missing source modules, and `npx npm@11.16.0 install --ignore-scripts` regenerated the lockfile with the new workspace/runtime dependency.
- [x] Prototype the latest-Pi lifecycle contract in `runtime.ts`: ordered `input` image merge, editor restoration guards, idle/steer/follow-up reservations, matching `message_start` commit, `agent_settled` recovery, and idle preflight recovery on the next command. Focused lifecycle tests pass inside the 610-test root suite (609 pass, 1 compatibility skip), and Pi `0.80.10` loaded and executed `/image-drop` through `pi -p --no-session -e ./extensions/pi-image-drop "/image-drop"` with exit 0.
- [x] Spike the format/privacy contract with generated PNG/JPEG+orientation+private GPS/WebP/GIF/BMP/TIFF/AVIF data and a tiny licensed HEVC HEIC fixture. Focused tests prove all eight inputs, orientation, EXIF/GPS removal, ICC, GIF frames/delay, deterministic bytes/hash, pixel limits, cancellation, and Base64 sizing on desktop Linux (Node 25, sharp 0.35.3). The spike found prebuilt libvips cannot decode HEVC pixels or BMP, so the contract and README now explicitly use bounded `heic-decode` and `bmp-js` fallbacks rather than an undocumented best-effort path; remaining OS evidence is tracked in the final matrix.
- [x] Implement `settings.ts` test-first with optional global-only loading, whole-file fallback on malformed/unknown/out-of-range values, defaults, hard ceilings, above-default warnings, and symlink/non-regular rejection; focused isolated-directory tests pass, including missing/valid/warned/malformed/symlink/read cases.
- [x] Implement `pi-settings.ts` test-first to resolve documented global/project `images.autoResize` and `images.blockImages` semantics only for trusted projects and re-read them at submission; focused tests pass for merge/trust, malformed fields/files, defaults, and mid-session changes.
- [x] Implement the canonical `batch.ts` state machine test-first with atomic admission/accounting, reserved order under out-of-order completion, immutable message reservations, stale revisions, Retry/Delete/Clear all, deterministic duplicate collapse, frozen mutation rejection, digest-bounded commit/recovery, and idempotent close; six focused transition/race tests pass in the root suite.
- [x] Implement `images.ts` test-first with magic-byte allowlisting, pixel limits before BMP/HEIC decode, orientation and metadata sanitization, ICC retention, PNG normalization, animated GIF preservation, deterministic hashes, two-wide processing concurrency, 2,000 px/Base64 auto-resize, and no-resize rejection. Seven focused tests pass for all eight agreed formats, corrupt/unsupported/aborted input, concurrency, dimensions, and payload bounds; HEVC HEIC and BMP use explicit pure-JS fallbacks because sharp prebuilt binaries omit them.
- [x] Implement the loopback HTTP server/auth layer test-first with random-port bind, rotating one-time bootstrap, HttpOnly/SameSite clean redirect, Host/Origin/cookie/client-lease enforcement, no CORS, CSP/security headers, raw and JSON limits, revisioned REST mutations, retry/dedup processing, SSE state/stale events, takeover, and idempotent abort-aware shutdown. Eight real ephemeral-port integration tests pass, including token replay, bad origin/host, stale clients/revisions, chunked oversize, processing failure/retry, SSE takeover, and shutdown during native work.
- [x] Build the framework-free web page against the tested API with whole-page paste/drop, visible selection, atomic multi-file reservation, authenticated thumbnails, drag and arrow reorder, duplicate focus/highlight, Retry/Delete errors, confirmed Clear all, stale/session overlays, responsive/dark/reduced-motion CSS, and privacy/context copy. Three pure state-helper tests pass. Chrome 148 on desktop Linux verified clean bootstrap, file selection, duplicate collapse/highlight, loaded previews, arrow ordering, decoder error/Retry/Delete, confirmation, semantic 44 px controls, logical focus order, 375 px reflow with no clipped content, and simulated 200% root text with no horizontal overflow; screenshots were inspected at `/tmp/pi-image-drop-narrow.png` and `/tmp/pi-image-drop-ui.png`.
- [x] Complete `image-drop.ts`/`runtime.ts` orchestration with concurrent-safe lazy server startup, rotating links shown in a widget/notification without OS launch, project/session labels, state widgets, live model/Pi-setting upload and submission guards, interactive-only merge, digest-bounded acceptance, `agent_settled`/idle recovery, generation guards, and teardown. Focused harness coverage includes idle/steer/follow-up, image-only/non-interactive bypass, preflight recovery, model/block changes, concurrent commands, session replacement, and shutdown; global Pi 0.80.10 loaded and executed `/image-drop` non-interactively with exit 0.
- [x] Run a holistic edge-case pass over the full flow. Regression coverage now proves credential-isolated simultaneous servers, stale-tab leases, interrupted-upload recovery after refresh, concurrent command startup/token rotation, concurrent order/dedup semantics, stale revisions, deletion during native processing, live setting/model guards, blockImages/text-only handling, preflight and steer/follow-up recovery, session replacement (the lifecycle used by reload/new/resume/fork), and shutdown abort. The pass found and fixed stuck interrupted uploads, late completion after deletion, decoder-error overwrites, cross-port cookie collisions, completion-order-dependent deduplication, stale browser-state rollback, draft clobbering, and changed-autoResize output; the final 655-test root suite passes (654 pass, 1 unrelated compatibility skip).
- [x] Write `extensions/pi-image-drop/README.md` in repository style with badges, install/try workflow, no-auto-open behavior, widget/page states, full codec/privacy policy, defaults/schema/ceilings, security and memory lifecycle, Pi settings, platforms/browsers, exact-port forwarding, package layout, limitations, development commands, and first-publish instructions. Paths and package commands match the manifest, recipes, dry-run pack, and Pi 0.80.10 smoke.
- [x] Integrate the package into root `pack:image-drop`, generic and named `just` pack/try/install/publish recipes, root README package/use-case/development/structure lists, workspaces, and lockfile. Shared-version discovery lists `extensions/pi-image-drop/package.json`, boundary checks pass for 18 active packages, `just --list` shows all aliases, and automated publish/version workflows need no package allowlist.
- [x] Run package and repository verification: package check passes; final root `npm run check` passes 655 tests (654 pass, 1 unrelated skip); `just pack image-drop` reports exactly 15 intended manifest/license/README/source/web files and excludes tests, fixtures, tarballs, and `node_modules`. The non-interactive harness may not launch `just try`'s TUI, so `just --dry-run try image-drop` verified the exact recipe and global Pi 0.80.10 executed the equivalent extension plus `/image-drop` in print mode with exit 0.
- [x] Browser verification was narrowed by explicit maintainer direction on 2026-07-18 to the existing Chrome DevTools connection only; do not launch or install other browsers. Chrome DevTools verified clean bootstrap, selection/upload, ordered previews, duplicate suppression, keyboard-accessible arrow controls, error/Retry/Delete state, confirmed clear, narrow reflow, and large-text overflow behavior. Cross-browser/OS matrix execution is intentionally waived for this implementation.
- [x] Verify the GitHub CI-equivalent matrix locally with npm 11.16.0: full `npm run check` passes after `set-pi-version`/install for Pi 0.79.10, pinned 0.80.3, and `latest`; manifests/lock/node_modules were restored to pinned 0.80.3 afterward. Global latest Pi 0.80.10 loads the extension and executes `/image-drop` non-interactively with exit 0; older rows remain repository gates, not advertised Image Drop targets.

## Risks

- The package intentionally requires latest Pi behavior; startup must fail clearly instead of silently degrading if a runtime lacks the required lifecycle API.
- `sharp` is a native runtime dependency with larger installs and platform-specific codecs; its prebuilt binaries omit HEVC decoding, so the HEIC fallback adds a sizeable WASM dependency and must run behind the same pixel/concurrency limits.
- Retaining source and processed bytes enables Retry and settings re-evaluation but can approach several hundred MiB at user-selected hard ceilings. Admission must be atomic, processing concurrency bounded, and memory released on every terminal transition.
- Browser and Pi mutate the same lifecycle from different event loops. Revisions, immutable reservations, and session-generation guards are required to prevent late upload completions from reviving cleared/replaced sessions.
- Reading effective Pi image settings duplicates documented merge behavior because no public effective-settings API exists; keep this adapter narrow and regression-tested.
- A plain HTTP loopback origin cannot use a universally reliable `Secure` cookie. Loopback binding, one-time bootstrap, HttpOnly/SameSite, exact Host/Origin checks, CSP, and no CORS must operate together.

## Rollback / Recovery

- Removing or disabling the package leaves no migration or persisted image state; session shutdown and `/reload` clear all in-memory bytes and close the listener.
- If advanced codec support regresses, fail affected items visibly while retaining supported formats; do not reinterpret unknown bytes or send mislabeled content.
- If latest Pi queue recovery regresses, retain the proven idle path and stop for explicit approval before narrowing busy-agent behavior.
- First npm publication remains a separate maintainer action, so implementation can be reverted before release without registry cleanup.

## Completion Checklist

- [x] Package structure, manifest/runtime dependencies, `pi-image-drop.json`, sub-1,000-line source boundaries, root integrations, and lockfile are verified by source review, final root check, 18-package boundary check, and shared-version discovery listing `extensions/pi-image-drop/package.json`.
- [x] `/image-drop` lazily shows a rotating plain clickable loopback URL in Pi without any browser-launch code; command harness tests, ephemeral token/cookie/Host/Origin/lease tests, and the Pi 0.80.10 runtime smoke verify it.
- [x] Paste/drop/file selection wiring, pre-reserved order, authenticated previews, arrow/delete controls, deterministic duplicate suppression/highlight, Retry/Delete errors, and confirmed Clear all are verified by Node helpers/server tests plus the maintainer-approved Chrome DevTools smoke.
- [x] Idle, steer, and follow-up non-empty interactive messages receive one immutable ordered batch; image-only/non-interactive input bypasses it; blocked, changed-setting, preflight, and settled recovery preserve drafts; matching message acceptance clears it. Lifecycle tests and Pi 0.80.10 smoke verify the flow.
- [x] PNG/JPEG/WebP/GIF/BMP/TIFF/HEIC/AVIF, orientation, EXIF/GPS removal, ICC, GIF frames/timing, deterministic output, pixel/Base64 bounds, auto-resize/no-resize, and changed-setting reprocessing are verified by focused fixtures on the current WSL/Linux runtime; portable codec fallbacks are documented.
- [x] Images remain memory-only; send, delete/clear, session replacement/reload/fork lifecycle, shutdown, interrupted upload, and stale native completion release canonical bytes/server/widget state. State/server/process cleanup checks found no generated image files or surviving listeners; only the checked-in 499-byte HEIC fixture exists.
- [x] Global defaults/ceilings, whole-file fallback, warnings, symlink/read cases, live Pi autoResize/blockImages, trusted-project merge, model guards, and retained-source reprocessing are verified by focused tests and README schema/examples.
- [x] Per explicit maintainer direction, browser evidence for this implementation is the completed Chrome DevTools smoke only; no other browser is to be launched or installed, and the broader browser/OS matrix is waived.
- [x] Package check, explicit ignore-independent Biome check, final root check/tests, dry-run try recipe plus latest-Pi print smoke, 15-file pack inspection, and all three CI-equivalent Pi matrix rows pass with evidence above.
