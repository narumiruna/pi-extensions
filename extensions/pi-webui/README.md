# 🌐 pi-webui — Current-session Web Companion for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-webui)](https://www.npmjs.com/package/@narumitw/pi-webui) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-webui` adds a private, lightweight browser companion to the current terminal-owned [Pi Coding Agent](https://pi.dev) session. It displays Pi's semantic conversation and tool activity as they happen and can send text or sanitized images back into that same session.

This package is intentionally different from the broader, separately maintained `@narumitw/pi-web` application. WebUI has one current-session chat page and no session manager, shell, file browser, git UI, control room, or task board.

## Features

- Streams current-branch user and assistant messages, assistant text updates, tool activity/results, errors, and busy/idle state over Server-Sent Events.
- Renders a safe Markdown subset for headings, lists, emphasis, code, blockquotes, and HTTP(S) links without executing model-provided HTML.
- Preserves open tool/thinking disclosures during keyed streaming updates and offers **Jump to latest** when new activity arrives while you read earlier messages.
- Sends immediately while Pi is idle and automatically queues **Queue next** as a follow-up while Pi is busy.
- Provides a separate **Steer** action while Pi is working; steering is never the default submit action.
- Accepts pasted, dropped, or selected PNG, JPEG, WebP, GIF, BMP, TIFF, HEIC/HEIF, and AVIF images, strips metadata server-side, applies Pi-compatible size limits, and provides ordered thumbnails plus an enlarged preview.
- Reconnects from an ordered event cursor and replaces state from an authoritative snapshot after a gap.
- Keeps a failed browser draft and prevents rapid duplicate submission with request IDs.
- Uses no frontend framework, build step, browser storage, remote service, or automatically launched browser.

## Install

```bash
pi install npm:@narumitw/pi-webui
```

Try the working tree without installing:

```bash
pi -e ./extensions/pi-webui
# or
just try webui
```

The package targets the latest Pi release.

## Usage

1. Start Pi in a terminal and run `/webui`.
2. Open the one-time `http://127.0.0.1:<port>/bootstrap?...` link shown by Pi. The extension does not open a browser itself.
3. Continue typing in either the terminal or browser. Accepted messages from both surfaces appear in the browser transcript.
4. While Pi is idle, **Send** starts a turn immediately. While Pi is working, **Queue next** queues a follow-up. Use **Steer** only when the new instruction should reach Pi after the current tool batch.
5. Refreshing or opening the link in another tab takes the editing lease. Older tabs remain readable and clearly become read-only.

If another installed extension also registers `/webui`, Pi assigns numeric command suffixes according to extension load order. Check Pi's command provenance and invoke the WebUI entry.

## Commands

| Command | Behavior |
| --- | --- |
| `/webui` | Start or reuse the current session server and display a fresh one-time link. |
| `/webui settings` | Open the interactive settings screen in TUI mode. Other modes report the manual settings path when notifications are available. |
| `/webui status` | Show the effective startup preference and source, settings path, and whether the current session server is running. It never issues a bootstrap link. |
| `/webui help` | Show command and manual-settings help. |
| `/webui init` | Create the defaults file without overwriting existing content, then open settings in TUI mode. |

Argument completion is available for all subcommands. Bare `/webui` remains the direct browser-link action.

## Settings

WebUI has one optional, **global-only** JSON settings file:

```text
<getAgentDir()>/pi-webui.json
```

The normal default path is `~/.pi/agent/pi-webui.json`. Pi installations that use another agent directory are resolved through Pi's `getAgentDir()` API; WebUI adds no environment variable or project override.

```json
{
  "startOnSessionStart": false,
  "retainSentImages": false,
  "maxRetainedImages": 32,
  "maxRetainedBytes": 134217728,
  "maxImages": 8,
  "maxImageBytes": 10485760,
  "maxBatchBytes": 41943040,
  "maxImagePixels": 50000000
}
```

| Setting | Default | Behavior |
| --- | --- | --- |
| `startOnSessionStart` | `false` | Start WebUI and display a fresh one-time link after every Pi session initialization, including startup, reload, new, resume, and fork. It never opens a browser. |
| `retainSentImages` | `false` | Opt in to bounded, session-only retention of sanitized images after Pi accepts their browser message. |
| `maxRetainedImages` | `32` | FIFO retained-image count ceiling. Positive integers up to the hard ceiling of 128 are accepted. |
| `maxRetainedBytes` | `134217728` (128 MiB) | FIFO retained provider-ready byte ceiling. Positive integers up to the hard ceiling of 536870912 (512 MiB) are accepted. |
| `maxImages` | `8` | Images in one active draft; hard ceiling 32. |
| `maxImageBytes` | `10485760` (10 MiB) | Source bytes per image; hard ceiling 52428800 (50 MiB). Must not exceed `maxBatchBytes`. |
| `maxBatchBytes` | `41943040` (40 MiB) | Combined source/processed draft bytes; hard ceiling 209715200 (200 MiB). |
| `maxImagePixels` | `50000000` | Decoded pixels per image; hard ceiling 100000000. Animated-image frame area participates in this limit. |

