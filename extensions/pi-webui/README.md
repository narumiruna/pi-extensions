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
  "startOnSessionStart": false
}
```

| Setting | Default | Behavior |
| --- | --- | --- |
| `startOnSessionStart` | `false` | Start WebUI and display a fresh one-time link after every Pi session initialization, including startup, reload, new, resume, and fork. It never opens a browser. |

A missing file uses defaults. The file must contain a top-level JSON object, and `startOnSessionStart` must be a boolean when present. Malformed JSON or an invalid recognized value causes the file to be ignored with a warning and leaves it untouched. Unknown fields are accepted and preserved by the settings screen for forward compatibility.

Settings are reloaded on every `session_start`. Changes made in `/webui settings` are saved atomically and update the in-memory preference immediately, but they intentionally do not start or stop the server in the current session; they take effect at the next session initialization or `/reload`. `/webui init` creates formatted defaults once and refuses to overwrite valid or invalid existing content.

In print, JSON, and RPC modes, `/webui settings` does not open custom TUI or write protocol-breaking output. Use `/webui status`, `/webui help`, or edit the reported path manually.

## What synchronization means

WebUI mirrors Pi's semantic session events, not terminal pixels. It displays conversation content, streaming assistant state, tool calls/results, errors, and activity using browser-native presentation. It does not reproduce ANSI colors, terminal wrapping, footer/widgets, built-in dialogs, arbitrary custom TUI components, or unsent terminal editor text.

The initial transcript comes from the active session branch. Browser refresh does not create a second transcript or alter Pi's session tree.

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

The server checks file signatures instead of trusting browser MIME types or filename extensions. It rejects corrupt/unknown formats, more than 8 images, individual source images over 10 MiB, combined image input over 40 MiB, images over 50 megapixels, and provider-ready Base64 content over Pi's approximately 4.5 MB inline limit. Images over 2,000 pixels on either side are resized when Pi's `images.autoResize` setting is enabled and rejected when it is disabled.

Drag thumbnails or use their visible arrow controls to set provider order before sending. Processing applies image orientation, re-encodes provider-ready output, strips EXIF and other private metadata, preserves ICC color profiles and animated GIF timing where supported, and does not retain browser source bytes after the message request is accepted. Pi's effective global and trusted-project `images.autoResize` and `images.blockImages` settings plus the current model's image capability are checked at send time. BMP and HEIC use bounded portable decoders because the prebuilt `sharp`/libvips distribution does not decode those inputs consistently across supported platforms.

## Security and privacy

- The server binds only to a random `127.0.0.1` port and is owned by one live Pi session.
- A rotating bootstrap token is exchanged once for a per-server HttpOnly, `SameSite=Strict` cookie and removed from the URL.
- Every endpoint requires the cookie. Mutations also require exact Host and Origin values plus the active browser-tab lease.
- Responses use no-store, no-referrer, MIME-sniffing, frame-denial, same-origin resource, and restrictive Content Security Policy headers.
- Transcript projection retains at most the newest 500 messages and 500 tool records, event replay keeps 256 updates, and request-id records keep 128 sends. The page uses no localStorage, sessionStorage, IndexedDB, cookies of its own, or image/transcript cache.
- Tool arguments/results, paths, images, and model thinking can be sensitive. Thinking is collapsed by default; only open a link issued by a Pi process you trust.
- Reload, session replacement/fork, or Pi shutdown closes sockets, invalidates old callbacks, ends the page, and releases in-memory state.

A loopback page is local to the operating-system network namespace. WebUI does not support LAN/public binding or a cloud relay. For SSH, containers, or devcontainers, forward the exact printed port and preserve the `127.0.0.1:<port>` Host value.

## Accessibility and browsers

The page uses semantic headings, native disclosure/dialog controls, concise status/alert live regions, text labels, visible keyboard focus, at least 44 px controls, keyboard image preview/removal, `Ctrl/Command+Enter` submission, reduced-motion handling, dark mode, and responsive reflow. It targets current stable desktop Chrome, Edge, Firefox, and Safari.

## Limitations

- One active Pi session and one active browser editing tab only.
- No persistent browser transcript, sent-image history, remote access, PTY/terminal control, model/settings controls, or session switching.
- No SVG, remote image URL, OCR, annotation, or directory upload support.
- Browser acknowledgment means Pi accepted or queued the message. Provider failures follow Pi's normal session/retry behavior.
- Built-in TUI commands and dialogs are not reimplemented in the browser.

## Package layout

```text
src/webui.ts         Pi extension entrypoint
src/runtime.ts       Pi lifecycle, commands, event projection, and browser message routing
src/settings.ts      global WebUI settings validation and atomic persistence
src/conversation.ts  bounded transcript snapshot and ordered event replay
src/server.ts        authenticated loopback HTTP/SSE server
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
