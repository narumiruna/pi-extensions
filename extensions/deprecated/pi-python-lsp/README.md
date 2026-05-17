# 🐍 pi-python-lsp — ty and Ruff Language Server Tools for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-python-lsp)](https://www.npmjs.com/package/@narumitw/pi-python-lsp) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

> Deprecated: use [`@narumitw/pi-lsp`](../../pi-lsp) instead. This package is kept for reference under `extensions/deprecated/` and is no longer part of the active workspace package set.

`@narumitw/pi-python-lsp` is a native [Pi coding agent](https://pi.dev) extension that exposes Python language-server tools from [ty](https://github.com/astral-sh/ty) and [Ruff](https://docs.astral.sh/ruff/).

Use it to give Pi reliable Python type diagnostics, Ruff lint diagnostics, formatting, import organization, and source fixes through Language Server Protocol (LSP) workflows.

## ✨ Features

- Runs `ty server` on demand for Python type diagnostics.
- Runs `ruff server` on demand for lint diagnostics.
- Computes or writes Ruff formatting edits.
- Computes or writes Ruff source actions such as `source.fixAll.ruff` and `source.organizeImports.ruff`.
- Supports workspace roots, file limits, and recursive Python file discovery.
- Starts language servers only for tool calls, then shuts them down.
- Shows statusline activity only while Python LSP tools are running.
- Provides clear setup errors when ty or Ruff is missing.

## 📦 Install

```bash
pi install npm:@narumitw/pi-python-lsp
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-python-lsp
```

Try this package locally from the repository root:

```bash
pi -e ./extensions/deprecated/pi-python-lsp
```

## ✅ Requirements

Install `ty` and/or `ruff` somewhere on `PATH`, for example:

```bash
uv tool install ty
uv tool install ruff
```

Or provide custom server commands:

```bash
PI_TY_LSP_COMMAND="uvx ty server" PI_RUFF_LSP_COMMAND="uvx ruff server" pi -e ./extensions/deprecated/pi-python-lsp
```

Optional timeout overrides:

```bash
PI_TY_LSP_TIMEOUT_MS=30000 PI_RUFF_LSP_TIMEOUT_MS=30000 pi -e ./extensions/deprecated/pi-python-lsp
```

## 🛠️ Pi tools

- `ty_lsp_diagnostics` — start `ty server`, open Python files, and return type diagnostics.
- `ruff_lsp_diagnostics` — start `ruff server`, open Python files, and return lint diagnostics.
- `ruff_lsp_format` — compute or write Ruff formatting edits for one Python file.
- `ruff_lsp_fix` — compute or write Ruff source actions such as `source.fixAll.ruff` or `source.organizeImports.ruff`.

## 🚀 Examples

Check a Python project with ty or Ruff diagnostics:

```json
{
  "paths": ["src", "tests"],
  "limit": 100
}
```

Format a Python file with Ruff:

```json
{
  "path": "src/app.py",
  "write": true
}
```

Organize imports with Ruff:

```json
{
  "path": "src/app.py",
  "kind": "source.organizeImports.ruff",
  "write": true
}
```

If `paths` is omitted for diagnostics, the tool recursively discovers Python files under the workspace root, skipping common cache and virtualenv directories.

## 💬 Command

```text
/python-lsp
```

Shows the configured ty and Ruff LSP commands and whether each command is available on `PATH`.

## 🧠 Use cases

- Let Pi typecheck Python code with ty before completing a task.
- Ask Pi to run Ruff lint diagnostics while editing.
- Format Python files through a native Pi tool.
- Organize imports and apply safe Ruff fixes.
- Add Python quality gates to AI coding agent workflows.

## 🗂️ Package layout

```txt
extensions/deprecated/pi-python-lsp/
├── src/
│   └── python-lsp.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

## 🔎 Keywords

Pi extension, Pi coding agent, Python LSP, ty, Ruff, Python type checking, Python linting, Python formatter, import organization, Language Server Protocol, AI coding tools.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