A missing file uses defaults. The file must contain a top-level JSON object; recognized booleans and positive integer limits must have the documented types and remain within their hard ceilings. Malformed JSON or an invalid recognized value causes the file to be ignored with a warning and leaves it untouched. Unknown fields are accepted and preserved by the settings screen for forward compatibility. The settings screen exposes only the frequent startup toggle; there is not yet user-testing evidence that `maxImages` is adjusted often enough to justify another routine row. Retention and image-limit fields remain in Advanced JSON at the reported path.

### Advanced image limits

Omitting all four image-limit fields exactly reproduces the original 8 image / 10 MiB per image / 40 MiB batch / 50 megapixel behavior. Values are byte counts, not Base64 character counts. Raising any image limit above its safe default emits one concise session-start warning and can materially increase Pi-process memory, decoder work, and denial-of-service exposure; use the smallest value that solves the current workflow. Any non-integer, non-positive, above-ceiling, or cross-field-invalid recognized value rejects the whole file and safely restores all defaults without rewriting it. `/webui status` reports the effective limits and whether they came from defaults or the settings file.

Settings are reloaded on every `session_start`. Changes made in `/webui settings` are saved atomically and update the in-memory preference immediately, but they intentionally do not start or stop the server in the current session; they take effect at the next session initialization or `/reload`. `/webui init` creates formatted defaults once and refuses to overwrite valid or invalid existing content.

In print, JSON, and RPC modes, `/webui settings` does not open custom TUI or write protocol-breaking output. Use `/webui status`, `/webui help`, or edit the reported path manually.

## What synchronization means

WebUI mirrors Pi's semantic session events, not terminal pixels. It displays conversation content, streaming assistant state, tool calls/results, errors, and activity using browser-native presentation. It does not reproduce ANSI colors, terminal wrapping, footer/widgets, built-in dialogs, arbitrary custom TUI components, or unsent terminal editor text.

The initial transcript comes from the active session branch. Unsent browser message text and ordered attachment references are authoritative in the live Pi process, so refresh, reconnect, and active-tab takeover restore the same draft without creating a second transcript or altering Pi's session tree. Text edits are revisioned and saved with bounded, deduplicated mutations; stale or delayed responses cannot overwrite newer typing.

## Images

| Input | Provider-ready output |
| --- | --- |
| PNG | PNG |
| JPEG | JPEG |
| WebP | WebP |
| GIF, including animation | GIF |
| BMP | PNG |
| TIFF | PNG |
| HEIC/HEIF | PNG |
| AVIF | PNG |

The server checks file signatures instead of trusting browser MIME types or filename extensions. It rejects corrupt/unknown formats and applies the effective `maxImages`, `maxImageBytes`, `maxBatchBytes`, and `maxImagePixels` settings at browser admission, streamed upload, processing, draft accounting, send preflight, and Attach again. Pi's approximately 4.5 MB inline Base64 constraint and 2,000-pixel provider-ready dimension constraint remain fixed and cannot be raised in WebUI settings. Images over 2,000 pixels on either side are resized when Pi's `images.autoResize` setting is enabled and rejected when it is disabled.

Choosing, pasting, or dropping images first reserves an ordered server-side batch, uploads each source as a bounded raw request, and processes it before Send becomes available. Each thumbnail reports Uploading, Processing, Ready, or Needs attention; upload progress is shown when the browser reports a byte total. A failed item can be retried without reselecting successful siblings, and every item can be removed independently. Refreshing the active tab restores the authoritative staged batch, while another tab taking the editing lease cancels in-flight work safely.

Drag thumbnails or use their visible arrow controls to set provider order before sending. Remove images individually, or use the confirmed **Clear attachments** action when a draft contains several images. Conversion and resize summaries appear only on affected items, while the metadata-removal guarantee is stated once for the collection. Processing applies image orientation, re-encodes provider-ready output, strips EXIF and other private metadata, preserves ICC color profiles and animated GIF timing where supported, and releases each source after successful sanitation. Failed processing retains only that bounded source for Retry; Ready provider bytes remain in the Pi process until accepted send, removal, clear, lease/session teardown, or failed-send retry. Image bytes are never embedded in the message JSON protocol.

