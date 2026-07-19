# 🌐 pi-webui — Current-session Web Companion for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-webui)](https://www.npmjs.com/package/@narumitw/pi-webui) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-webui` adds a private, lightweight browser companion to the current terminal-owned [Pi Coding Agent](https://pi.dev) session. It displays Pi's semantic conversation and tool activity as they happen and can send text or sanitized images back into that same session.

This package is intentionally different from the broader, separately maintained `@narumitw/pi-web` application. WebUI has one current-session chat page and no session manager, shell, file browser, git UI, control room, or task board.

## Features

- Streams current-branch user and assistant messages, assistant text updates, tool activity/results, errors, and busy/idle state over Server-Sent Events.
- Sends immediately while Pi is idle and automatically queues **Send next** as a follow-up while Pi is busy.
- Provides a separate **Steer now** action while Pi is working; steering is never the default submit action.
- Accepts pasted, dropped, or selected PNG, JPEG, WebP, and GIF images, strips metadata server-side, and applies Pi-compatible size limits.
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
4. While Pi is idle, **Send now** starts a turn immediately. While Pi is working, **Send next** queues a follow-up. Use **Steer now** only when the new instruction should reach Pi after the current tool batch.
5. Refreshing or opening the link in another tab takes the editing lease. Older tabs remain readable and clearly become read-only.

If another installed extension also registers `/webui`, Pi assigns numeric command suffixes according to extension load order. Check Pi's command provenance and invoke the WebUI entry.

## What synchronization means

WebUI mirrors Pi's semantic session events, not terminal pixels. It displays conversation content, streaming assistant state, tool calls/results, errors, and activity using browser-native presentation. It does not reproduce ANSI colors, terminal wrapping, footer/widgets, built-in dialogs, arbitrary custom TUI components, or unsent terminal editor text.

The initial transcript comes from the active session branch. Browser refresh does not create a second transcript or alter Pi's session tree.

## Images

| Input | Provider-ready output |
| --- | --- |
| PNG | PNG |
| JPEG | JPEG |
| WebP | WebP |
| GIF | GIF |

The server checks file signatures instead of trusting browser MIME types. It rejects corrupt/unknown formats, more than 8 images, individual source images over 10 MiB, combined image input over 40 MiB, images over 50 megapixels, and provider-ready Base64 content over Pi's approximately 4.5 MB inline limit. Images over 2,000 pixels on either side are resized when Pi's `images.autoResize` setting is enabled and rejected when it is disabled.

Processing re-encodes images with `sharp`, strips EXIF and other metadata, and does not retain browser source bytes after the message request is accepted. Pi's effective global and trusted-project `images.autoResize` and `images.blockImages` settings plus the current model's image capability are checked at send time.

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

The page uses semantic headings, native disclosure controls, status/alert live regions, text labels, visible keyboard focus, at least 44 px controls, keyboard image removal, `Ctrl/Command+Enter` submission, reduced-motion handling, dark mode, and responsive reflow. It targets current stable desktop Chrome, Edge, Firefox, and Safari.

## Limitations

- One active Pi session and one active browser editing tab only.
- No persistent browser transcript, sent-image history, remote access, PTY/terminal control, model/settings controls, or session switching.
- No SVG, HEIC/HEIF, TIFF, BMP, AVIF, remote image URL, OCR, annotation, or directory upload support.
- Browser acknowledgment means Pi accepted or queued the message. Provider failures follow Pi's normal session/retry behavior.
- Built-in TUI commands and dialogs are not reimplemented in the browser.

## Package layout

```text
src/webui.ts       Pi extension entrypoint
src/runtime.ts        Pi lifecycle, event projection, and browser message routing
src/conversation.ts   bounded transcript snapshot and ordered event replay
src/server.ts         authenticated loopback HTTP/SSE server
src/images.ts         bounded provider-ready image processing
src/pi-settings.ts    effective Pi image settings reader
src/web/              framework-free browser page
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
