# 🧬 pi-biome-lsp — Biome Language Server Tools for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-biome-lsp)](https://www.npmjs.com/package/@narumitw/pi-biome-lsp) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-biome-lsp` is a native [Pi coding agent](https://pi.dev) extension that exposes [Biome](https://biomejs.dev/) language-server tools.

Use it to give Pi Biome diagnostics, formatting, import organization, and safe source fixes through Language Server Protocol (LSP) workflows.

## ✨ Features

- Runs `biome lsp-proxy` on demand for diagnostics.
- Computes or writes formatting edits for Biome-supported files.
- Computes or writes Biome source actions such as `source.fixAll.biome` and `source.organizeImports.biome`.
- Supports workspace roots, file limits, and recursive file discovery.
- Starts the language server only for tool calls, then shuts it down.
- Provides clear setup errors when Biome is missing.

## 📦 Install

```bash
pi install npm:@narumitw/pi-biome-lsp
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-biome-lsp
```

Try this package locally from the repository root:

```bash
pi -e ./extensions/pi-biome-lsp
```

## ✅ Requirements

Install Biome somewhere on `PATH`, for example:

```bash
npm install -D @biomejs/biome
```

Or provide a custom server command:

```bash
PI_BIOME_LSP_COMMAND="npx biome lsp-proxy" pi -e ./extensions/pi-biome-lsp
```

Optional timeout override:

```bash
PI_BIOME_LSP_TIMEOUT_MS=30000 pi -e ./extensions/pi-biome-lsp
```

## 🛠️ Pi tools

- `biome_lsp_diagnostics` — start `biome lsp-proxy`, open supported files, and return diagnostics.
- `biome_lsp_format` — compute or write formatting edits for one file.
- `biome_lsp_fix` — compute or write source actions such as `source.fixAll.biome` or `source.organizeImports.biome`.

## 🚀 Examples

Check a project subset with Biome diagnostics:

```json
{
  "paths": ["src", "extensions/pi-biome-lsp/src"],
  "limit": 100
}
```

Format a TypeScript file with Biome:

```json
{
  "path": "src/index.ts",
  "write": true
}
```

Organize imports with Biome:

```json
{
  "path": "src/index.ts",
  "kind": "source.organizeImports.biome",
  "write": true
}
```

If `paths` is omitted for diagnostics, the tool recursively discovers Biome-supported files under the workspace root, skipping common generated and dependency directories.

## 💬 Command

```text
/biome-lsp
```

Shows the configured Biome LSP command and whether it is available on `PATH`.

## 🗂️ Package layout

```txt
extensions/pi-biome-lsp/
├── src/
│   └── biome-lsp.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

## 🔎 Keywords

Pi extension, Pi coding agent, Biome LSP, Biome formatter, Biome linter, import organization, Language Server Protocol, AI coding tools.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