Pi's effective global and trusted-project `images.autoResize` and `images.blockImages` settings plus the current model's image capability and authentication are checked again at send time. A failed send leaves the exact Ready batch available for an idempotent retry. BMP and HEIC use bounded portable decoders because the prebuilt `sharp`/libvips distribution does not decode those inputs consistently across supported platforms.

When `retainSentImages` is enabled, only provider-ready sanitized bytes transfer into a separate session-memory store after Pi accepts the matching browser message. Content-identical sanitized images share one opaque session reference. Oldest entries are evicted first when either retention ceiling is exceeded. WebUI also reconciles retained, current-draft, and conservative in-flight processing bytes against one aggregate resident-image budget (the larger of the configured retention byte ceiling and the staging store's maximum working set), evicting sent entries before that aggregate can grow. Eligible transcript image chips offer **Attach again** and **Forget**; evicted or forgotten references read **Expired**, and terminal-origin images never gain those actions. Attach again clones the retained bytes into the current authoritative draft, reuses normal count/byte admission, and never mutates the earlier message. Refresh and active-tab takeover recover eligibility from Pi-process state; session replacement, reload, shutdown, or process exit releases all retained bytes.

## Security and privacy

- The server binds only to a random `127.0.0.1` port and is owned by one live Pi session.
- A rotating bootstrap token is exchanged once for a per-server HttpOnly, `SameSite=Strict` cookie and removed from the URL.
- Every endpoint requires the cookie. Mutations also require exact Host and Origin values plus the active browser-tab lease.
- Responses use no-store, no-referrer, MIME-sniffing, frame-denial, same-origin resource, and restrictive Content Security Policy headers.
- Transcript projection retains at most the newest 500 messages and 500 tool records, event replay keeps 256 updates, and request-id records keep 128 sends. Unsent message text, ordered attachment references, staged image bytes, and opt-in sanitized sent-image bytes live only in bounded Pi-process memory under their documented lifecycles; the page uses no localStorage, sessionStorage, IndexedDB, script-readable cookies, or image/transcript cache.
- Tool arguments/results, paths, images, and model thinking can be sensitive. Thinking is collapsed by default; only open a link issued by a Pi process you trust.
- Reload, session replacement/fork, or Pi shutdown closes sockets, invalidates old callbacks, ends the page, and releases in-memory state.

A loopback page is local to the operating-system network namespace. WebUI does not support LAN/public binding or a cloud relay. For SSH, containers, or devcontainers, forward the exact printed port and preserve the `127.0.0.1:<port>` Host value.

## Accessibility and browsers

The page uses semantic headings, native disclosure/dialog controls, concise status/alert live regions, text labels, visible keyboard focus, at least 44 px controls, keyboard image preview/removal, `Ctrl/Command+Enter` submission, reduced-motion handling, dark mode, and responsive reflow. It targets current stable desktop Chrome, Edge, Firefox, and Safari.

## Limitations

- One active Pi session and one active browser editing tab only.
- No persistent browser transcript, permanent sent-image gallery, cross-session image history, remote access, PTY/terminal control, model/settings controls, or session switching.
- No SVG, remote image URL, OCR, annotation, or directory upload support.
- Browser acknowledgment means Pi accepted or queued the message. Provider failures follow Pi's normal session/retry behavior.
- Built-in TUI commands and dialogs are not reimplemented in the browser.

## Package layout

```text
src/webui.ts         Pi extension entrypoint
src/runtime.ts       Pi lifecycle, commands, event projection, and browser message routing
src/settings.ts      global WebUI settings validation and atomic persistence
src/conversation.ts  bounded transcript snapshot and ordered event replay
src/drafts.ts        authoritative in-memory text and attachment-reference revisions
src/attachments.ts   revisioned staged-image state, processing queue, and byte ownership
src/sent-images.ts   opt-in bounded sanitized sent-image retention
src/server.ts        authenticated loopback HTTP/SSE server and raw attachment protocol
src/image-limits.ts  shared configurable defaults, ceilings, and provider constraints
src/images.ts        bounded provider-ready image processing
src/pi-settings.ts   effective Pi image settings reader
src/web/             framework-free browser page
```

## Development

From the repository root:

```bash
npm --workspace @narumitw/pi-webui run check
npm test
just try webui
just pack webui
```

The package preview must contain its manifest, license, README, TypeScript source, and static web assets, but no tests, fixtures, cache, or `node_modules`.

## Keywords

Pi extension, Pi Coding Agent, browser companion, local web chat, terminal session sync, Server-Sent Events, image prompt, tool activity, local-first AI coding agent.

## License

MIT
