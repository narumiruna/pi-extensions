# pi-python-lsp

A public [pi](https://pi.dev) extension package that exposes Python language-server tools from [ty](https://github.com/astral-sh/ty) and [Ruff](https://docs.astral.sh/ruff/).

The extension starts `ty server` or `ruff server` on demand for each tool call, opens the requested Python files over Language Server Protocol (LSP), pulls diagnostics or edits, and then shuts the server down.

## Install

```bash
pi install npm:@narumitw/pi-python-lsp
```

Try without installing:

```bash
pi -e npm:@narumitw/pi-python-lsp
```

Try this package locally from the repository root:

```bash
pi -e ./extensions/pi-python-lsp
```

## Requirements

Install `ty` and/or `ruff` somewhere on `PATH`, for example:

```bash
uv tool install ty
uv tool install ruff
```

Or provide custom server commands:

```bash
PI_TY_LSP_COMMAND="uvx ty server" PI_RUFF_LSP_COMMAND="uvx ruff server" pi -e ./extensions/pi-python-lsp
```

Optional timeout overrides:

```bash
PI_TY_LSP_TIMEOUT_MS=30000 PI_RUFF_LSP_TIMEOUT_MS=30000 pi -e ./extensions/pi-python-lsp
```

## Tools

- `ty_lsp_diagnostics` — start `ty server`, open Python files, and return type diagnostics.
- `ruff_lsp_diagnostics` — start `ruff server`, open Python files, and return lint diagnostics.
- `ruff_lsp_format` — compute or write Ruff formatting edits for one Python file.
- `ruff_lsp_fix` — compute or write Ruff source actions such as `source.fixAll.ruff` or `source.organizeImports.ruff`.

Examples:

```json
{
  "paths": ["src", "tests"],
  "limit": 100
}
```

```json
{
  "path": "src/app.py",
  "write": true
}
```

```json
{
  "path": "src/app.py",
  "kind": "source.organizeImports.ruff",
  "write": true
}
```

If `paths` is omitted for diagnostics, the tool recursively discovers Python files under the workspace root, skipping common cache and virtualenv directories.

## Command

```text
/python-lsp
```

Shows the configured ty and Ruff LSP commands and whether each command is available on `PATH`.

## Package layout

```txt
extensions/pi-python-lsp/
├── src/
│   └── python-lsp.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```
