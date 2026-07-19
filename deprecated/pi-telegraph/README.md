# 📝 pi-telegraph — Telegraph Publishing Tools for Pi Agents

[![npm](https://img.shields.io/npm/v/@narumitw/pi-telegraph)](https://www.npmjs.com/package/@narumitw/pi-telegraph) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

> Deprecated: this package is kept for reference under `deprecated/` and is no longer part of the active workspace package set.

`@narumitw/pi-telegraph` is a native [Pi coding agent](https://pi.dev) extension for creating, reading, and editing public [Telegraph](https://telegra.ph/) pages.

It accepts ergonomic Markdown or advanced Telegraph Node arrays, confirms public mutations, and keeps the Telegraph account token in a private local `pi-telegraph.json` file.

## ✨ Features

- Publish a workspace Markdown file with `/telegraph create <file.md>`, even while agent tools are disabled.
- Keep all three agent tools disabled by default, then enable any subset through config or `/telegraph tools`.
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
pi -e ./deprecated/pi-telegraph
```

## 🛠️ Pi tools

All Telegraph tools are registered but **disabled by default**. Enable an individual subset with `/telegraph tools`, enable all with `/telegraph enable`, or set the `tools` array in `pi-telegraph.json`. Tool selection preserves unrelated active Pi tools.

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

- **TUI/RPC tools:** Pi always opens a confirmation dialog. A cancellation returns a non-error cancelled result and sends no Telegraph request.
- **Print/JSON tools:** the tool call must include `"confirmed": true`. The model is instructed to set it only after the user explicitly requests publication or editing.
- **File command:** `/telegraph create <file>` requires interactive UI and always confirms before account registration or page creation.
- **Get:** reading is public and non-mutating, so it requires no confirmation.

Do not retry a create/edit call after the user cancels it.

## ⚙️ Configuration

Run:

```text
/telegraph init
```

The command interactively stores only non-secret defaults: `shortName`, `authorName`, and `authorUrl`. It preserves an existing token and never prompts for or displays secrets.

Tool controls, status, and help:

```text
/telegraph
/telegraph status
/telegraph tools
/telegraph enable
/telegraph disable
/telegraph help
```

`/telegraph tools` opens an interactive selector for individual tools plus enable-all and disable-all actions. Every accepted change applies immediately and is persisted atomically.

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
  "accessToken": "optional-existing-or-generated-token",
  "tools": [],
  "allowFilesOutsideWorkspace": false
}
```

- `shortName` is required by Telegraph account creation and defaults to `pi-telegraph`.
- `authorName` and `authorUrl` are optional page defaults.
- `accessToken` is optional. The first confirmed create call generates and saves one when absent.
- `tools` accepts a duplicate-free subset of `telegraph_create_page`, `telegraph_get_page`, and `telegraph_edit_page`. Missing `tools` defaults to `[]`, so existing configs without this field disable all Telegraph tools after reload.
- `allowFilesOutsideWorkspace` defaults to `false`. Set it to `true` only when `/telegraph create` must read an absolute, parent-relative, or outside-symlink path.
- To import an existing account, edit the private file and add its literal token.
- Telegraph-specific environment variables and command/interpolation token syntax are intentionally unsupported.
- The extension enforces regular-file storage and mode `0600`, uses atomic writes, and rejects symlink credential paths.
- Status, tool results, and errors never display the access token or Telegraph authorization URL.

Deleting the config does **not** delete published pages or revoke the account. Keep a backup if you need to edit those pages later.

## 📄 Publish a Markdown file

Publish a local file without enabling any agent tool:

```text
/telegraph create docs/article.md
/telegraph create "docs/article with spaces.markdown"
```

The command accepts regular `.md` and `.markdown` files case-insensitively, up to 256 KiB. It removes YAML frontmatter from the published body and chooses the page title in this order:

1. a non-empty string `title` in YAML frontmatter;
2. plain text from the first `# H1` (the H1 remains in the body);
3. the filename basename without its extension.

If frontmatter explicitly contains `title`, it must be a non-empty string; invalid values fail instead of falling back. Other frontmatter fields are ignored for publication.

Example:

```markdown
---
title: Telegraph article title
category: ignored-by-telegraph
---

# This heading remains in the page body

Public article content.
```

By default, paths are resolved from Pi's current workspace. Absolute paths, `..` traversal, and symlinks resolving outside the real workspace are rejected. Internal symlinks are accepted. Setting `allowFilesOutsideWorkspace` to `true` explicitly opens outside paths, but regular-file, extension, size, content, and confirmation checks still apply.

## 🧾 Content support

Markdown conversion maps supported structure directly from `marked` tokens to Telegraph nodes—HTML is never rendered and reparsed.

Supported Markdown includes paragraphs, headings, bold/emphasis/strike, links, images, blockquotes, code, preformatted blocks, line breaks, horizontal rules, and ordered/unordered/task lists. Tables become preformatted plain text because Telegraph has no table node. Raw Markdown HTML is published as literal text.

Advanced raw nodes are limited to Telegraph's documented tags and `href`/`src` attributes. The extension rejects malformed objects, unsafe URL schemes, cycles, excessive nesting, empty content, and serialized content over Telegraph's 64 KB limit.

## 🗂️ Package layout

```txt
deprecated/pi-telegraph/
├── src/
│   ├── telegraph.ts  # Pi entrypoint, tool controls, and file command
│   ├── tools.ts      # Create, get, edit, and shared create execution
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
