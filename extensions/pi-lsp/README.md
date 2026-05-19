# 🧠 pi-lsp — Shared Language Server Tools for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-lsp)](https://www.npmjs.com/package/@narumitw/pi-lsp) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-lsp` is a native [Pi coding agent](https://pi.dev) extension that exposes Biome, ty, and Ruff language-server behavior through language/file-extension routed Pi tools.

It supersedes the older split packages `@narumitw/pi-biome-lsp` and `@narumitw/pi-python-lsp`, which now live under `extensions/deprecated/` and are excluded from active workspace scripts.

## ✨ Features

- Routes Biome-supported web/config files to `biome lsp-proxy` for diagnostics, formatting, import organization, and source fixes.
- Routes Python `.py` and `.pyi` type diagnostics to `ty server`.
- Routes Python `.py` and `.pyi` lint diagnostics, formatting, import organization, and source fixes to `ruff server`.
- Uses one internal LSP runner for JSON-RPC framing, subprocess lifecycle, diagnostics, formatting, code actions, and workspace edit application.
- Keeps Biome, ty, and Ruff behavior in small server adapters.
- Supports workspace roots, file limits, recursive file discovery, language overrides, and write-or-preview edits.
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

This package now exposes three language/file-extension routed tools instead of the old backend-specific tool names:

| Old tool | New call |
| --- | --- |
| `biome_lsp_diagnostics` | `lsp_diagnostics` with `language: "web"` when an override is needed |
| `biome_lsp_format` | `lsp_format` for a Biome-supported file |
| `biome_lsp_fix` | `lsp_fix` for a Biome-supported file |
| `ty_lsp_diagnostics` | `lsp_diagnostics` with `language: "python"`, `checker: "type"` |
| `ruff_lsp_diagnostics` | `lsp_diagnostics` with `language: "python"`, `checker: "lint"` |
| `ruff_lsp_format` | `lsp_format` for a Python file |
| `ruff_lsp_fix` | `lsp_fix` for a Python file |

Avoid installing `@narumitw/pi-lsp` side by side with the older deprecated LSP packages unless you have verified how your Pi version handles overlapping capabilities.

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

### `lsp_diagnostics`

Run diagnostics through language/file-extension routes.

Parameters:

- `paths?`: files or directories to check. Defaults to the workspace root.
- `root?`: workspace root. Defaults to cwd.
- `limit?`: maximum files to open per selected route.
- `language?`: optional override, either `"web"` for Biome-supported web/config files or `"python"` for `.py`/`.pyi` files.
- `checker?`: Python diagnostics checker, one of `"type"`, `"lint"`, or `"all"`. Defaults to `"all"`.

Routes:

- Biome-supported web/config files → Biome diagnostics.
- Python `.py`/`.pyi` + `checker: "type"` → ty diagnostics.
- Python `.py`/`.pyi` + `checker: "lint"` → Ruff diagnostics.
- Python `.py`/`.pyi` + `checker: "all"` → both ty and Ruff diagnostics.

### `lsp_format`

Format one file through the route selected from its file extension.

Parameters:

- `path`: file to format.
- `root?`: workspace root. Defaults to cwd.
- `write?`: write formatted text back to the file. Defaults to false.
- `language?`: optional route override, either `"web"` or `"python"`.

Routes:

- Biome-supported web/config files → Biome formatting.
- Python `.py`/`.pyi` files → Ruff formatting.

### `lsp_fix`

Apply source fixes or import organization through the route selected from the file extension.

Parameters:

- `path`: file to fix.
- `root?`: workspace root. Defaults to cwd.
- `kind?`: source action kind. Defaults to the routed backend's fix-all action.
- `write?`: write fixed text back to the file. Defaults to false.
- `language?`: optional route override, either `"web"` or `"python"`.

Routes:

- Biome-supported web/config files → Biome source fixes such as `source.fixAll.biome` or `source.organizeImports.biome`.
- Python `.py`/`.pyi` files → Ruff source fixes such as `source.fixAll.ruff` or `source.organizeImports.ruff`.

## 🚀 Examples

Check a mixed project subset and run all applicable diagnostics:

```json
{
  "paths": ["src", "extensions/pi-lsp/src"],
  "limit": 100
}
```

Check only Biome-supported web/config files:

```json
{
  "language": "web",
  "paths": ["extensions/pi-lsp/src"],
  "limit": 100
}
```

Check Python type diagnostics only:

```json
{
  "language": "python",
  "checker": "type",
  "paths": ["src", "tests"],
  "limit": 100
}
```

Format a TypeScript file with the inferred Biome route:

```json
{
  "path": "src/index.ts",
  "write": true
}
```

Organize Python imports with the inferred Ruff route:

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
│   ├── routes.ts
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
