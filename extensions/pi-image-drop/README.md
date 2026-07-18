# 🖼️ pi-image-drop — Browser Image Staging for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-image-drop)](https://www.npmjs.com/package/@narumitw/pi-image-drop) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-image-drop` adds one `/image-drop` command to the latest [Pi Coding Agent](https://pi.dev). It serves a private loopback page where you can paste, drop, choose, preview, reorder, retry, and remove local images. The ordered batch is attached to your next non-empty interactive Pi message.

The page never contains a prompt or Attach button: Pi remains the only place where messages are written and sent.

## Install

```bash
pi install npm:@narumitw/pi-image-drop
```

Try the working tree without installing:

```bash
pi -e ./extensions/pi-image-drop
# or
just try image-drop
```

This package targets the latest Pi release and uses its `agent_settled` lifecycle event. Older Pi releases are not supported.

## Workflow

1. Run `/image-drop` in an interactive Pi session. You can instead set `startOnSessionStart: true` to start the service with every Pi session.
2. Pi prints and displays a clickable one-time `http://127.0.0.1:<port>/...` link. The extension does **not** open a browser, including when session startup is enabled.
3. Open the link. Paste images anywhere, drop files, or select **Choose images**.
4. Review previews and processing details. Drag to reorder, use the keyboard-accessible arrow buttons, retry failures, delete individual items, or use confirmed **Clear all**.
5. Write and submit a non-empty message in Pi. The ready images are appended after any attachments already on that message, in browser order.

The `🖼️` widget above Pi's editor reports ready, uploading, error, and queued counts. Uploading or failed items block the whole batch and preserve the Pi editor text. Image-only messages are not supported.

By default, the loopback service starts lazily when you run `/image-drop`. With `startOnSessionStart: true`, it starts after each Pi session initializes and displays the link in Pi automatically. Each later `/image-drop` invocation reuses the service and rotates the unused one-time link. A browser refresh keeps the current in-memory batch. Opening the authenticated page in another tab gives the new tab the editing lease and makes the old tab stale.

## Supported images

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

Detection uses file signatures, not filenames or browser MIME types. SVG, HTML, remote URLs, unknown formats, corrupt files, and images over the configured pixel limit are rejected.

The processor applies orientation and removes EXIF (including GPS), XMP, IPTC, comments, and other sensitive metadata. It retains an ICC color profile and animated GIF timing where the output format supports them. With Pi's `images.autoResize` enabled (the default), output is reduced to fit Pi's 2,000-pixel and approximately 4.5 MiB Base64 inline limits. With it disabled, output that exceeds either limit fails visibly instead of being resized.

## Configuration

Image Drop has one optional **global-only** JSON file:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-image-drop.json
```

Example:

```json
{
  "startOnSessionStart": true,
  "maxImages": 8,
  "maxImageBytes": 10485760,
  "maxBatchBytes": 41943040,
  "maxImagePixels": 50000000
}
```

| Setting | Default | Behavior |
| --- | --- | --- |
| `startOnSessionStart` | `false` | Start the loopback service and display a link after each Pi session initializes. This never opens a browser. |

| Limit setting | Safe default | Hard ceiling |
| --- | ---: | ---: |
| `maxImages` | 8 | 32 |
| `maxImageBytes` | 10 MiB | 50 MiB |
| `maxBatchBytes` | 40 MiB | 200 MiB |
| `maxImagePixels` | 50 megapixels | 100 megapixels |

Limit values are positive integer counts/bytes/pixels, and `startOnSessionStart` must be a boolean. `maxImageBytes` cannot exceed `maxBatchBytes`. Unknown fields, malformed JSON, invalid values, symlinks, or values above a hard ceiling cause the **whole file** to be ignored with one warning and safe defaults to be used. Limit values above a safe default but within a hard ceiling produce a memory/provider-limit warning.

At upload and submission time, the extension also re-reads Pi's documented global and trusted-project `images.autoResize` and `images.blockImages` settings. `blockImages: true` or a text-only current model blocks processing/submission without discarding the draft.

## Security and privacy

- The HTTP listener binds only to a random `127.0.0.1` port.
- A rotating bootstrap token is exchanged once for an HttpOnly, `SameSite=Strict` session cookie, then removed from the URL.
- Exact Host, mutation Origin, session-cookie, and active-client checks are enforced. No permissive CORS headers are sent.
- Pages use a restrictive Content Security Policy plus no-store, no-referrer, MIME-sniffing, and frame-denial headers.
- Raw request bodies, decoded pixels, source bytes, previews, and provider-ready bytes are bounded and stay in the Pi process memory. The extension creates no image cache or temporary image files.
- Bytes are released after Pi records the matching user message, after Delete/Clear all, and on reload, session replacement/fork, or shutdown. Once Pi records a message, normal Pi/provider retention rules apply.

A loopback page is local to your operating-system network namespace. Do not expose the port to a LAN or public interface.

## Platforms, browsers, and remote environments

The supported local targets are current macOS, Windows, desktop Linux, and WSL with current stable Chrome, Edge, Firefox, or Safari where those browsers are available. Native `sharp` packages are installed for the current platform; HEVC-backed HEIC and BMP use bounded portable decoders because the patent-safe prebuilt `sharp`/libvips bundle omits them.

WSL normally forwards loopback to Windows automatically; always use the printed `127.0.0.1` URL rather than changing it to `localhost`. For SSH, a container, or a devcontainer, forward the exact printed port and preserve the Host value. If Pi prints port `45678`, for example:

```bash
ssh -L 45678:127.0.0.1:45678 user@remote-host
```

Then open the unchanged `http://127.0.0.1:45678/...` link locally. Image Drop does not provide a cloud relay or remote upload endpoint.

## Limitations

- Only `/image-drop` is registered; there is no `/image-drop clear` command.
- A non-empty interactive Pi message is required. RPC, extension-generated, slash-command, and image-only inputs do not consume the batch.
- All items must be ready. One uploading or failed item blocks submission until it is retried or deleted.
- Provider aggregate request limits vary. Raising the defaults to the hard ceilings does not guarantee that a provider accepts the final multi-image request.
- Batches are intentionally not persisted or shown as recent history.

## Package layout

```text
src/image-drop.ts       Pi extension entrypoint
src/runtime.ts          Pi lifecycle and message orchestration
src/batch.ts            in-memory batch state machine
src/images.ts           bounded image processing
src/server.ts           authenticated loopback HTTP/SSE server
src/settings.ts         extension settings
src/pi-settings.ts      effective Pi image settings adapter
src/web/                framework-free browser page
```

## Development

From the repository root:

```bash
npm --workspace @narumitw/pi-image-drop run check
npm test
just try image-drop
just pack image-drop
```

The dry-run package must contain the manifest, license, README, TypeScript sources, and static web assets, but no tests, fixtures, image bytes, or `node_modules`.

## Publishing

The first publication is intentionally a maintainer action:

```bash
npm publish --workspace @narumitw/pi-image-drop --access public
```

`just npm-public` only changes visibility after a scoped package already exists. Do not publish from an implementation or verification run.
