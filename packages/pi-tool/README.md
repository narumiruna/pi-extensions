# 🧰 pi-tool — Browse Pi Tools and Track Active Tools

[![npm](https://img.shields.io/npm/v/@narumitw/pi-tool)](https://www.npmjs.com/package/@narumitw/pi-tool) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Pi Tool lets you browse every tool configured in the current Pi session and optionally show active tool names above the editor.

## ✨ Features

- Lists built-in, SDK-provided, and extension-provided tools in one searchable catalog.
- Shows active state, description, source, scope, origin, path, and optional base directory.
- Displays the complete JSON parameter schema and prompt guidelines exposed by Pi.
- Shows the effective system-prompt snippet for each active tool.
- Refreshes metadata every time the catalog opens.
- Optionally shows the current active tools above the editor, with the widget off by default.
- Persists widget changes in the extension-owned `pi-tool.json` settings file.
- Never enables, disables, or executes Pi tools.

## 📦 Install

Install persistently from npm:

```bash
pi install npm:@narumitw/pi-tool
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-tool
```

Build and try this package from a local checkout:

```bash
npm --workspace @narumitw/pi-tool run build
pi -e ./packages/pi-tool
```

An unbuilt local checkout must be built before Pi loads the package directory.

Extensions run with the same permissions as Pi, so install only packages from sources you trust.

## 🚀 Quick start

Run:

```text
/tool
```

- Choose **Browse tools** to search the catalog and inspect a tool.
- Choose **Active tool status** to turn the widget on or off.

The widget remains off until you enable it.
The command works in TUI and RPC modes.
It rejects arguments, print mode, and JSON mode before opening an interactive flow.

## 💬 Commands

Run `/tool` to browse configured tools and configure the active-tool widget in TUI or RPC mode.
It accepts no arguments and rejects print and JSON modes.
The command never enables, disables, or executes tools.

## ⚙️ Settings

The user settings file is `<getAgentDir()>/pi-tool.json`, normally `~/.pi/agent/pi-tool.json`.
The extension does not create the file while the widget remains at its default.

Use this document to enable the widget manually:

```json
{
  "activeToolStatus": true
}
```

`activeToolStatus` accepts `true` or `false` and defaults to `false` when absent.
Manual edits apply after `/reload` or the next session start.
The `/tool` menu toggle applies changes immediately and persists them through atomic file replacement.
Settings writes preserve unknown fields.
Malformed JSON, invalid values, symbolic links, and non-file settings paths are treated as invalid and remain unchanged.
Pi shows a warning when UI is available.
Writes are ordered within one Pi process, but separate Pi processes do not share a settings lock.

## ℹ️ Active-tool widget

When enabled, the widget shows every name returned by Pi's public `pi.getActiveTools()` API above the editor.
It refreshes on relevant lifecycle events and polls for changes made by other extensions.
It clears immediately when disabled or when the session is replaced, reloaded, or shut down.
Tool names are sanitized and bounded before terminal rendering.

## 🔒 Security and privacy

The catalog reads Pi's public tool metadata and displays it through the `/tool` interface.
It does not execute tools, change the active tool set, make network requests, or add catalog data to model context.
Tool metadata can include local paths and prompt text, so review the screen before sharing terminal output.

## 🚧 Limitations

The catalog shows the name, description, parameter schema, prompt guidelines, and source metadata returned by Pi's public `pi.getAllTools()` API.
It adds effective snippets from `ctx.getSystemPromptOptions()` for the current active tool set.
Pi does not expose an inactive tool's configured snippet, implementation, runtime secrets, or label through these APIs.
Therefore, **None in the current system prompt** does not prove that an inactive tool's full definition has no snippet.

## 🗂️ Package layout

```text
packages/pi-tool/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   └── tool.ts                        # Tool catalog, settings, and lifecycle
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi extension, Pi coding agent, tool browser, active tools, tool status, tool catalog, tool schema, TypeScript Pi package.

## 📄 License

[MIT](./LICENSE)
