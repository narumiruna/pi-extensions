# 🧠 pi-lsp — Shared Language Server Tools for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-lsp)](https://www.npmjs.com/package/@narumitw/pi-lsp) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-lsp` is a native [Pi coding agent](https://pi.dev) extension that exposes Biome, ty, and Ruff language-server tools through one shared LSP runner Module.

It is intended to cover the current behavior of `@narumitw/pi-biome-lsp` and `@narumitw/pi-python-lsp` while keeping those older packages available and unchanged for now.

## ✨ Features

- Runs `biome lsp-proxy` on demand for diagnostics, formatting, import organization, and source fixes.
- Runs `ty server` on demand for Python type diagnostics.
- Runs `ruff server` on demand for Python lint diagnostics, formatting, import organization, and source fixes.
- Uses one internal LSP runner for JSON-RPC framing, subprocess lifecycle, diagnostics, formatting, code actions, and workspace edit application.
- Keeps Biome, ty, and Ruff behavior in small server Adapters.
- Supports workspace roots, file limits, recursive file discovery, and write-or-preview edits.
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

## ⚠️ Tool-name compatibility

This package intentionally registers the same tool names as `@narumitw/pi-biome-lsp` and `@narumitw/pi-python-lsp`:

- `biome_lsp_diagnostics`
- `biome_lsp_format`
- `biome_lsp_fix`
- `ty_lsp_diagnostics`
- `ruff_lsp_diagnostics`
- `ruff_lsp_format`
- `ruff_lsp_fix`

Avoid installing `@narumitw/pi-lsp` side by side with the older LSP packages unless you have verified how your Pi version handles duplicate tool names. The older packages are not deprecated in this phase. For the same reason, this repository's `just install-all` recipe skips `pi-lsp`; install `pi-lsp` separately when you want the shared LSP extension instead of the older split packages.

## ✅ Requirements

Install the language servers you want to use somewhere on `PATH`:

```bash
uv tool install ty
uv tool install ruff
```

For Biome, either install it globally/on `PATH`, add your project's `node_modules/.bin` to `PATH`, or point the extension at a project-local command. For example:

```bash
npm install -D @biomejs/biome
PI_BIOME_LSP_COMMAND="./node_modules/.bin/biome lsp-proxy" pi -e ./extensions/pi-lsp
```

Or provide custom server commands:

```bash
PI_BIOME_LSP_COMMAND="npx biome lsp-proxy" \
PI_TY_LSP_COMMAND="uvx ty server" \
PI_RUFF_LSP_COMMAND="uvx ruff server" \
pi -e ./extensions/pi-lsp
```

Optional timeout overrides:

```bash
PI_BIOME_LSP_TIMEOUT_MS=30000 \
PI_TY_LSP_TIMEOUT_MS=30000 \
PI_RUFF_LSP_TIMEOUT_MS=30000 \
pi -e ./extensions/pi-lsp
```

## 🛠️ Pi tools

### Biome

- `biome_lsp_diagnostics` — start `biome lsp-proxy`, open supported files, and return diagnostics.
- `biome_lsp_format` — compute or write formatting edits for one Biome-supported file.
- `biome_lsp_fix` — compute or write source actions such as `source.fixAll.biome` or `source.organizeImports.biome`.

### Python

- `ty_lsp_diagnostics` — start `ty server`, open Python files, and return type diagnostics.
- `ruff_lsp_diagnostics` — start `ruff server`, open Python files, and return lint diagnostics.
- `ruff_lsp_format` — compute or write Ruff formatting edits for one Python file.
- `ruff_lsp_fix` — compute or write Ruff source actions such as `source.fixAll.ruff` or `source.organizeImports.ruff`.

## 🚀 Examples

Check a project subset with Biome diagnostics:

```json
{
  "paths": ["src", "extensions/pi-lsp/src"],
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

Check a Python project with ty or Ruff diagnostics:

```json
{
  "paths": ["src", "tests"],
  "limit": 100
}
```

Organize Python imports with Ruff:

```json
{
  "path": "src/app.py",
  "kind": "source.organizeImports.ruff",
  "write": true
}
```

If `paths` is omitted for diagnostics, the tool recursively discovers supported files under the workspace root while skipping common generated, dependency, cache, and virtualenv directories.

## 💬 Command

```text
/lsp
```

Shows the configured Biome, ty, and Ruff LSP commands and whether each command is available on `PATH`.

## 🗂️ Package layout

```txt
extensions/pi-lsp/
├── src/
│   ├── adapters.ts
│   ├── command.ts
│   ├── files.ts
│   ├── lsp-client.ts
│   ├── pi-lsp.ts
│   ├── runner.ts
│   ├── text-edits.ts
│   └── types.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

## 🔎 Keywords

Pi extension, Pi coding agent, Language Server Protocol, Biome LSP, ty, Ruff, Python LSP, formatter, linter, import organization, AI coding tools.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
