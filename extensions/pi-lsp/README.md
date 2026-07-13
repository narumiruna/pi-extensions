# 🧠 pi-lsp — Configurable Language Server Tools for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-lsp)](https://www.npmjs.com/package/@narumitw/pi-lsp) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-lsp` is a native [Pi coding agent](https://pi.dev) extension that exposes diagnostics and source-fix tools through configurable Language Server Protocol routes.

The extension is language-agnostic: servers are selected by config and file extension instead of hard-coded language families.

## ✨ Features

- Configure LSP servers with simple JSON keyed by server name.
- Routes diagnostics and source fixes by configured file extensions.
- Supports multiple servers for the same extension, for example `ty` and `ruff` for `.py`/`.pyi` diagnostics.
- Uses one internal LSP runner for JSON-RPC framing, subprocess lifecycle, diagnostics, code actions, and workspace edit application.
- Supports workspace roots, file limits, recursive file discovery, server overrides, and write-or-preview edits.
- Starts language servers only for tool calls, then shuts them down.
- Shows statusline activity only while LSP tools are running.

## 📦 Install

```bash
pi install npm:@narumitw/pi-lsp
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-lsp
```

Try this package locally from the repository root:

```bash
pi -e ./extensions/pi-lsp
```

## ⚙️ Configuration

If no config is provided, pi-lsp ships compatible defaults for Biome, ty, and Ruff.

Custom config can be supplied in one of these locations:

1. `PI_LSP_CONFIG` as inline JSON or a path to a JSON file
2. `<workspace>/.pi/pi-lsp.json`
3. `~/.pi/agent/pi-lsp.json`

`PI_LSP_CONFIG` only accepts JSON or a JSON file path; JavaScript and TypeScript config files are not evaluated.

Compatibility: a user-scoped legacy `lsp.json` is migrated automatically. A project-scoped legacy `.pi/lsp.json` remains readable with a warning but is not renamed automatically, so the extension never modifies a repository working tree. New paths take precedence when both names exist.

`pi-lsp.json` can be a plain object keyed by server name:

```json
{
  "ty": {
    "command": ["ty", "server"],
    "extensions": [".py", ".pyi"]
  },
  "ruff": {
    "command": ["ruff", "server"],
    "extensions": [".py", ".pyi"]
  },
  "biome": {
    "command": ["biome", "lsp-proxy"],
    "extensions": [
      ".astro",
      ".css",
      ".graphql",
      ".gql",
      ".html",
      ".js",
      ".jsx",
      ".json",
      ".jsonc",
      ".ts",
      ".tsx",
      ".vue"
    ]
  }
}
```

Use `servers` when you need global pi-lsp options such as timeout:

```json
{
  "timeout": 30000,
  "servers": {
    "ty": {
      "command": ["ty", "server"],
      "extensions": [".py", ".pyi"],
      "env": {
        "LSP_LOG": "debug"
      },
      "initialization": {
        "settings": {}
      }
    }
  }
}
```

Each server entry supports:

- `command`: argv array used to start the LSP server.
- `extensions`: file extensions that should route to this server.
- `env`: extra environment variables for the LSP server process.
- `initialization`: LSP initialization options and workspace configuration values.

Global options:

- `timeout`: request timeout in milliseconds. Defaults to `20000`.

pi-lsp infers `languageId` from common extensions and falls back to the extension without the leading dot.

Per-server command overrides still use the normalized server name:

```bash
PI_TY_LSP_COMMAND="uvx ty server" \
PI_RUFF_LSP_COMMAND="uvx ruff server" \
pi -e ./extensions/pi-lsp
```

## ⚠️ Tool changes

`lsp_format` is no longer provided. pi-lsp now focuses on LSP diagnostics and source code actions:

- `lsp_diagnostics`
- `lsp_fix`

Use project formatters or shell commands for formatting workflows.

## 🛠️ Pi tools

### `lsp_diagnostics`

Run diagnostics through configured servers.

Parameters:

- `paths?`: files or directories to check. Defaults to the workspace root.
- `root?`: workspace root. Defaults to cwd.
- `limit?`: maximum files to open per selected server.
- `server?`: configured server name, or an array of names. Defaults to all matching servers.

### `lsp_fix`

Apply source fixes or import organization through a configured server that matches its extension. If multiple servers match, pass `server` explicitly.

Parameters:

- `path`: file to fix.
- `root?`: workspace root. Defaults to cwd.
- `kind?`: source action kind. Defaults to `source.fixAll`.
- `write?`: write fixed text back to the file. Defaults to false.
- `server?`: optional configured server name.

## 💬 Command

```text
/lsp
```

Shows configured LSP commands and whether each command is available on `PATH`.

## 🗂️ Package layout

```txt
extensions/pi-lsp/
├── src/
│   ├── adapters.ts
│   ├── command.ts
│   ├── files.ts
│   ├── lsp-client.ts
│   ├── pi-lsp.ts
│   ├── routes.ts
│   ├── runner.ts
│   ├── text-edits.ts
│   └── types.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
