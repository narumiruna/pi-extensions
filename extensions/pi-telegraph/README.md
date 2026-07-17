# 📝 pi-telegraph — Telegraph Publishing Tools for Pi Agents

[![npm](https://img.shields.io/npm/v/@narumitw/pi-telegraph)](https://www.npmjs.com/package/@narumitw/pi-telegraph) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-telegraph` is a native [Pi coding agent](https://pi.dev) extension for creating, reading, and editing public [Telegraph](https://telegra.ph/) pages.

It accepts ergonomic Markdown or advanced Telegraph Node arrays, confirms public mutations, and keeps the Telegraph account token in a private local `pi-telegraph.json` file.

## ✨ Features

- Publish Markdown as a public Telegraph page.
- Publish validated raw Telegraph Node arrays for exact content control.
- Read a page as Markdown or raw node JSON without credentials.
- Apply partial edits while preserving every omitted title, content, and author field.
- Lazily create one Telegraph account on the first confirmed publication.
- Import an existing account through the private config file.
- Confirm every create/edit operation in TUI and RPC modes.
- Require explicit `confirmed: true` for headless print/JSON mutations.
- Bound requests, forward cancellation, redact access tokens, and never retry mutations.
- Truncate large page reads to Pi's output limits and keep the complete result in a private temporary file until session shutdown.
- Show statusline activity only while a Telegraph API operation is running.

> [!WARNING]
> Telegraph pages are public immediately. Telegraph provides no page deletion API. Review content carefully before confirming publication.

## 📦 Install

```bash
pi install npm:@narumitw/pi-telegraph
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-telegraph
```

Try this package locally from the repository root:

```bash
pi -e ./extensions/pi-telegraph
```

## 🛠️ Pi tools

### `telegraph_create_page`

Creates and immediately publishes a page.

- Required: `title` and exactly one of `markdown` or `nodes`.
- Optional: `authorName`, `authorUrl`, and `confirmed`.
- Uses author defaults from `pi-telegraph.json` when overrides are omitted.
- Creates and privately stores a Telegraph account token when one is not configured.

Markdown example:

```json
{
  "title": "Pi Telegraph Example",
  "markdown": "## Hello\n\nPublished from **Pi**."
}
```

Raw-node example:

```json
{
  "title": "Structured Telegraph Example",
  "nodes": [
    {
      "tag": "p",
      "children": [
        "Published with ",
        { "tag": "strong", "children": ["Telegraph nodes"] },
        "."
      ]
    }
  ]
}
```

### `telegraph_get_page`

Reads a public page without an access token.

```json
{
  "path": "https://telegra.ph/Sample-Page-12-15"
}
```

Markdown is returned by default. Set `rawNodes: true` to return page metadata and content as JSON:

```json
{
  "path": "Sample-Page-12-15",
  "rawNodes": true
}
```

### `telegraph_edit_page`

Edits an existing page owned by the configured account.

Provide a path plus at least one replacement field: `title`, `markdown`, `nodes`, `authorName`, or `authorUrl`. The extension fetches the existing page first and preserves omitted values.

```json
{
  "path": "Sample-Page-12-15",
  "markdown": "Updated body; the existing title and author are preserved."
}
```

Editing requires the page owner's `accessToken` in `pi-telegraph.json`. The extension never creates a new account when an edit token is missing, because a new account cannot edit an existing page.

## ✅ Publication confirmation

Create and edit are public external mutations:

- **TUI/RPC:** Pi always opens a confirmation dialog. A cancellation returns a non-error cancelled result and sends no Telegraph request.
- **Print/JSON:** the tool call must include `"confirmed": true`. The model is instructed to set it only after the user explicitly requests publication or editing.
- **Get:** reading is public and non-mutating, so it requires no confirmation.

Do not retry a create/edit call after the user cancels it.

## ⚙️ Configuration

Run:

```text
/telegraph init
```

The command interactively stores only non-secret defaults: `shortName`, `authorName`, and `authorUrl`. It preserves an existing token and never prompts for or displays secrets.

Config status and help:

```text
/telegraph
/telegraph status
/telegraph help
```

The canonical config path is:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-telegraph.json
```

Example:

```json
{
  "shortName": "pi-telegraph",
  "authorName": "Optional default author",
  "authorUrl": "https://example.com",
  "accessToken": "optional-existing-or-generated-token"
}
```

- `shortName` is required by Telegraph account creation and defaults to `pi-telegraph`.
- `authorName` and `authorUrl` are optional page defaults.
- `accessToken` is optional. The first confirmed create call generates and saves one when absent.
- To import an existing account, edit the private file and add its literal token.
- Telegraph-specific environment variables and command/interpolation token syntax are intentionally unsupported.
- The extension enforces regular-file storage and mode `0600`, uses atomic writes, and rejects symlink credential paths.
- Status, tool results, and errors never display the access token or Telegraph authorization URL.

Deleting the config does **not** delete published pages or revoke the account. Keep a backup if you need to edit those pages later.

## 🧾 Content support

Markdown conversion maps supported structure directly from `marked` tokens to Telegraph nodes—HTML is never rendered and reparsed.

Supported Markdown includes paragraphs, headings, bold/emphasis/strike, links, images, blockquotes, code, preformatted blocks, line breaks, horizontal rules, and ordered/unordered/task lists. Tables become preformatted plain text because Telegraph has no table node. Raw Markdown HTML is published as literal text.

Advanced raw nodes are limited to Telegraph's documented tags and `href`/`src` attributes. The extension rejects malformed objects, unsafe URL schemes, cycles, excessive nesting, empty content, and serialized content over Telegraph's 64 KB limit.

## 🗂️ Package layout

```txt
extensions/pi-telegraph/
├── src/
│   ├── telegraph.ts  # Pi entrypoint and /telegraph command
│   ├── tools.ts      # Create, get, and edit tools
│   ├── content.ts    # Markdown/node conversion and validation
│   ├── client.ts     # Bounded Telegraph API client
│   ├── config.ts     # Private config and lock handling
│   ├── account.ts    # Lazy account resolution
│   └── outputs.ts    # Private truncated-output files
├── test/
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

Only `telegraph.ts` is a Pi entrypoint; the other source modules are package internals.

## 🔎 Keywords

Pi extension, Pi coding agent, Telegraph, telegra.ph, public publishing, Markdown publishing, Telegraph API, AI publishing agent, TypeScript Pi tools.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
